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
import type { Action, StepPlan, PlanUnit } from '../types/actions.js';
import { createTimestamp } from '../types/session.js';
import { executeAction } from '../act/index.js';
import { think } from '../reason.js';
import { shouldIntervene, requestIntervention, processInterventionControl } from '../interaction.js';
import { logVariable } from '../utils/debug.js';

// -----------------------------------------------------------------------------
// POINTER ADVANCEMENT HELPERS
// -----------------------------------------------------------------------------

/**
 * Actions that are considered "auxiliary" and should NOT advance the execution pointer.
 * These are preparatory actions (like scrolling) that don't complete a step.
 * Note: scroll_to_element was removed - all element-targeting actions auto-scroll.
 */
const AUXILIARY_ACTIONS: Action['type'][] = ['scroll', 'wait'];

/**
 * Get the current step from the execution pointer.
 * Returns null if no blueprint or pointer is invalid.
 */
function getCurrentStepFromPointer(ctx: AgentContext): StepPlan | null {
  if (!ctx.cyclePlan || ctx.runtime.executionPointer.length === 0) {
    return null;
  }

  const ptr = ctx.runtime.executionPointer;
  const unitIndex = ptr[0];

  if (unitIndex >= ctx.cyclePlan.units.length) {
    return null;
  }

  const unit: PlanUnit = ctx.cyclePlan.units[unitIndex];

  if (unit.type === 'step') {
    return unit.step;
  } else if (unit.type === 'loop' && ptr.length >= 2) {
    const loopStepIndex = ptr[1];
    if (loopStepIndex < unit.loop.steps.length) {
      return unit.loop.steps[loopStepIndex];
    }
  }

  return null;
}

/**
 * Check if the executed action matches what the current step expects.
 * This prevents auxiliary actions (scroll, wait) from advancing the pointer.
 *
 * @param executedAction - The action that was just executed
 * @param currentStep - The current step from the blueprint
 * @returns true if the action completes the step, false otherwise
 */
function actionCompletesStep(executedAction: Action, currentStep: StepPlan | null): boolean {
  // If no current step, allow advancement (fallback behavior)
  if (!currentStep) {
    return true;
  }

  // Auxiliary actions never complete a step
  if (AUXILIARY_ACTIONS.includes(executedAction.type)) {
    return false;
  }

  // If action explicitly sets stepComplete to false, don't advance pointer
  // This allows multi-action steps (like ranking questions) to repeat
  if (executedAction.stepComplete === false) {
    return false;
  }

  // If step has a specific action type defined, check for match
  if (currentStep.action?.type) {
    // The executed action type must match the expected action type
    if (currentStep.action.type !== executedAction.type) {
      return false;
    }
  }

  // Action completes the step
  return true;
}

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
      loopIteration: state.loopIteration,
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

    // Increment execution pointer if we are following a blueprint path
    // IMPORTANT: Only advance if the action actually completes the current step
    if (ctx.cyclePlan && ctx.runtime.executionPointer.length > 0) {
       const ptr = ctx.runtime.executionPointer;
       const currentStep = getCurrentStepFromPointer(ctx);

       // Check if this action completes the step (not an auxiliary action like scroll)
       const completesStep = actionCompletesStep(state.action, currentStep);

       if (!completesStep) {
         // Auxiliary action (scroll, wait) - don't advance pointer
         const verbose = process.env.VERBOSE === 'true';
         if (verbose) {
           console.log(`   ℹ️ Auxiliary action "${state.action.type}" - pointer not advanced`);
         }
       } else {
         // Primary action - advance the pointer
         if (ptr.length === 1) {
           // Top-level linear path: increment unit index
           const currentIdx = ptr[0];
           if (currentIdx < ctx.cyclePlan.units.length) {
             const unit = ctx.cyclePlan.units[currentIdx];
             // Only auto-increment for Step units
             // Loop units are handled differently (condition checking in REASON)
             if (unit.type === 'step') {
               ptr[0]++;
             }
           }
         } else if (ptr.length === 2) {
           // Inside a loop: increment step index within loop
           const unitIndex = ptr[0];
           const unit = ctx.cyclePlan.units[unitIndex];
           if (unit?.type === 'loop') {
             ptr[1]++;
             // Note: Loop condition checking (whether to continue/exit) happens in REASON
             // when ptr[1] >= unit.loop.steps.length
           }
         }
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
