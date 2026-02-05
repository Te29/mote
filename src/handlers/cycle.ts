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
import type { StepPlan, Action } from '../types/actions.js';
import type { Page } from 'playwright';
import { createTimestamp, getCurrentCycleIndex, getProgress, getCompletedCycles } from '../types/session.js';
import { shouldIntervene, requestIntervention, processInterventionControl, checkInterrupt } from '../interaction.js';
import { logVariable } from '../utils/debug.js';
import { think } from '../reason.js';
import { executeVerification } from '../utils/verification.js';
import { saveCheckpoint, type SessionCheckpoint, type CheckpointRuntimeState } from '../utils/checkpoint.js';
import { observe } from '../observe.js';
import { loadStepPrompt, renderPromptTemplate } from '../utils/preset.js';
import * as path from 'path';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

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

  // Execute cycle-start steps if defined
  console.log(`[DEBUG] ctx.sessionPlan exists: ${!!ctx.sessionPlan}`);
  console.log(`[DEBUG] cycleStartSteps exists: ${!!ctx.sessionPlan?.cycleStartSteps}`);
  console.log(`[DEBUG] cycleStartSteps length: ${ctx.sessionPlan?.cycleStartSteps?.length}`);

  if (ctx.sessionPlan?.cycleStartSteps && ctx.sessionPlan.cycleStartSteps.length > 0) {
    console.log(`🔄 === CYCLE ${cycleIndex + 1} START PHASE ===`);

    // Initialize tracker for this cycle's start steps if needed
    if (!ctx.tracker.cycles[cycleIndex].cycleStartSteps) {
      ctx.tracker.cycles[cycleIndex].cycleStartSteps = [];
    }

    const totalSteps = ctx.sessionPlan.cycleStartSteps.length;
    const executedSteps = ctx.tracker.cycles[cycleIndex].cycleStartSteps!.length;

    // Execute remaining cycle-start steps
    for (let i = executedSteps; i < totalSteps; i++) {
      const stepPlan = ctx.sessionPlan.cycleStartSteps[i];
      const globalIndex = ctx.history.length;

      console.log(`📋 Executing cycle-start step ${i + 1}/${totalSteps}: ${stepPlan.description}`);

      let success = true;
      let error: string | undefined;
      let pageState: Awaited<ReturnType<typeof observe>> | undefined;

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
        pageState = await observe(ctx.runtime.activePage);

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
          // Continue - step is successful
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
        const { executeAction } = await import('../act/act.js');
        const result = await executeAction(
          ctx.runtime.activePage,
          actionToExecute,
          pageState?.elements || [],
        );
        success = result.success;
        error = result.error;

        if (result.newPage) {
          ctx.runtime.activePage = result.newPage;
        }

        // Check if this is an auxiliary action (scroll, wait) that shouldn't complete the step
        const AUXILIARY_ACTIONS = ['scroll', 'wait'];
        if (AUXILIARY_ACTIONS.includes(actionToExecute.type)) {
          console.log(`  ℹ️ Auxiliary action "${actionToExecute.type}" - retrying step`);
          // Record in history but don't mark step complete - retry
          ctx.history.push({
            step: ctx.history.length + 1,
            action: actionToExecute,
            success,
            error,
            timestamp: createTimestamp(),
          });
          i--; // Retry this step
          continue;
        }
      }

      // Record step in tracker
      const stepTracker = {
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
      ctx.tracker.cycles[cycleIndex].cycleStartSteps!.push(stepTracker);
      ctx.tracker.lastUpdatedAt = createTimestamp();

      // Record in history
      const stepResult = {
        step: ctx.history.length + 1,
        action: actionToExecute,
        success,
        error,
        timestamp: createTimestamp(),
      };
      ctx.history.push(stepResult);

      if (!success) {
        console.error(`  ❌ Cycle-start step failed: ${error}`);
        return {
          phase: 'TERMINATED',
          success: false,
          message: `Cycle ${cycleIndex + 1} start failed at step ${i + 1}: ${error}`,
        };
      }

      console.log(`  ✅ Cycle-start step completed`);
    }

    // Run cycle-start verification if defined
    if (ctx.sessionPlan.cycleStartVerification) {
      console.log('🔍 Running cycle-start verification...');
      const verifyResult = await executeVerification(
        ctx.runtime.activePage,
        ctx.sessionPlan.cycleStartVerification,
      );

      if (!verifyResult.passed) {
        console.error(`❌ Cycle-start verification failed: ${verifyResult.detail || verifyResult.error}`);
        return {
          phase: 'TERMINATED',
          success: false,
          message: `Cycle ${cycleIndex + 1} start verification failed: ${verifyResult.detail || verifyResult.error}`,
        };
      }
      console.log(`✅ Cycle-start verification passed: ${verifyResult.detail || 'OK'}`);
    }
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
    // Execute cycle-end steps if defined (before marking cycle complete)
    if (ctx.sessionPlan?.cycleEndSteps && ctx.sessionPlan.cycleEndSteps.length > 0) {
      console.log(`🏁 === CYCLE ${state.cycleIndex + 1} END PHASE ===`);

      // Initialize tracker for this cycle's end steps if needed
      if (!cycle.cycleEndSteps) {
        cycle.cycleEndSteps = [];
      }

      const totalSteps = ctx.sessionPlan.cycleEndSteps.length;
      const executedSteps = cycle.cycleEndSteps.length;

      // Execute remaining cycle-end steps
      for (let i = executedSteps; i < totalSteps; i++) {
        const stepPlan = ctx.sessionPlan.cycleEndSteps[i];
        const globalIndex = ctx.history.length;

        console.log(`📋 Executing cycle-end step ${i + 1}/${totalSteps}: ${stepPlan.description}`);

        let success = true;
        let error: string | undefined;
        let pageState: Awaited<ReturnType<typeof observe>> | undefined;

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
          pageState = await observe(ctx.runtime.activePage);

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
          const { executeAction } = await import('../act/act.js');
          const result = await executeAction(
            ctx.runtime.activePage,
            actionToExecute,
            pageState?.elements || [],
          );
          success = result.success;
          error = result.error;

          if (result.newPage) {
            ctx.runtime.activePage = result.newPage;
          }

          // Check if this is an auxiliary action (scroll, wait) that shouldn't complete the step
          const AUXILIARY_ACTIONS = ['scroll', 'wait'];
          if (AUXILIARY_ACTIONS.includes(actionToExecute.type)) {
            console.log(`  ℹ️ Auxiliary action "${actionToExecute.type}" - retrying step`);
            // Record in history but don't mark step complete - retry
            ctx.history.push({
              step: ctx.history.length + 1,
              action: actionToExecute,
              success,
              error,
              timestamp: createTimestamp(),
            });
            i--; // Retry this step
            continue;
          }
        }

        // Record step in tracker
        const stepTracker = {
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
        cycle.cycleEndSteps.push(stepTracker);
        ctx.tracker.lastUpdatedAt = createTimestamp();

        // Record in history
        const stepResult = {
          step: ctx.history.length + 1,
          action: actionToExecute,
          success,
          error,
          timestamp: createTimestamp(),
        };
        ctx.history.push(stepResult);

        if (!success) {
          console.error(`  ❌ Cycle-end step failed: ${error}`);
          return {
            phase: 'TERMINATED',
            success: false,
            message: `Cycle ${state.cycleIndex + 1} end failed at step ${i + 1}: ${error}`,
          };
        }

        console.log(`  ✅ Cycle-end step completed`);
      }

      // Run cycle-end verification if defined
      if (ctx.sessionPlan.cycleEndVerification) {
        console.log('🔍 Running cycle-end verification...');
        const verifyResult = await executeVerification(
          ctx.runtime.activePage,
          ctx.sessionPlan.cycleEndVerification,
        );

        if (!verifyResult.passed) {
          console.warn(`⚠️ Cycle-end verification failed: ${verifyResult.detail || verifyResult.error}`);
          // Continue despite failure (soft handling for cycle-end)
        } else {
          console.log(`✅ Cycle-end verification passed: ${verifyResult.detail || 'OK'}`);
        }
      }
    }

    cycle.isCompleted = true;
    ctx.tracker.lastUpdatedAt = createTimestamp();

    // Analyze drift for this cycle
    if (ctx.runtime.currentCycleDrifts.length > 0) {
      const driftRecords = ctx.runtime.currentCycleDrifts;

      // Count different resolution methods separately for accurate statistics
      const alternativeMatches = driftRecords.filter(
        (d) => d.resolutionMethod === 'alternative_match'
      ).length;
      const llmAdaptations = driftRecords.filter(
        (d) => d.resolutionMethod === 'llm_adaptation'
      ).length;
      const failedAdaptations = driftRecords.filter(
        (d) => d.resolutionMethod === 'failed'
      ).length;

      // Total successful adaptations (both types)
      const successfulAdaptations = alternativeMatches + llmAdaptations;

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
        // Add detailed breakdown for accurate statistics
        alternativeMatches,
        llmAdaptations,
      };

      console.log(
        `📊 Drift Analysis: ${driftRecords.length} drifts (alt: ${alternativeMatches}, llm: ${llmAdaptations}, failed: ${failedAdaptations}, severity: ${severity})`
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
    // Check if unlimited cycles mode
    const numberOfCycles = ctx.sessionPlan?.numberOfCycles ?? 1;
    const isUnlimitedCycles = numberOfCycles === -1;

    // If unlimited cycles, create a new cycle instead of terminating
    if (isUnlimitedCycles) {
      const newCycleIndex = ctx.tracker.cycles.length;
      ctx.tracker.cycles.push({
        isCompleted: false,
        cycleSteps: [],
      });
      console.log(`♾️  Unlimited cycles mode: Starting cycle ${newCycleIndex + 1}...`);

      return {
        phase: 'CYCLE_START',
        cycleIndex: newCycleIndex,
      };
    }

    // All cycles complete - save final checkpoint if enabled
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
        console.log(`💾 Final checkpoint saved: ${path.basename(filepath)}`);
      } catch (error) {
        console.warn('⚠️ Failed to save final checkpoint:', error);
        // Non-fatal - continue execution
      }
    }

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
          // IMPORTANT: Unmark last cycle as incomplete so it can be retried
          const lastCycleIndex = ctx.tracker.cycles.length - 1;
          if (lastCycleIndex >= 0) {
            ctx.tracker.cycles[lastCycleIndex].isCompleted = false;
          }
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

    // Capture runtime state for precise resumption
    const runtimeState: CheckpointRuntimeState = {
      executionPointer: [...ctx.runtime.executionPointer],
      loopStates: { ...ctx.runtime.loopStates },
    };

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
      runtimeState,
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
