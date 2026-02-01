// =============================================================================
// SETUP HANDLER
// =============================================================================
// Handles SETUP state in the agent state machine.
// Executes session-level steps before cycles begin.
//
// Design: Setup steps with predefined actions are executed directly.
// Steps requiring reasoning go through LLM (future enhancement).

import type {
  AgentState,
  AgentStateSetup,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import type { StepTracker, StepResult } from '../types/index.js';
import { createTimestamp } from '../types/session.js';
import { executeAction } from '../act/act.js';
import { executeVerification } from '../utils/verification.js';

/**
 * Handle the SETUP state.
 * Executes session-level setup steps from SessionPlan before any cycles begin.
 */
export async function handleSetup(
  _state: AgentStateSetup,
  ctx: AgentContext,
): Promise<AgentState> {
  console.log('🔧 === SETUP PHASE ===');

  // Check if SessionPlan has setup steps
  if (!ctx.sessionPlan?.setupSteps || ctx.sessionPlan.setupSteps.length === 0) {
    console.log('  No setup steps defined');

    // Still run setup verification if defined (validates initial state)
    if (ctx.sessionPlan?.setupVerification) {
      console.log('🔍 Running setup verification...');
      const verifyResult = await executeVerification(
        ctx.runtime.activePage,
        ctx.sessionPlan.setupVerification,
      );

      if (!verifyResult.passed) {
        console.error(`❌ Setup verification failed: ${verifyResult.detail || verifyResult.error}`);
        return {
          phase: 'TERMINATED',
          success: false,
          message: `Setup verification failed: ${verifyResult.detail || verifyResult.error}`,
        };
      }
      console.log(`✅ Setup verification passed: ${verifyResult.detail || 'OK'}`);
    }

    console.log('  Proceeding to cycles...');
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
    console.log(`✅ Setup steps complete (${executedSetupSteps}/${totalSetupSteps} steps)`);

    // Run setup verification if defined
    if (ctx.sessionPlan.setupVerification) {
      console.log('🔍 Running setup verification...');
      const verifyResult = await executeVerification(
        ctx.runtime.activePage,
        ctx.sessionPlan.setupVerification,
      );

      if (!verifyResult.passed) {
        console.error(`❌ Setup verification failed: ${verifyResult.detail || verifyResult.error}`);
        return {
          phase: 'TERMINATED',
          success: false,
          message: `Setup verification failed: ${verifyResult.detail || verifyResult.error}`,
        };
      }
      console.log(`✅ Setup verification passed: ${verifyResult.detail || 'OK'}`);
    }

    return {
      phase: 'CYCLE_START',
      cycleIndex: 0,
    };
  }

  // Get the next setup step to execute
  const stepPlan = ctx.sessionPlan.setupSteps[executedSetupSteps];
  const globalIndex = ctx.history.length;

  console.log(`📋 Executing setup step ${executedSetupSteps + 1}/${totalSetupSteps}: ${stepPlan.description}`);

  // Track step result
  let success = true;
  let error: string | undefined;

  // Navigate to step URL if specified
  if (stepPlan.url) {
    console.log(`  🌐 Navigating to: ${stepPlan.url}`);
    try {
      await ctx.services.browser.navigateTo(ctx.runtime.activePage, stepPlan.url);
    } catch (navError) {
      console.error('  ⚠️ Navigation failed:', navError);
      success = false;
      error = navError instanceof Error ? navError.message : String(navError);
    }
  }

  // Execute the step action if defined (skip if navigation already failed)
  if (success && stepPlan.action) {
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
