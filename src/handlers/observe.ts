// =============================================================================
// OBSERVE HANDLER
// =============================================================================
// Handles the OBSERVE state - observes current page state.

import type {
  AgentState,
  AgentStateObserve,
  AgentStateReason,
  AgentStateTerminated,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';

import {
  getProgress
} from '../types/index.js';
import { logVariable } from '../utils/debug.js';
import { checkInterrupt, requestIntervention, processInterventionControl } from '../interaction.js';

/** Valid return states for handleObserve */
type ObserveNextState = AgentStateReason | AgentStateTerminated;

// -----------------------------------------------------------------------------
// OBSERVE
// -----------------------------------------------------------------------------

/**
 * Handle the OBSERVE state.
 * Calls the observe service to get current page state, then transitions to REASON.
 */
export async function handleObserve(
  state: AgentStateObserve,
  ctx: AgentContext,
): Promise<AgentState> {
  const { cycleIndex } = state;

  // Check max steps limit
  if (ctx.maxSteps > 0 && ctx.history.length >= ctx.maxSteps) {
    return {
      phase: 'TERMINATED',
      success: false,
      message: `Reached maximum steps (${ctx.maxSteps}) without completing goal`,
    };
  }

  // Handle Interrupts (User pressed key)
  if (checkInterrupt()) {
    const response = await requestIntervention('INTERRUPT', {
      plan: ctx.tracker,
      cycleIndex,
      pageState: ctx.runtime.lastPageState || undefined,
    });

    // Use centralized control logic
    const control = processInterventionControl(response);

    if (control.action === 'continue') {
      console.log('✓ Continuing...');
    }
    
    else if (control.action === 'modify') {
      console.log(`✎ User instruction: "${control.instruction}"`);
      ctx.runtime.pendingUserInstruction = control.instruction;
    }

    else if (control.action === 'terminate') {
      return {
        phase: 'TERMINATED',
        success: false,
        message: control.reason,
      };
    }

    else if (control.action === 'succeed') {
      return {
        phase: 'TERMINATED',
        success: true,
        message: control.message || 'Forced success by user',
      };
    }

    // Skip isn't really applicable to interrupt, treat as continue
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`👁️  OBSERVING (Cycle ${cycleIndex + 1})`);
  console.log(`${'─'.repeat(40)}`);

  // Progress update
  console.log(`Progress: ${getProgress(ctx.tracker)}`);

  // Determine observation strategy (Targeted vs Full)
  let targetSelectors: string[] | undefined;
  
  // If we are following an execution path, look for the specific target
  // If we are following an execution path, look for the specific target
  if (ctx.executionPath && ctx.runtime.executionPointer) {
    const ptr = ctx.runtime.executionPointer;
    const unitIndex = ptr[0];

    if (unitIndex < ctx.executionPath.units.length) {
      const unit = ctx.executionPath.units[unitIndex];
      let currentStep: any = null;

      if (unit.type === 'step') {
        currentStep = unit.step;
      } else if (unit.type === 'loop' && ptr.length > 1) {
         const stepIndex = ptr[1];
         if (stepIndex < unit.loop.steps.length) {
            currentStep = unit.loop.steps[stepIndex];
         }
      }

      // Only use target selector if it exists
      if (currentStep && currentStep.targetElementSelector) {
        targetSelectors = [currentStep.targetElementSelector];
        console.log(`🎯 Targeted Observation: Looking for "${currentStep.targetElementSelector}"`);
      }
    }
  }

  // Observe the page (Targeted or Full)
  let pageState = await ctx.services.observe.observe(ctx.runtime.activePage, targetSelectors);

  // Auto re-observe: if page is empty (no elements, no content), wait and retry.
  // Handles SPAs and slow-loading pages not ready at domcontentloaded + postNavDelay.
  const REOBSERVE_DELAYS = [2000, 3000, 5000];
  for (let attempt = 0; attempt < REOBSERVE_DELAYS.length; attempt++) {
    const hasContent = pageState.elements.length > 0 || pageState.markdown.trim().length > 0;
    if (hasContent) break;
    if (pageState.captcha?.detected) break; // don't retry on captcha
    console.log(`⏳ Page appears empty (attempt ${attempt + 1}/${REOBSERVE_DELAYS.length}), waiting ${REOBSERVE_DELAYS[attempt]}ms...`);
    await ctx.runtime.activePage.waitForTimeout(REOBSERVE_DELAYS[attempt]);
    pageState = await ctx.services.observe.observe(ctx.runtime.activePage);
  }

  // Update runtime state
  ctx.runtime.lastObservedUrl = pageState.url;
  ctx.runtime.lastPageState = pageState;

  // Retroactively set pageStateAfter on the previous step's history entry.
  // This captures the post-action state without an extra observation call.
  if (ctx.history.length > 0) {
    ctx.history[ctx.history.length - 1].pageStateAfter = pageState;
  }
  
  // Log observation summary
  logVariable('PAGE STATE', {
    url: pageState.url,
    title: pageState.title,
    elements: pageState.elements.length,
    interactive: pageState.elements.length, // interactive flag removed from ElementInfo recently? using total for now.
  });

  // Transition to REASON with observed page state
  return {
    phase: 'REASON',
    cycleIndex: state.cycleIndex,
    pageState,
  };
}
