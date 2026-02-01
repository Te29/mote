// =============================================================================
// WRAPUP HANDLER
// =============================================================================
// Handles WRAPUP state in the agent state machine.
// Executes session-level steps after all cycles complete.
//
// Design: Wrapup steps with predefined actions are executed directly.
// Steps requiring reasoning go through LLM (future enhancement).

import type {
  AgentState,
  AgentStateWrapup,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import type { StepTracker, StepResult } from '../types/index.js';
import { createTimestamp } from '../types/session.js';
import { executeAction } from '../act/act.js';
import { saveCheckpoint, type SessionCheckpoint, type CheckpointRuntimeState } from '../utils/checkpoint.js';
import { executeVerification } from '../utils/verification.js';
import * as path from 'path';

/**
 * Handle the WRAPUP state.
 * Executes session-level wrapup steps from SessionPlan after all cycles complete.
 */
export async function handleWrapup(
  _state: AgentStateWrapup,
  ctx: AgentContext,
): Promise<AgentState> {
  console.log('🎬 === WRAPUP PHASE ===');

  // Check if SessionPlan has wrapup steps
  if (!ctx.sessionPlan?.wrapupSteps || ctx.sessionPlan.wrapupSteps.length === 0) {
    console.log('  No wrapup steps defined');

    // Still run wrapup verification if defined (validates final state)
    if (ctx.sessionPlan?.wrapupVerification) {
      console.log('🔍 Running wrapup verification...');
      const verifyResult = await executeVerification(
        ctx.runtime.activePage,
        ctx.sessionPlan.wrapupVerification,
      );

      if (!verifyResult.passed) {
        console.error(`❌ Wrapup verification failed: ${verifyResult.detail || verifyResult.error}`);
        return {
          phase: 'TERMINATED',
          success: false,
          message: `Wrapup verification failed: ${verifyResult.detail || verifyResult.error}`,
        };
      }
      console.log(`✅ Wrapup verification passed: ${verifyResult.detail || 'OK'}`);
    }

    console.log('  Completing session...');
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
    console.log(`✅ Wrapup steps complete (${executedWrapupSteps}/${totalWrapupSteps} steps)`);

    // Run wrapup verification if defined
    if (ctx.sessionPlan.wrapupVerification) {
      console.log('🔍 Running wrapup verification...');
      const verifyResult = await executeVerification(
        ctx.runtime.activePage,
        ctx.sessionPlan.wrapupVerification,
      );

      if (!verifyResult.passed) {
        console.error(`❌ Wrapup verification failed: ${verifyResult.detail || verifyResult.error}`);
        return {
          phase: 'TERMINATED',
          success: false,
          message: `Wrapup verification failed: ${verifyResult.detail || verifyResult.error}`,
        };
      }
      console.log(`✅ Wrapup verification passed: ${verifyResult.detail || 'OK'}`);
    }

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

  // Save checkpoint after each wrapup step to prevent data loss
  if (ctx.enableCheckpointing) {
    const sessionId =
      ctx.goal?.name.toLowerCase().replace(/\s+/g, '-') ||
      ctx.preset?.name.toLowerCase().replace(/\s+/g, '-') ||
      'session';

    // Capture runtime state for precise resumption
    const runtimeState: CheckpointRuntimeState = {
      executionPointer: [...ctx.runtime.executionPointer],
      loopStates: { ...ctx.runtime.loopStates },
    };

    const checkpoint: SessionCheckpoint = {
      version: '1.0.0',
      timestamp: createTimestamp(),
      sessionId,
      tracker: ctx.tracker,
      history: ctx.history,
      startUrl: ctx.tracker.cycleStartUrl || ctx.startUrl || '',
      lastUrl: ctx.runtime.activePage.url(),
      goalDescription: ctx.goal?.description,
      presetName: ctx.preset?.name,
      runtimeState,
    };

    try {
      const filepath = saveCheckpoint(checkpoint);
      console.log(`  💾 Wrapup checkpoint saved: ${path.basename(filepath)}`);
    } catch (checkpointError) {
      console.warn('  ⚠️ Failed to save wrapup checkpoint:', checkpointError);
      // Non-fatal - continue execution
    }
  }

  // Continue to next wrapup step
  return {
    phase: 'WRAPUP',
  };
}
