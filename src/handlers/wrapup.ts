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
import type { StepTracker, StepResult, StepPlan, Action } from '../types/index.js';
import type { Page } from 'playwright';
import { createTimestamp } from '../types/session.js';
import { executeAction } from '../act/act.js';
import { saveCheckpoint, type SessionCheckpoint, type CheckpointRuntimeState } from '../utils/checkpoint.js';
import { executeVerification } from '../utils/verification.js';
import { observe } from '../observe.js';
import { think } from '../reason.js';
import { loadStepPrompt, renderPromptTemplate } from '../utils/preset.js';
import * as path from 'path';

/**
 * Execute waitForReady hook for a step if defined.
 * Waits for the page to be ready according to the step's waitScript.
 *
 * @param page - Playwright page object
 * @param stepPlan - The step plan that may have waitForReady config
 * @returns true if successful or no waitForReady defined, false if failed with onTimeout='fail'
 */
async function executeWaitForReady(page: Page, stepPlan: StepPlan): Promise<{ success: boolean; error?: string }> {
  if (!stepPlan.waitForReady) {
    return { success: true };
  }

  const { waitScript, description, timeout = 10000, onTimeout = 'continue' } = stepPlan.waitForReady;

  console.log(`  ⏳ Waiting for page ready: ${description || 'custom script'}`);

  try {
    await Promise.race([
      page.evaluate(waitScript),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('waitForReady timeout')), timeout)
      )
    ]);
    console.log(`  ✓ Page ready`);
    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`  ⚠️ waitForReady failed: ${msg}`);

    if (onTimeout === 'fail') {
      return { success: false, error: `waitForReady failed for step "${stepPlan.stepId}": ${msg}` };
    }
    // onTimeout: 'continue' - proceed anyway
    return { success: true };
  }
}

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

  // Execute waitForReady if defined (wait for page to be ready before action)
  // On failure, just warn and continue - don't terminate
  await executeWaitForReady(ctx.runtime.activePage, stepPlan);

  // Navigate to step URL if specified
  if (stepPlan.url) {
    console.log(`  🌐 Navigating to: ${stepPlan.url}`);
    try {
      await ctx.services.browser.navigateTo(ctx.runtime.activePage, stepPlan.url);
    } catch (error) {
      console.error('  ⚠️ Navigation failed:', error);
    }
  }

  // Determine action to execute
  let success = true;
  let error: string | undefined;
  let actionToExecute: Action | undefined = stepPlan.action;

  // LLM-driven step: Use reasoning to determine the action
  if (stepPlan.llmRequired && !stepPlan.action) {
    console.log(`  🧠 LLM-driven step: ${stepPlan.description}`);

    // Observe page to get current state
    const pageState = await observe(ctx.runtime.activePage);

    // Load step-specific prompt if provided
    let stepPrompt: string | undefined;
    if (stepPlan.promptRef && ctx.presetDir) {
      const rawPrompt = loadStepPrompt(ctx.presetDir, stepPlan.promptRef);
      if (rawPrompt) {
        stepPrompt = renderPromptTemplate(rawPrompt, {
          instruction: stepPlan.instruction || stepPlan.description,
          step: stepPlan,
          context: ctx.goal?.context || {},
          goal: ctx.goal,
        });
        console.log(`   📝 Loaded step prompt from: ${stepPlan.promptRef}`);
      }
    }

    // Build instruction for LLM
    const stepInstruction = stepPlan.instruction || stepPlan.description;
    const hints: string[] = [];
    if (stepPlan.targetElementSelector) {
      hints.push(`Target element: ${stepPlan.targetElementSelector}`);
    }

    const fullInstruction = hints.length > 0
      ? `${stepInstruction}\n\nHints:\n${hints.join('\n')}`
      : stepInstruction;

    // Call reasoning module
    const llmResult = await think(
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
        instruction: fullInstruction,
      },
      stepPrompt || ctx.customSystemPrompt,
    );

    if (llmResult.type === 'ACTION') {
      console.log(`   ✓ LLM determined action: ${llmResult.action.type} - ${llmResult.action.reason}`);
      actionToExecute = llmResult.action;
    } else if (llmResult.type === 'GOAL_SUCCESS') {
      console.log(`   ✓ LLM reports goal success: ${llmResult.finalAnswer}`);
    } else if (llmResult.type === 'FAIL') {
      console.log(`   ✗ LLM failed: ${llmResult.error}`);
      success = false;
      error = llmResult.error;
    } else {
      console.log(`   ⚠️ LLM returned ${llmResult.type}, continuing...`);
    }
  }

  // Execute action if we have one
  if (success && actionToExecute) {
    console.log(`  ⚡ Executing action: ${actionToExecute.type}`);
    const result = await executeAction(
      ctx.runtime.activePage,
      actionToExecute,
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
    action: actionToExecute,
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
    action: actionToExecute,
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
