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
import { createTimestamp, getCurrentCycleIndex, getProgress, getCompletedCycles } from '../types/session.js';
import { shouldIntervene, requestIntervention, processInterventionControl, checkInterrupt } from '../interaction.js';
import { logVariable } from '../utils/debug.js';
import { think } from '../reason.js';
import { executeVerification } from '../utils/verification.js';
import { saveCheckpoint, type SessionCheckpoint } from '../utils/checkpoint.js';
import * as path from 'path';

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

  // Reset per-cycle drift tracking
  ctx.runtime.currentCycleDrifts = [];

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
        return { phase: 'CYCLE_START', cycleIndex: nextCycleIndex };
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

    // Analyze drift for this cycle
    if (ctx.runtime.currentCycleDrifts.length > 0) {
      const driftRecords = ctx.runtime.currentCycleDrifts;
      const successfulAdaptations = driftRecords.filter(
        (d) => d.resolutionMethod === 'alternative_match' || d.resolutionMethod === 'llm_adaptation'
      ).length;
      const failedAdaptations = driftRecords.filter((d) => d.resolutionMethod === 'failed').length;

      // Calculate severity based on drift rate
      const driftRate = driftRecords.length / Math.max(1, cycle.cycleSteps.length);
      const severity: 'low' | 'medium' | 'high' =
        driftRate > 0.3 ? 'high' : driftRate > 0.1 ? 'medium' : 'low';

      cycle.driftAnalysis = {
        totalDrifts: driftRecords.length,
        successfulAdaptations,
        failedAdaptations,
        driftRecords,
        severity,
      };

      console.log(
        `📊 Drift Analysis: ${driftRecords.length} drifts detected (severity: ${severity})`
      );

      // Reset for next cycle
      ctx.runtime.currentCycleDrifts = [];
    }

    // Generate cycle strategy from successful cycle (if not already generated)
    if (state.result === 'SUCCESS' && !ctx.tracker.cycleStrategy && cycle.cycleSteps.length >= 3) {
      console.log('🧠 Learning cycle strategy from successful execution...');

      // Build minimal history from cycle steps for strategy generation
      const cycleHistory = cycle.cycleSteps
        .filter((step) => step.action)
        .map((step) => ({
          step: step.globalIndex,
          action: step.action!,
          success: step.isCompleted,
          timestamp: ctx.tracker.lastUpdatedAt,
        }));

      try {
        const strategy = await ctx.services.reason.generateStrategy(
          cycleHistory,
          ctx.services.llmClient
        );

        if (strategy) {
          ctx.tracker.cycleStrategy = strategy;
          console.log(`✓ Strategy learned: ${strategy.pattern}`);
        }
      } catch (error) {
        console.warn('⚠️ Strategy generation failed (non-fatal):', error);
        // Continue execution - strategy is optional
      }
    }
  }

  // Check if there are more cycles
  const nextCycleIndex = getCurrentCycleIndex(ctx.tracker);

  // TERMINAL Intervention
  // If no more cycles OR failure, we are at a terminal state
  const isTerminal = nextCycleIndex === -1 || state.result === 'FAILURE';
  
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
    if (state.result === 'SUCCESS' && response.type === 'force_fail') {
       return {
         phase: 'TERMINATED',
         success: false,
         message: response.message || 'Forced fail',
       };
    }

    // 2. Handle Force Success (Override Failure)
    if (state.result === 'FAILURE' && control.action === 'succeed') {
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
          success: isQuit ? false : (state.result === 'SUCCESS'),
          message: control.reason
       };
    }

    // 4. Handle Modify / Reject (Re-think)
    if (control.action === 'modify' || response.type === 'reject') {
        if (pageState) {
          const instruction = control.action === 'modify'
            ? control.instruction
            : state.result === 'SUCCESS' // Use state.result directly
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
              tokenMarkdown: ctx.tokenMarkdown,
              tokenElements: ctx.tokenElements,
              tokenMaxElements: ctx.tokenMaxElements,
              tokenHistory: ctx.tokenHistory,
            },
            {
              point: 'TERMINAL',
              previousResult: thinkResult,
              instruction,
            },
            ctx.customSystemPrompt,
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
  if (state.result === 'FAILURE') {
    return {
      phase: 'TERMINATED',
      success: false,
      message: state.detail || 'Cycle failed',
    };
  }

  if (nextCycleIndex === -1) {
    // All cycles complete - check session verification if configured
    if (ctx.sessionPlan?.verification) {
      console.log(`🔍 Verifying session completion...`);

      const pageState = ctx.runtime.lastPageState;

      if (pageState) {
        const verifyResult = await executeVerification(
          ctx.runtime.activePage,
          ctx.sessionPlan.verification,
          {
            pageState,
            goal: ctx.goal,
            preset: ctx.preset,
            tracker: ctx.tracker,
            history: ctx.history,
            llmClient: ctx.services.llmClient,
            metrics: ctx.interventionMetrics,
            limits: {
              tokenMarkdown: ctx.tokenMarkdown,
              tokenElements: ctx.tokenElements,
              tokenMaxElements: ctx.tokenMaxElements,
              tokenHistory: ctx.tokenHistory,
            },
            customSystemPrompt: ctx.customSystemPrompt,
          }
        );

        if (!verifyResult.passed) {
          console.log(`❌ Session verification failed: ${verifyResult.detail}`);

          // Session verification failed - handle based on strategy
          if (ctx.sessionPlan.verification.onFailure === 'fail') {
            return {
              phase: 'TERMINATED',
              success: false,
              message: `Session verification failed: ${verifyResult.detail}`,
            };
          }

          // Otherwise continue - go back to last cycle
          const lastCycleIndex = ctx.tracker.cycles.length - 1;
          return {
            phase: 'OBSERVE',
            cycleIndex: lastCycleIndex >= 0 ? lastCycleIndex : 0,
          };
        }

        console.log(`✅ Session verification passed [${verifyResult.method}]: ${verifyResult.detail}`);
      }
    }

    // All cycles complete and verification passed
    // Check if there are wrapup steps to execute
    if (ctx.sessionPlan?.wrapupSteps && ctx.sessionPlan.wrapupSteps.length > 0) {
      console.log('📋 All cycles complete, proceeding to wrapup phase...');
      return {
        phase: 'WRAPUP',
      };
    }

    // No wrapup steps - proceed directly to termination
    return {
      phase: 'TERMINATED',
      success: true,
      message: state.detail || 'All cycles completed successfully',
    };
  }

  // More cycles to go - start next one

  // Save checkpoint if enabled and at checkpoint frequency
  if (
    ctx.enableCheckpointing &&
    getCompletedCycles(ctx.tracker) % ctx.checkpointFrequency === 0
  ) {
    const sessionId =
      ctx.goal?.name.toLowerCase().replace(/\s+/g, '-') ||
      ctx.preset?.name.toLowerCase().replace(/\s+/g, '-') ||
      'session';

    const checkpoint: SessionCheckpoint = {
      version: '1.0.0', // TODO: Import from package.json
      timestamp: createTimestamp(),
      sessionId,
      tracker: ctx.tracker,
      history: ctx.history,
      startUrl: ctx.tracker.cycleStartUrl || ctx.startUrl || '',
      lastUrl: ctx.runtime.activePage.url(),
      goalDescription: ctx.goal?.description,
      presetName: ctx.preset?.name,
    };

    try {
      const filepath = saveCheckpoint(checkpoint);
      console.log(`💾 Checkpoint saved: ${path.basename(filepath)}`);
    } catch (error) {
      console.warn('⚠️ Failed to save checkpoint:', error);
      // Non-fatal - continue execution
    }
  }

  return {
    phase: 'CYCLE_START',
    cycleIndex: nextCycleIndex,
  };
}
