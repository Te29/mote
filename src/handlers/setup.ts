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
import type { StepTracker, StepResult, StepPlan, Action } from '../types/index.js';
import type { Page } from 'playwright';
import { createTimestamp } from '../types/session.js';
import { executeAction } from '../act/act.js';
import { executeVerification } from '../utils/verification.js';
import { observe } from '../observe.js';
import { think } from '../reason.js';
import { loadStepPrompt, renderPromptTemplate } from '../utils/preset.js';

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

  // Execute waitForReady if defined (wait for page to be ready before action)
  // On failure, just warn and continue - don't terminate
  await executeWaitForReady(ctx.runtime.activePage, stepPlan);

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

  // Determine action to execute
  let actionToExecute: Action | undefined = stepPlan.action;

  // LLM-driven step: Use reasoning to determine the action
  if (success && stepPlan.llmRequired && !stepPlan.action) {
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
  ctx.tracker.setupSteps.push(stepTracker);
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
