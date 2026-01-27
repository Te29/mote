// =============================================================================
// REASON HANDLER
// =============================================================================
// Handles the REASON state - asks the LLM what to do next.

import type {
  AgentState,
  AgentStateReason,
} from '../types/state-machine.js';
import type { AgentContext } from '../types/context.js';
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

    case 'FAIL':
      return {
        phase: 'CYCLE_END',
        cycleIndex: state.cycleIndex,
        result: 'FAILURE',
        detail: thinkResult.error,
      };

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
