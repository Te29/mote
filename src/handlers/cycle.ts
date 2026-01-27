// =============================================================================
// CYCLE HANDLERS
// =============================================================================
// Handles CYCLE_START and CYCLE_END states in the agent state machine.

import type {
  AgentState,
  AgentStateCycleStart,
  AgentStateCycleEnd,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import { createTimestamp, getCurrentCycleIndex, getProgress } from '../types/session.js';
import { shouldIntervene, requestIntervention, processInterventionControl, checkInterrupt } from '../interaction.js';
import { logVariable } from '../utils/debug.js';
import { think } from '../reason.js';

// -----------------------------------------------------------------------------
// CYCLE START
// -----------------------------------------------------------------------------

/**
 * Handle the CYCLE_START state.
 * Resets per-cycle metrics and transitions to OBSERVE.
 */
export async function handleCycleStart(
  state: AgentStateCycleStart,
  ctx: AgentContext,
): Promise<AgentState> {
  const { cycleIndex } = state;

  // Reset per-cycle intervention metrics
  ctx.interventionMetrics.replanCount = 0;
  ctx.interventionMetrics.reobserveCount = 0;

  // CYCLE_START Intervention
  if (shouldIntervene(ctx.engagementMode, 'CYCLE_START')) {
    const response = await requestIntervention('CYCLE_START', {
      plan: ctx.tracker,
      cycleIndex,
    });
    
    logVariable('INTERVENTION RESPONSE (CYCLE_START)', {
      responseType: response.type,
      cycleIndex,
    });

    // Use centralized control logic
    const control = processInterventionControl(response);

    if (control.action === 'terminate') {
      return {
        phase: 'TERMINATED',
        success: false,
        message: control.reason,
      };
    }

    if (control.action === 'succeed') {
      return {
        phase: 'TERMINATED',
        success: true,
        message: control.message || 'Forced success at cycle start',
      };
    }

    if (control.action === 'skip') {
      // Mark cycle as complete and move to next
      ctx.tracker.cycles[cycleIndex].isCompleted = true;
      const nextCycleIndex = getCurrentCycleIndex(ctx.tracker);
      if (nextCycleIndex >= 0) {
        return { phase: 'OBSERVE', cycleIndex: nextCycleIndex };
      }
      return {
        phase: 'TERMINATED',
        success: true,
        message: 'All cycles skipped',
      };
    }
    
    // Default: Continue to observe
  }

  // Handle simple interrupt if not intervening fully
  if (!shouldIntervene(ctx.engagementMode, 'CYCLE_START') && checkInterrupt()) {
    // Basic interrupt logic handled in OBSERVE usually, but good to check here too
    // But since we transition immediately to OBSERVE, let OBSERVE handle it.
  }

  // Navigation to cycleStartUrl if defined (e.g. reset for next task)
  if (ctx.tracker.cycleStartUrl) {
    console.log(`🌐 Resetting to cycle start URL: ${ctx.tracker.cycleStartUrl}`);
    try {
      await ctx.services.browser.navigateTo(ctx.runtime.activePage, ctx.tracker.cycleStartUrl);
    } catch (error) {
       console.error('⚠️ Failed to navigate to cycle start URL:', error);
       // continue anyway, maybe we can recover
    }
  }

  // Transition to OBSERVE
  return {
    phase: 'OBSERVE',
    cycleIndex: state.cycleIndex,
  };
}

// -----------------------------------------------------------------------------
// CYCLE END
// -----------------------------------------------------------------------------

/**
 * Handle the CYCLE_END state.
 * Marks the current cycle as completed and determines next state.
 */
export async function handleCycleEnd(
  state: AgentStateCycleEnd,
  ctx: AgentContext,
): Promise<AgentState> {
  const cycle = ctx.tracker.cycles[state.cycleIndex];

  if (cycle) {
    cycle.isCompleted = true;
    ctx.tracker.lastUpdatedAt = createTimestamp();
  }

  // If this cycle failed, terminate
  if (state.result === 'FAILURE') {
    return {
      phase: 'TERMINATED',
      success: false,
      message: state.detail || 'Cycle failed',
    };
  }

  // Check if there are more cycles
  const nextCycleIndex = getCurrentCycleIndex(ctx.tracker);

  // TERMINAL Intervention
  // If no more cycles OR failure, we are at a terminal state
  const isTerminal = nextCycleIndex === -1 || (state.result as string) === 'FAILURE';
  
  if (isTerminal && shouldIntervene(ctx.engagementMode, 'TERMINAL')) {
    const thinkResult = state.result === 'SUCCESS' 
       ? { type: 'GOAL_SUCCESS', finalAnswer: state.detail || 'Success' } as const
       : { type: 'FAIL', error: state.detail || 'Failure' } as const;

    const response = await requestIntervention('TERMINAL', {
      plan: ctx.tracker,
      thinkResult,
      cycleIndex: state.cycleIndex,
      pageState: ctx.runtime.lastPageState || undefined,
    });
    
    logVariable('INTERVENTION RESPONSE (TERMINAL)', {
      responseType: response.type,
      result: state.result
    });

    // Progress update
    console.log(`Progress: ${getProgress(ctx.tracker)}`);

    // Use centralized control logic
    const control = processInterventionControl(response);
    const result = state.result;
    const pageState = ctx.runtime.lastPageState;

    // 1. Handle Force Fail (Override Success)
    if ((state.result as string) === 'SUCCESS' && response.type === 'force_fail') {
       return {
         phase: 'TERMINATED',
         success: false,
         message: response.message || 'Forced fail',
       };
    }

    // 2. Handle Force Success (Override Failure)
    if ((state.result as string) === 'FAILURE' && control.action === 'succeed') {
       return {
         phase: 'TERMINATED',
         success: true,
         message: control.message || 'Forced success',
       };
    }

    // 3. Handle Terminate (Quit / Pause)
    if (control.action === 'terminate') {
       const isQuit = control.reason === 'User quit';
       return {
          phase: 'TERMINATED',
          success: isQuit ? false : ((state.result as string) === 'SUCCESS'),
          message: control.reason
       };
    }

    // 4. Handle Modify / Reject (Re-think)
    if (control.action === 'modify' || response.type === 'reject') {
        if (pageState) {
          const instruction = control.action === 'modify'
            ? control.instruction
            : (state.result as string) === 'SUCCESS' // Use state.result directly
              ? 'The goal is not actually complete. Keep going.'
              : "Don't give up. Try a different approach.";

          const newResult = await think(
            pageState,
            ctx.goal,
            ctx.preset,
            ctx.tracker,
            ctx.history,
            ctx.services.llmClient,
            ctx.interventionMetrics,
            {
              point: 'TERMINAL',
              previousResult: thinkResult,
              instruction,
            }
          );
          if (newResult.type === 'ACTION') {
            return {
              phase: 'ACT',
              cycleIndex: state.cycleIndex,
              action: newResult.action,
              pageState,
            };
          }
        }
        return { phase: 'OBSERVE', cycleIndex: state.cycleIndex };
    }
    
    // 5. Default: Continue (Skip or Approve) => fall through to termination or next cycle
  }

  // If this cycle failed, terminate
  if ((state.result as string) === 'FAILURE') {
    return {
      phase: 'TERMINATED',
      success: false,
      message: state.detail || 'Cycle failed',
    };
  }

  if (nextCycleIndex === -1) {
    // All cycles complete
    return {
      phase: 'TERMINATED',
      success: true,
      message: state.detail || 'All cycles completed successfully',
    };
  }

  // More cycles to go - start next one
  return {
    phase: 'CYCLE_START',
    cycleIndex: nextCycleIndex,
  };
}
