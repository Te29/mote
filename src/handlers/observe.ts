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
      ctx.runtime.forceExploreMode = true;
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

  // Force Explore Mode handling
  // If user requested modification during interrupt or prev step required it
  if (ctx.runtime.forceExploreMode) {
     console.log('⚠️ Forced Explore Mode active for this cycle');
     // No API for forceExploreMode in service yet, but we can assume it will affect REASON phase.
     // Actually, let's keep it simple: we just observe normally.
  }

  // Observe the page
  let pageState = await ctx.services.observe.observe(ctx.runtime.activePage);

  // Update runtime state
  ctx.runtime.lastObservedUrl = pageState.url;
  ctx.runtime.lastPageState = pageState;
  
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
