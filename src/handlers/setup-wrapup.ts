// =============================================================================
// SETUP AND WRAPUP HANDLERS
// =============================================================================
// Handles SETUP and WRAPUP states in the agent state machine.
// These execute session-level steps before cycles (setup) and after cycles (wrapup).
//
// Design: Setup/wrapup steps with predefined actions are executed directly.
// Steps requiring reasoning go through LLM (future enhancement).

import type {
  AgentState,
  AgentStateSetup,
  AgentStateWrapup,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import type { StepTracker, StepResult } from '../types/index.js';
import { createTimestamp } from '../types/session.js';
import { executeAction } from '../act/act.js';

// -----------------------------------------------------------------------------
// SETUP HANDLER
// -----------------------------------------------------------------------------

/**
 * Handle the SETUP state.
 * Executes session-level setup steps from SessionPlan before any cycles begin.
 */
export async function handleSetup(
  state: AgentStateSetup,
  ctx: AgentContext,
): Promise<AgentState> {
  console.log('🔧 === SETUP PHASE ===');

  // Check if SessionPlan has setup steps
  if (!ctx.sessionPlan?.setupSteps || ctx.sessionPlan.setupSteps.length === 0) {
    console.log('  No setup steps defined, proceeding to cycles...');
    return {
      phase: 'CYCLE_START',
      cycleIndex: 0,
    };
  }

  // Initialize setupSteps array if not already done
  if (!ctx.tracker.setupSteps) {
    ctx.tracker.setupSteps = [];
  }

  const totalSetupSteps = ctx.sessionPlan.setupSteps.length;
  const executedSetupSteps = ctx.tracker.setupSteps.length;

  // Check if all setup steps are complete
  if (executedSetupSteps >= totalSetupSteps) {
    console.log(`✅ Setup complete (${executedSetupSteps}/${totalSetupSteps} steps)`);
    return {
      phase: 'CYCLE_START',
      cycleIndex: 0,
    };
  }

  // Get the next setup step to execute
  const stepPlan = ctx.sessionPlan.setupSteps[executedSetupSteps];
  const globalIndex = ctx.history.length;

  console.log(`📋 Executing setup step ${executedSetupSteps + 1}/${totalSetupSteps}: ${stepPlan.description}`);

  // Navigate to step URL if specified
  if (stepPlan.url) {
    console.log(`  🌐 Navigating to: ${stepPlan.url}`);
    try {
      await ctx.services.browser.navigateTo(ctx.runtime.activePage, stepPlan.url);
    } catch (error) {
      console.error('  ⚠️ Navigation failed:', error);
    }
  }

  // Execute the step action if defined
  let success = true;
  let error: string | undefined;

  if (stepPlan.action) {
    console.log(`  ⚡ Executing action: ${stepPlan.action.type}`);
    const result = await executeAction(
      ctx.runtime.activePage,
      stepPlan.action,
      [], // No elements needed for predefined actions
    );
    success = result.success;
    error = result.error;

    if (result.newPage) {
      ctx.runtime.activePage = result.newPage;
    }
  }

  // Record step in tracker
  const stepTracker: StepTracker = {
    globalIndex,
    stepId: stepPlan.stepId,
    isCompleted: success,
    action: stepPlan.action,
    stepDescription: stepPlan.description,
    pageContext: {
      url: ctx.runtime.activePage.url(),
      title: await ctx.runtime.activePage.title().catch(() => ''),
    },
  };
  ctx.tracker.setupSteps.push(stepTracker);
  ctx.tracker.lastUpdatedAt = createTimestamp();

  // Record in history
  const stepResult: StepResult = {
    step: ctx.history.length + 1,
    action: stepPlan.action,
    success,
    error,
    timestamp: createTimestamp(),
  };
  ctx.history.push(stepResult);

  if (!success) {
    console.error(`  ❌ Setup step failed: ${error}`);
    return {
      phase: 'TERMINATED',
      success: false,
      message: `Setup failed at step ${executedSetupSteps + 1}: ${error}`,
    };
  }

  console.log(`  ✅ Setup step completed`);

  // Continue to next setup step
  return {
    phase: 'SETUP',
  };
}

// -----------------------------------------------------------------------------
// WRAPUP HANDLER
// -----------------------------------------------------------------------------

/**
 * Handle the WRAPUP state.
 * Executes session-level wrapup steps from SessionPlan after all cycles complete.
 */
export async function handleWrapup(
  state: AgentStateWrapup,
  ctx: AgentContext,
): Promise<AgentState> {
  console.log('🎬 === WRAPUP PHASE ===');

  // Check if SessionPlan has wrapup steps
  if (!ctx.sessionPlan?.wrapupSteps || ctx.sessionPlan.wrapupSteps.length === 0) {
    console.log('  No wrapup steps defined, completing session...');
    return {
      phase: 'TERMINATED',
      success: true,
      message: 'Session completed successfully',
    };
  }

  // Initialize wrapupSteps array if not already done
  if (!ctx.tracker.wrapupSteps) {
    ctx.tracker.wrapupSteps = [];
  }

  const totalWrapupSteps = ctx.sessionPlan.wrapupSteps.length;
  const executedWrapupSteps = ctx.tracker.wrapupSteps.length;

  // Check if all wrapup steps are complete
  if (executedWrapupSteps >= totalWrapupSteps) {
    console.log(`✅ Wrapup complete (${executedWrapupSteps}/${totalWrapupSteps} steps)`);
    return {
      phase: 'TERMINATED',
      success: true,
      message: 'Session completed successfully with wrapup',
    };
  }

  // Get the next wrapup step to execute
  const stepPlan = ctx.sessionPlan.wrapupSteps[executedWrapupSteps];
  const globalIndex = ctx.history.length;

  console.log(`📋 Executing wrapup step ${executedWrapupSteps + 1}/${totalWrapupSteps}: ${stepPlan.description}`);

  // Navigate to step URL if specified
  if (stepPlan.url) {
    console.log(`  🌐 Navigating to: ${stepPlan.url}`);
    try {
      await ctx.services.browser.navigateTo(ctx.runtime.activePage, stepPlan.url);
    } catch (error) {
      console.error('  ⚠️ Navigation failed:', error);
    }
  }

  // Execute the step action if defined
  let success = true;
  let error: string | undefined;

  if (stepPlan.action) {
    console.log(`  ⚡ Executing action: ${stepPlan.action.type}`);
    const result = await executeAction(
      ctx.runtime.activePage,
      stepPlan.action,
      [], // No elements needed for predefined actions
    );
    success = result.success;
    error = result.error;

    if (result.newPage) {
      ctx.runtime.activePage = result.newPage;
    }
  }

  // Record step in tracker
  const stepTracker: StepTracker = {
    globalIndex,
    stepId: stepPlan.stepId,
    isCompleted: success,
    action: stepPlan.action,
    stepDescription: stepPlan.description,
    pageContext: {
      url: ctx.runtime.activePage.url(),
      title: await ctx.runtime.activePage.title().catch(() => ''),
    },
  };
  ctx.tracker.wrapupSteps.push(stepTracker);
  ctx.tracker.lastUpdatedAt = createTimestamp();

  // Record in history
  const stepResult: StepResult = {
    step: ctx.history.length + 1,
    action: stepPlan.action,
    success,
    error,
    timestamp: createTimestamp(),
  };
  ctx.history.push(stepResult);

  if (!success) {
    console.error(`  ❌ Wrapup step failed: ${error}`);
    return {
      phase: 'TERMINATED',
      success: false,
      message: `Wrapup failed at step ${executedWrapupSteps + 1}: ${error}`,
    };
  }

  console.log(`  ✅ Wrapup step completed`);

  // Continue to next wrapup step
  return {
    phase: 'WRAPUP',
  };
}
