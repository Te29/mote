// =============================================================================
// PLAN PREVIEW MODULE
// =============================================================================
//
// Handles PLAN_PREVIEW intervention where users can review and modify
// the generated session plan before execution begins.
//
// =============================================================================

import type { OpenAI } from 'openai';
import type { Goal, SessionTracker, EngagementMode } from '../types/index.js';
import { shouldIntervene, requestIntervention } from '../interaction.js';
import { logVariable } from '../utils/debug.js';
import * as reasonModule from '../reason.js';
import { createTraceProxy } from '../utils/debug.js';

const reasonProxy = createTraceProxy(reasonModule, 'Reason');

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/**
 * Result of plan preview intervention.
 */
export interface PlanPreviewResult {
  /** Whether to exit early (user quit) */
  shouldExit: boolean;

  /** Updated tracker if user modified the plan */
  updatedTracker?: SessionTracker;
}

// -----------------------------------------------------------------------------
// PLAN PREVIEW FUNCTION
// -----------------------------------------------------------------------------

/**
 * Handle PLAN_PREVIEW intervention if needed based on engagement mode.
 * Allows user to review, modify, or approve the generated plan.
 *
 * @param mode - Engagement mode (determines if intervention should occur)
 * @param goal - User goal (needed for regeneration)
 * @param tracker - Current session tracker
 * @param llmClient - LLM client for plan regeneration
 * @returns Plan preview result with exit status and updated tracker
 */
export async function handlePlanPreview(
  engagementMode: EngagementMode,
  goal: Goal | undefined,
  tracker: SessionTracker,
  llmClient: OpenAI
): Promise<PlanPreviewResult> {
  // Check if intervention is needed based on engagement mode
  if (!shouldIntervene(engagementMode, 'PLAN_PREVIEW')) {
    return {
      shouldExit: false,
      updatedTracker: tracker,
    };
  }

  // Request user intervention
  const response = await requestIntervention('PLAN_PREVIEW', { plan: tracker });

  // Handle quit
  if (response.type === 'quit') {
    return {
      shouldExit: true,
    };
  }

  // Handle modify - regenerate plan with user instruction
  if (response.type === 'modify' && goal) {
    console.log('🔄 Regenerating plan based on user instruction...');
    const modifiedGoal: Goal = {
      ...goal,
      description: `${goal.description}\n\nUser instruction: ${response.instruction}`,
    };
    const updatedTracker = await reasonProxy.generatePlan(modifiedGoal, llmClient);
    logVariable('SESSION PLAN (MODIFIED)', updatedTracker);

    return {
      shouldExit: false,
      updatedTracker,
    };
  }

  // Handle approve or other responses - continue with existing plan
  return {
    shouldExit: false,
    updatedTracker: tracker,
  };
}
