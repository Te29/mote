// =============================================================================
// ACT HANDLER
// =============================================================================
// Handles the ACT state - executes browser actions.

import type {
  AgentState,
  AgentStateAct,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import type { StepResult } from '../types/results.js';
import { createTimestamp } from '../types/session.js';
import { executeAction, pressKey } from '../act/index.js';
import { think } from '../reason.js';
import { shouldIntervene, requestIntervention, processInterventionControl } from '../interaction.js';
import { logVariable } from '../utils/debug.js';

// -----------------------------------------------------------------------------
// ACT
// -----------------------------------------------------------------------------

/**
 * Handle the ACT state.
 * Executes the action on the browser and records the result.
 */
export async function handleAct(
  state: AgentStateAct,
  ctx: AgentContext,
): Promise<AgentState> {
  const { action, cycleIndex, pageState } = state;

  // ACTION Intervention
  if (shouldIntervene(ctx.engagementMode, 'ACTION')) {
    const response = await requestIntervention('ACTION', {
      plan: ctx.tracker,
      thinkResult: { type: 'ACTION', action },
      pageState,
    });

    logVariable('INTERVENTION RESPONSE (ACTION)', {
      responseType: response.type,
      action: { type: action.type, elementId: action.elementId, reason: action.reason },
      details:
        'reason' in response
          ? response.reason
          : 'instruction' in response
            ? response.instruction
            : null,
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
        message: control.message || 'Forced success',
      };
    }

    if (control.action === 'skip') {
      return { phase: 'OBSERVE', cycleIndex };
    }

    if (control.action === 'modify') {
      const modResult = await think(
        pageState,
        ctx.goal,
        ctx.preset,
        ctx.tracker,
        ctx.history,
        ctx.services.llmClient,
        ctx.interventionMetrics,
        {
          tokenMarkdown: ctx.tokenMarkdown,
          tokenElements: ctx.tokenElements,
          tokenMaxElements: ctx.tokenMaxElements,
          tokenHistory: ctx.tokenHistory,
        },
        {
          point: 'ACTION',
          previousResult: { type: 'ACTION', action },
          instruction: control.instruction,
        },
        ctx.customSystemPrompt,
      );
      if (modResult.type === 'ACTION') {
        return {
          phase: 'ACT',
          cycleIndex,
          action: modResult.action,
          pageState,
        };
      }
      return { phase: 'OBSERVE', cycleIndex };
    }

    // Handle Reject specifically (requires context awareness)
    if (response.type === 'reject') {
      const newResult = await think(
        pageState,
        ctx.goal,
        ctx.preset,
        ctx.tracker,
        ctx.history,
        ctx.services.llmClient,
        ctx.interventionMetrics,
        {
          tokenMarkdown: ctx.tokenMarkdown,
          tokenElements: ctx.tokenElements,
          tokenMaxElements: ctx.tokenMaxElements,
          tokenHistory: ctx.tokenHistory,
        },
        {
          point: 'ACTION',
          previousResult: { type: 'ACTION', action },
          instruction: response.reason || 'Try a different approach',
        },
        ctx.customSystemPrompt,
      );
      if (newResult.type === 'ACTION') {
        return {
          phase: 'ACT',
          cycleIndex,
          action: newResult.action,
          pageState,
        };
      }
      return { phase: 'OBSERVE', cycleIndex };
    }
  }

  // Execute the action with retry logic
  let result = await executeAction(
    ctx.runtime.activePage,
    action,
    pageState.elements,
  );

  // Handle ERROR Intervention
  if (!result.success && shouldIntervene(ctx.engagementMode, 'ERROR')) {
    const errorResponse = await requestIntervention('ERROR', {
      plan: ctx.tracker,
      error: result.error,
      pageState,
    });

    const control = processInterventionControl(errorResponse);
    
    if (control.action === 'terminate') {
       return {
         phase: 'TERMINATED',
         success: false,
         message: control.reason
       };
    }
    
    if (control.action === 'succeed') {
       return {
         phase: 'TERMINATED',
         success: true,
         message: control.message || 'Forced success after error'
       };
    }
    
    if (control.action === 'skip') {
       // Allow skipping the error, effectively marking step as failed but continuing
    }
    
    if (control.action === 'modify') {
       // Logic to retry action with modification? 
       // For now just continue to observe, effectively skipping the faulty action 
       // but maybe we should allow immediate retry?
       // Complex to implement immediate retry here without recursion.
       // Let's go to OBSERVE and let REASON handle the new state (which includes the error).
    }
  }

  // Handle new page from action (e.g., new tab)
  if (result.newPage) {
    ctx.runtime.activePage = result.newPage;
  }

  // Record step in tracker
  const cycle = ctx.tracker.cycles[state.cycleIndex];
  if (cycle) {
    const cycleStep = {
      globalIndex: state.globalIndex ?? -1,
      stepId: state.stepId ?? "unknown",
      loopId: state.loopId,
      isCompleted: true,
      action: state.action,
      stepDescription: state.action.reason,
      pageContext: {
         url: ctx.runtime.activePage.url(),
         title: await ctx.runtime.activePage.title().catch(() => "")
      },
      executionMeta: {
        timing: {
          actionDuration: 0, // Placeholder
        }
      }
    };
    cycle.cycleSteps.push(cycleStep);
    ctx.tracker.lastUpdatedAt = createTimestamp();
  }

  // Record step in history
  const stepResult: StepResult = {
    step: ctx.history.length + 1,
    action: state.action,
    success: result.success,
    error: result.error,
    pageStateBefore: state.pageState,
    timestamp: createTimestamp(),
  };
  ctx.history.push(stepResult);

  // Update intervention metrics
  if (result.success) {
    ctx.interventionMetrics.consecutiveFailures = 0;
    
    // Increment execution pointer if we are following a path
    // Simple top-level increment for now - complex loop logic handled in REASON/Drift
    if (ctx.cyclePlan && ctx.runtime.executionPointer.length === 1) {
       // Only auto-increment if we are at top-level linear path
       // Loops require more logic (checking conditions etc) which should happen in REASON
       const currentIdx = ctx.runtime.executionPointer[0];
       if (currentIdx < ctx.cyclePlan.units.length) {
          ctx.runtime.executionPointer[0]++;
       }
    }
  } else {
    ctx.interventionMetrics.consecutiveFailures++;
  }

  // Pause between steps if configured
  if (ctx.stepPause > 0) {
    await ctx.runtime.activePage.waitForTimeout(ctx.stepPause);
  }

  // Transition back to OBSERVE
  return {
    phase: 'OBSERVE',
    cycleIndex: state.cycleIndex,
  };
}
