// =============================================================================
// REASON HANDLER
// =============================================================================
// Handles the REASON state - asks the LLM what to do next.

import type {
  AgentState,
  AgentStateReason,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
import type { Action, WebAction, StepPlan } from '../types/actions.js';
import { createTimestamp } from '../types/session.js';
import { logVariable } from '../utils/debug.js';
import { shouldIntervene, requestIntervention, processInterventionControl } from '../interaction.js';
import { executeVerification } from '../utils/verification.js';

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
  // CYCLE PLAN LOGIC (Fast Path & Blueprint)
  // ---------------------------------------------------------------------------
  // If we have a preset cycle plan (Blueprint), we follow it.
  // There are only two outcomes:
  // 1. Elements match exactly -> Use cached action (No LLM)
  // 2. Elements don't match -> Drift Analysis -> Adapt or Terminate
  //
  // Supports linear steps and basic loops via executionPointer.

  if (ctx.cyclePlan && ctx.runtime.executionPointer) {
    const ptr = ctx.runtime.executionPointer;
    const unitIndex = ptr[0];
    
    // Safety check
    if (unitIndex < ctx.cyclePlan.units.length) {
      const unit = ctx.cyclePlan.units[unitIndex];
      let currentStep: StepPlan | null = null;

      // 1. RESOLVE CURRENT STEP (Handle Loops)
      if (unit.type === 'step') {
        currentStep = unit.step;
      } else if (unit.type === 'loop') {
        // Basic Loop Support: Check where we are in the loop
        if (ptr.length === 1) {
          // Just entered loop - Initialize
          console.log(`🔄 Entering Loop [${unit.loop.loopId}]`);
          ptr.push(0); // Start at step 0
        }
        
        const loopStepIndex = ptr[1];
        if (loopStepIndex < unit.loop.steps.length) {
          currentStep = unit.loop.steps[loopStepIndex];
        } else {
          // End of loop iteration
          const loopId = unit.loop.loopId;
          const currentIteration = ctx.runtime.loopStates[loopId]?.iteration || 1;
          console.log(`🔄 Loop [${loopId}] iteration ${currentIteration} complete.`);

          let shouldContinue = false;

          // 1. Check Fixed Iterations
          if (unit.loop.iterations) {
            if (currentIteration < unit.loop.iterations) {
              shouldContinue = true;
            } else {
              console.log(`🛑 Max fixed iterations (${unit.loop.iterations}) reached.`);
            }
          } 
          
          // 2. Check Dynamic Condition (script-based verification)
          if (unit.loop.loopCondition) {
            const cond = unit.loop.loopCondition;

            // Safety Break
            const maxSafety = cond.maxIterations || 100;
            if (currentIteration >= maxSafety) {
              console.warn(`🛑 Safety limit (${maxSafety}) reached for dynamic loop.`);
              shouldContinue = false;
            } else {
              // Execute script-based verification
              const verifyResult = await executeVerification(
                ctx.runtime.activePage,
                cond.verification,
                {
                  pageState: state.pageState,
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

              shouldContinue = verifyResult.passed;
              console.log(`❓ Loop condition (${cond.verification.description || 'verification'}) = ${verifyResult.passed} [${verifyResult.method}]`);
              if (verifyResult.error) {
                console.log(`   Error: ${verifyResult.error}`);
              }
            }
          }

          if (shouldContinue) {
             console.log(`🔄 Continuing loop [${loopId}] -> Iteration ${currentIteration + 1}`);
             ctx.runtime.loopStates[loopId] = { iteration: currentIteration + 1 };
             ptr[1] = 0; // Reset to first step of loop
             // Recursive call to execute first step immediately
             return handleReason(state, ctx);
          } else {
            console.log(`✅ Loop complete. Exiting.`);
            // Cleanup state? Keep for history?
            // delete ctx.runtime.loopStates[loopId]; 
            ptr.pop(); // Remove step index
            ptr[0]++;  // Advance unit index
            // Recursive call to next unit
            return handleReason(state, ctx);
          }
        }
      }

      if (currentStep) {
        const { targetElementSelector: cssSelector, expectedPageState, action: cachedAction, stepId } = currentStep;
        
        console.log(`⚡ Checking Blueprint Step: ${currentStep.description} [${stepId}]`);

        // ----------------------
        // 0. USER INTERVENTION / FORCED ADAPTATION
        // ----------------------
        if (ctx.runtime.pendingUserInstruction) {
           console.log(`🗣️ Handling User Instruction: "${ctx.runtime.pendingUserInstruction}"`);
           
           // Perform adaptation reasoning
           const adaptationResult = await ctx.services.reason.think(
              state.pageState,
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
                point: 'REPLAN',
                previousResult: { type: 'REPLAN', reason: 'User Intervention' },
                instruction: ctx.runtime.pendingUserInstruction
              },
              ctx.customSystemPrompt
           );
    
           ctx.runtime.pendingUserInstruction = undefined;
    
           if (adaptationResult.type === 'ACTION') {
              console.log(`🛠️ User-adapted action: ${adaptationResult.action.reason}`);
              ctx.runtime.hadAdaptations = true;
              return {
                phase: 'ACT',
                cycleIndex: state.cycleIndex,
                action: adaptationResult.action,
                pageState: state.pageState,
                stepId, 
                globalIndex: unitIndex
              };
           }
           if (adaptationResult.type === 'REPLAN') {
              // User instruction triggered a replan
              return { phase: 'OBSERVE', cycleIndex: state.cycleIndex };
           }
           console.warn('⚠️ User instruction did not result in immediate action, falling back to blueprint.');
        }

        // ----------------------
        // 1. IF STEP HAS NO ACTION (Verify/Wait)
        // ----------------------
        if (!cachedAction) {
           console.log(`ℹ️ Step has no cached action. Performing verification/wait.`);
           // If verification passes (implied by reaching here in strict mode, or check expectedPageState)
           // Return a wait action to complete the step.
           return {
              phase: 'ACT',
              cycleIndex: state.cycleIndex,
              action: { type: 'wait', reason: currentStep.description || 'Verified step' },
              pageState: state.pageState,
              stepId, 
              globalIndex: unitIndex
           };
        }

        // ----------------------
        // 2. TARGET RESOLUTION (If selector exists)
        // ----------------------
        if (cssSelector) {
           // A. EXACT MATCH
           const targetFound = state.pageState.elements.some((el) => el.selector === cssSelector);
           if (targetFound) {
              console.log(`✓ Exact match: ${cssSelector}`);
              return {
                phase: 'ACT',
                cycleIndex: state.cycleIndex,
                action: cachedAction,
                pageState: state.pageState,
                stepId, 
                globalIndex: unitIndex
              };
           }

           // B. ALTERNATIVE MATCH (Simplified from previous)
           const altMatch = state.pageState.elements.find((el) => el.alternativeSelectors?.includes(cssSelector));
           if (altMatch) {
              console.log(`🔄 Alt match: ${altMatch.selector}`);
              const adaptedAction: Action = { ...cachedAction, elementId: String(altMatch.index) };
              // Self-healing: Update blueprint in-memory
              currentStep.targetElementSelector = altMatch.selector;
              // Reset action elementId? cachedAction might have old one. 
              // Important: We don't save back to file yet, just runtime patch.
              ctx.runtime.hadAdaptations = true;
              return {
                phase: 'ACT',
                cycleIndex: state.cycleIndex,
                action: adaptedAction,
                pageState: state.pageState,
                stepId, 
                globalIndex: unitIndex
              };
            }
        
            // C. DRIFT MATCH (Check expectedPageState if available)
            if (expectedPageState) {
                 console.log(`⚠️ Target mismatch. Analyzing drift for step ${stepId}...`);
                 const driftResult = await ctx.services.reason.evaluateDrift(
                   expectedPageState,
                   state.pageState,
                   cachedAction,
                   ctx.services.llmClient
                 );

                 if (driftResult.decision === 'can_proceed') {
                    const finalAction = driftResult.adaptedAction 
                        ? { ...driftResult.adaptedAction, type: driftResult.adaptedAction.type as WebAction }
                        : cachedAction;
                        
                    if (driftResult.adaptedAction) {
                       ctx.runtime.hadAdaptations = true;
                       // Self-healing
                       if (finalAction.elementId) {
                          const matchedEl = state.pageState.elements.find(e => String(e.index) === finalAction.elementId);
                          if (matchedEl) currentStep.targetElementSelector = matchedEl.selector;
                       }
                    }
                    
                    return {
                      phase: 'ACT',
                      cycleIndex: state.cycleIndex,
                      action: finalAction,
                      pageState: state.pageState,
                      stepId, 
                      globalIndex: unitIndex
                    };
                 } else if (driftResult.decision === 'cannot_complete') {
                    // Fail
                    return { phase: 'TERMINATED', success: false, message: `Path broken: ${driftResult.reason}` };
                 }
                 // If technical_error, fall trough to Full Reasoning
            } 
            // If no expectedPageState, we can't do drift analysis. Fall through to Full Reasoning.
        } else {
           // Action but no selector (e.g. Scroll, Navigation, Wait)
           // Execute unconditionally
           return {
              phase: 'ACT',
              cycleIndex: state.cycleIndex,
              action: cachedAction,
              pageState: state.pageState,
              stepId, 
              globalIndex: unitIndex
           };
        }
      }
    } else {
       // Unit index out of bounds - Path Complete
       console.log(`✅ Execution path completed. Switching to LLM reasoning.`);
    }
  }

  // ---------------------------------------------------------------------------
  // REASONING LOGIC (LLM)
  // ---------------------------------------------------------------------------
  // Standard LLM fallback...

  const thinkResult = await ctx.services.reason.think(
    state.pageState,
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

    case 'GOAL_SUCCESS': {
      // Check if cycle has verification configured
      if (ctx.cyclePlan?.verification) {
        console.log(`🔍 Verifying cycle completion...`);

        const verifyResult = await executeVerification(
          ctx.runtime.activePage,
          ctx.cyclePlan.verification,
          {
            pageState: state.pageState,
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
          console.log(`❌ Cycle verification failed: ${verifyResult.detail}`);

          // Verification failed - continue working
          return {
            phase: 'OBSERVE',
            cycleIndex: state.cycleIndex,
          };
        }

        console.log(`✅ Cycle verification passed [${verifyResult.method}]: ${verifyResult.detail}`);
      }

      // Verification passed or not configured - mark cycle complete
      return {
        phase: 'CYCLE_END',
        cycleIndex: state.cycleIndex,
        result: 'SUCCESS',
        detail: thinkResult.finalAnswer,
      };
    }

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
              tokenMarkdown: ctx.tokenMarkdown,
              tokenElements: ctx.tokenElements,
              tokenMaxElements: ctx.tokenMaxElements,
              tokenHistory: ctx.tokenHistory,
            },
            {
              point: 'REPLAN',
              previousResult: { type: 'REPLAN', reason },
              instruction: "Don't replan. Continue with current approach.",
            },
            ctx.customSystemPrompt,
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
