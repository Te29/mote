// =============================================================================
// REASON HANDLER
// =============================================================================
// Handles the REASON state - asks the LLM what to do next.

import type {
  AgentState,
  AgentStateReason,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import type { Action, WebAction } from '../types/actions.js';
import { createTimestamp } from '../types/session.js';
import { logVariable } from '../utils/debug.js';
import { shouldIntervene, requestIntervention, processInterventionControl } from '../interaction.js';

// -----------------------------------------------------------------------------
// REASON
// -----------------------------------------------------------------------------

/**
 * Handle the REASON state.
 * Calls the reason service to decide next action, then transitions accordingly.
 */
export async function handleReason(
  state: AgentStateReason,
  ctx: AgentContext,
): Promise<AgentState> {
  // ---------------------------------------------------------------------------
  // EXECUTION PATH LOGIC (Fast Path)
  // ---------------------------------------------------------------------------
  // If we have a preset execution path, we prioritize following it.
  // There are only two outcomes:
  // 1. Elements match exactly -> Use cached action (No LLM)
  // 2. Elements don't match -> Drift Analysis -> Adapt or Terminate
  
  if (
    ctx.executionPath &&
    ctx.runtime.currentExecutionStepIndex < ctx.executionPath.length
  ) {
    const currentStep = ctx.executionPath[ctx.runtime.currentExecutionStepIndex];
    const { targetElementSelector, expectedPageState, action: cachedAction } = currentStep;

    console.log(`⚡ Checking Execution Path (Step ${ctx.runtime.currentExecutionStepIndex + 1}/${ctx.executionPath.length})`);

    // ----------------------
    // 0. USER INTERVENTION CHECK
    // ----------------------
    // If the user interrupted and provided an instruction (e.g. "Do X instead"),
    // we treat this as a FORCED ADAPTATION. We execute the user's wish *instead*
    // of the cached step, effectively "adapting" the path at this point.
    
    if (ctx.runtime.pendingUserInstruction) {
       console.log(`🗣️ Handling User Instruction: "${ctx.runtime.pendingUserInstruction}"`);
       
       // Use LLM to translate natural language instruction into an Action
       const adaptationResult = await ctx.services.reason.think(
          state.pageState,
          ctx.goal,
          ctx.preset,
          ctx.tracker,
          ctx.history,
          ctx.services.llmClient,
          ctx.interventionMetrics,
          {
             point: 'REPLAN', // Using REPLAN context implies "Change of plans"
             previousResult: { type: 'REPLAN', reason: 'User Intervention' }, // Dummy prev result
             instruction: ctx.runtime.pendingUserInstruction
          },
          ctx.customSystemPrompt
       );

       // Clear the pending instruction
       ctx.runtime.pendingUserInstruction = undefined;

       if (adaptationResult.type === 'ACTION') {
          console.log(`🛠️ User-adapted action: ${adaptationResult.action.reason}`);
          ctx.runtime.hadAdaptations = true;
          return {
            phase: 'ACT',
            cycleIndex: state.cycleIndex,
            action: adaptationResult.action,
            pageState: state.pageState,
          };
       }
       
       // If LLM couldn't generate an action (e.g. it wanted to replan or failed),
       // we fall back to standard behavior (which might be Drift Analysis or Full Think).
       // However, since the user *explicitly* asked for something, falling back to 
       // the cached path (which they interrupted) seems wrong.
       // We should probably treat non-Action results as "Path Broken" -> Full Think?
       // For now, let's fall through to the standard path check.
       console.warn('⚠️ User instruction did not result in an immediate action. Falling back to standard flow.');
    }

    // ----------------------
    // 1. EXACT MATCH CHECK
    // ----------------------
    // CODE-LEVEL CHECK: Does the target element exist in current page state?
    const targetFound = state.pageState.elements.some(
      (el) => el.selector === targetElementSelector
    );

    if (targetFound) {
      console.log(`✓ Exact match found for selector: ${targetElementSelector}`);
      return {
        phase: 'ACT',
        cycleIndex: state.cycleIndex,
        action: cachedAction,
        pageState: state.pageState,
      };
    }

    // ----------------------
    // 1b. ALTERNATIVE SELECTOR CHECK
    // ----------------------
    // Before expensive LLM drift analysis, check if any element on the page
    // has the target selector as one of its alternatives, or if the expected
    // element's alternatives match any current element's primary selector.
    const altMatch = state.pageState.elements.find(
      (el) => el.alternativeSelectors?.includes(targetElementSelector)
    );

    if (altMatch) {
      console.log(`🔄 Target found via alternative selector on element [${altMatch.index}]: ${altMatch.selector}`);
      // Update the cached action to use the matched element's index
      const adaptedAction: Action = {
        ...cachedAction,
        selector: String(altMatch.index),
      };
      // Update execution path in-memory for self-healing persistence
      currentStep.targetElementSelector = altMatch.selector;
      currentStep.action = adaptedAction;
      ctx.runtime.hadAdaptations = true;
      return {
        phase: 'ACT',
        cycleIndex: state.cycleIndex,
        action: adaptedAction,
        pageState: state.pageState,
      };
    }

    // Also check: does the expected element exist in the cached state with alternatives,
    // and does any of those alternatives match a current page element?
    const expectedElement = expectedPageState.elements.find(
      (el) => el.selector === targetElementSelector
    );
    if (expectedElement?.alternativeSelectors) {
      for (const altSelector of expectedElement.alternativeSelectors) {
        const match = state.pageState.elements.find(
          (el) => el.selector === altSelector || el.alternativeSelectors?.includes(altSelector)
        );
        if (match) {
          console.log(`🔄 Target found via expected element's alternative: ${altSelector} → element [${match.index}]`);
          const adaptedAction: Action = {
            ...cachedAction,
            selector: String(match.index),
          };
          currentStep.targetElementSelector = match.selector;
          currentStep.action = adaptedAction;
          ctx.runtime.hadAdaptations = true;
          return {
            phase: 'ACT',
            cycleIndex: state.cycleIndex,
            action: adaptedAction,
            pageState: state.pageState,
          };
        }
      }
    }

    // DRIFT ANALYSIS: Elements don't match, verify if we can adapt
    console.log(`⚠️ Target mismatch (primary + alternatives). Analyzing drift...`);
    const driftResult = await ctx.services.reason.evaluateDrift(
      expectedPageState,
      state.pageState,
      cachedAction,
      ctx.services.llmClient
    );

    // BINARY DECISION: Adapt, Fallback, or Terminate
    if (driftResult.decision === 'technical_error') {
      console.warn(`⚠️ Drift Analysis Technical Failure: ${driftResult.reason}. Falling back to autonomous reasoning.`);
      ctx.executionPath = undefined;
      // We fall through to the full LLM reasoning logic below
    } else if (driftResult.decision === 'cannot_complete') {
      const message = `Execution path broken: ${driftResult.reason}. Please exit and generate a new preset for this stage.`;
      console.error(`❌ ${message}`);
      return {
        phase: 'TERMINATED',
        success: false,
        message,
      };
    } else if (driftResult.decision === 'can_proceed') {
      if (driftResult.adaptedAction) {
        console.log(`🛠️ Adapted action: ${driftResult.reason}`);
        ctx.runtime.hadAdaptations = true;

        const adaptedAction: Action = {
          type: driftResult.adaptedAction.type as WebAction,
          selector: driftResult.adaptedAction.selector,
          text: driftResult.adaptedAction.text,
          reason: driftResult.adaptedAction.reason,
        };

        // Update execution path in-memory so self-healing persists for save
        currentStep.action = adaptedAction;
        if (adaptedAction.selector) {
          currentStep.targetElementSelector = adaptedAction.selector;
        }

        return {
          phase: 'ACT',
          cycleIndex: state.cycleIndex,
          action: adaptedAction,
          pageState: state.pageState,
        };
      } else {
        // No adaptation needed (minor drift but same action valid)
        console.log(`✓ Drift accepted, proceeding with cached action: ${driftResult.reason}`);
        return {
          phase: 'ACT',
          cycleIndex: state.cycleIndex,
          action: cachedAction,
          pageState: state.pageState,
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // REASONING LOGIC (LLM)
  // ---------------------------------------------------------------------------
  // Fallback to full LLM reasoning if no execution path exists or path is finished.

  // Log when execution path has been fully consumed
  if (
    ctx.executionPath &&
    ctx.runtime.currentExecutionStepIndex >= ctx.executionPath.length
  ) {
    console.log(`✅ Execution path completed (${ctx.executionPath.length} steps). Switching to LLM reasoning.`);
  }

  const thinkResult = await ctx.services.reason.think(
    state.pageState,
    ctx.goal,
    ctx.preset,
    ctx.tracker,
    ctx.history,
    ctx.services.llmClient,
    ctx.interventionMetrics,
    undefined, // intervention
    ctx.customSystemPrompt,
  );

  switch (thinkResult.type) {
    case 'ACTION':
      return {
        phase: 'ACT',
        cycleIndex: state.cycleIndex,
        action: thinkResult.action,
        pageState: state.pageState,
      };

    case 'GOAL_SUCCESS':
      return {
        phase: 'CYCLE_END',
        cycleIndex: state.cycleIndex,
        result: 'SUCCESS',
        detail: thinkResult.finalAnswer,
      };

    case 'FAIL': {
      // Parse errors (LLM returned garbage after retries) get an intervention opportunity
      if (thinkResult.isParseError && shouldIntervene(ctx.engagementMode, 'ERROR')) {
        const response = await requestIntervention('ERROR', {
          plan: ctx.tracker,
          error: thinkResult.error,
          cycleIndex: state.cycleIndex,
        });
        const control = processInterventionControl(response);
        if (control.action === 'continue' || control.action === 'skip') {
          // Re-observe and try again
          return { phase: 'OBSERVE', cycleIndex: state.cycleIndex };
        }
        if (control.action === 'succeed') {
          return {
            phase: 'TERMINATED',
            success: true,
            message: control.message || 'Forced success at LLM error',
          };
        }
        // terminate or other → fall through to CYCLE_END
      }
      return {
        phase: 'CYCLE_END',
        cycleIndex: state.cycleIndex,
        result: 'FAILURE',
        detail: thinkResult.error,
      };
    }

    case 'REPLAN': {
      const reason = thinkResult.reason;
      
      // REPLAN INTERVENTION
      if (shouldIntervene(ctx.engagementMode, 'REPLAN')) {
        const response = await requestIntervention('REPLAN', {
          plan: ctx.tracker,
          thinkResult: { type: 'REPLAN', reason },
          cycleIndex: state.cycleIndex,
        });

        logVariable('INTERVENTION RESPONSE (REPLAN)', {
          responseType: response.type,
          instruction: 'instruction' in response ? response.instruction : null,
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
            message: control.message || 'Forced success at replan',
          };
        }

        if (control.action === 'skip') {
          return { phase: 'OBSERVE', cycleIndex: state.cycleIndex };
        }

        if (control.action === 'modify') {
          if (ctx.goal) {
            const newPlan = await ctx.services.reason.generatePlan(
              ctx.goal,
              ctx.services.llmClient,
              ctx.tracker,
              control.instruction
            );
            Object.assign(ctx.tracker, newPlan);
            logVariable('SESSION PLAN (REPLAN MODIFIED)', ctx.tracker);
          }
          ctx.interventionMetrics.replanCount++;
          return { phase: 'OBSERVE', cycleIndex: state.cycleIndex };
        }

        if (response.type === 'reject') {
          // User rejected replan - try different action
          const newResult = await ctx.services.reason.think(
            state.pageState,
            ctx.goal,
            ctx.preset,
            ctx.tracker,
            ctx.history,
            ctx.services.llmClient,
            ctx.interventionMetrics,
            {
              point: 'REPLAN',
              previousResult: { type: 'REPLAN', reason },
              instruction: "Don't replan. Continue with current approach.",
            }
          );
          if (newResult.type === 'ACTION') {
            return {
              phase: 'ACT',
              cycleIndex: state.cycleIndex,
              action: newResult.action,
              pageState: state.pageState,
            };
          }
          // Fall through to replan anyway if not ACTION
        }
      }

      // Regenerate the plan
      ctx.interventionMetrics.replanCount++;
      const newGoal = ctx.goal || { name: 'Task', description: 'Complete the task' };
      ctx.tracker = await ctx.services.reason.generatePlan(
        newGoal,
        ctx.services.llmClient,
        ctx.tracker,
        thinkResult.reason,
      );
      ctx.tracker.lastUpdatedAt = createTimestamp();

      // Go back to OBSERVE with updated plan
      return {
        phase: 'OBSERVE',
        cycleIndex: state.cycleIndex,
      };
    }

    case 'RETRY_PERCEPTION':
      // REPERCEIVE INTERVENTION
      if (shouldIntervene(ctx.engagementMode, 'REPERCEIVE')) {
        const response = await requestIntervention('REPERCEIVE', {
          plan: ctx.tracker,
          cycleIndex: state.cycleIndex,
          pageState: state.pageState,
        });
        
        logVariable('INTERVENTION RESPONSE (REPERCEIVE)', {
          responseType: response.type,
          reobserveCount: ctx.interventionMetrics.reobserveCount,
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
            message: control.message || 'Forced success at reperceive',
          };
        }

        // Reject/Skip/Modify: Don't re-observe, try to continue with current state
        if (control.action === 'skip' || response.type === 'reject') {
          return { phase: 'OBSERVE', cycleIndex: state.cycleIndex };
        }
      }

      ctx.interventionMetrics.reobserveCount++;
      return {
        phase: 'OBSERVE',
        cycleIndex: state.cycleIndex,
      };

    default:
      return {
        phase: 'TERMINATED',
        success: false,
        message: `Unknown think result type: ${(thinkResult as any).type}`,
      };
  }
}
