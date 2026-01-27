// =============================================================================
// REASON MODULE
// =============================================================================
//
// This module is the decision-making engine.
//
// Features:
// - Zod validation for all LLM outputs (Type Safety)
// - Drift Analysis for Execute Mode (evaluateDrift)
// - Separation of Planning and Execution prompt construction
// - Robust error handling
//
// =============================================================================

import OpenAI from 'openai';
import { config } from 'dotenv';
import { z } from 'zod'; // Zod for runtime validation
import type {
  PageState,
  Goal,
  Preset,
  ResolvedConfig,
  StepResult,
  ThinkResult,
  SessionTracker,
  Action,
  ElementInfo,
  CycleStrategy
} from './types/index.js';
import { getCurrentCycleIndex } from './types/index.js';
import {
  buildExecutionPrompt,
  buildDriftAnalysisPrompt,
  buildStrategyPrompt,
  buildPlanGenerationPrompt,
  buildReplanPrompt,
  buildSimpleQuestionPrompt,
  type InterventionMetrics,
  type Intervention,
} from './prompt.js';
import { logPromptToFile } from './utils/debug.js';

// Re-export types from prompt.ts for backwards compatibility
export type { InterventionMetrics, Intervention } from './prompt.js';

// Load environment variables
config();

// -----------------------------------------------------------------------------
// ZOD SCHEMAS
// -----------------------------------------------------------------------------

const ActionSchema = z.object({
  type: z.enum(['click', 'type', 'scroll', 'navigate', 'wait', 'multi_click']),
  selector: z.string().optional(), // Index or selector for single actions
  selectors: z.array(z.string()).optional(), // Multiple indices for multi_click
  text: z.string().optional(),
  reason: z.string(),
});

const ThinkResultSchema = z.discriminatedUnion('resultType', [
  z.object({
    resultType: z.literal('ACTION'),
    action: ActionSchema,
    thinking: z.string().optional(),
  }),
  z.object({
    resultType: z.literal('GOAL_SUCCESS'),
    finalAnswer: z.string(),
    thinking: z.string().optional(),
  }),
  z.object({
    resultType: z.literal('FAIL'),
    error: z.string(),
    thinking: z.string().optional(),
  }),
  z.object({
    resultType: z.literal('REPLAN'),
    reason: z.string(),
    thinking: z.string().optional(),
  }),
  z.object({
    resultType: z.literal('RETRY_PERCEPTION'),
    thinking: z.string().optional(),
  }),
]);

const DriftAnalysisSchema = z.object({
  decision: z.enum(['can_proceed', 'cannot_complete']),
  reason: z.string(),
  adaptedAction: z.object({
    type: z.string(),
    selector: z.string().optional(),
    text: z.string().optional(),
    reason: z.string(),
  }).optional(),
});

export type DriftAnalysisResult = z.infer<typeof DriftAnalysisSchema>;

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// -----------------------------------------------------------------------------
// LLM CLIENT
// -----------------------------------------------------------------------------

export function createLLMClient(
  llmConfig?: Pick<ResolvedConfig, 'llmBaseUrl' | 'llmApiKey' | 'llmModel'>,
): OpenAI {
  const baseURL =
    llmConfig?.llmBaseUrl ||
    process.env.LLM_BASE_URL ||
    'http://localhost:11434/v1';
  const apiKey = llmConfig?.llmApiKey || process.env.LLM_API_KEY || 'ollama';

  return new OpenAI({
    baseURL,
    apiKey,
  });
}

export function getDefaultModel(): string {
  return process.env.LLM_MODEL || 'llama3.2';
}

// -----------------------------------------------------------------------------
// DRIFT ANALYSIS (EXECUTE MODE)
// -----------------------------------------------------------------------------

/**
 * Compare expected state vs. current state to decide if drift occurred.
 *
 * @param expectedState - The state recorded in the preset/cache
 * @param currentState - The actual current page state
 * @param plannedAction - The action we intended to take
 * @param client - LLM client
 */
export async function evaluateDrift(
  expectedState: PageState,
  currentState: PageState,
  plannedAction: Action,
  client: OpenAI
): Promise<DriftAnalysisResult> {
  const model = getDefaultModel();
  
  // Find the target element in expected state to give context
  const targetElement = expectedState.elements.find(e => e.selector === plannedAction.selector);
  const elementContext = targetElement 
      ? `Target Element: <${targetElement.tag}> "${targetElement.text}" (Selector: ${targetElement.selector})`
      : "Target Element not found in expected state record.";

  const { systemPrompt, userPrompt } = buildDriftAnalysisPrompt(
      expectedState, currentState, plannedAction, elementContext
  );

  try {
      const response = await client.chat.completions.create({
          model,
          messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1, // Very precise
          max_tokens: 500
      });

      const content = response.choices[0]?.message?.content || '{}';
      return DriftAnalysisSchema.parse(JSON.parse(content));

  } catch (error) {
      console.error('❌ Drift Analysis Failed:', String(error));
      // Fail-safe: If we can't evaluate drift, assume we cannot complete
      return { decision: 'cannot_complete', reason: 'Drift analysis failed - unable to verify page state' };
  }
}

// -----------------------------------------------------------------------------
// MAIN THINK FUNCTION
// -----------------------------------------------------------------------------

export async function think(
  pageState: PageState,
  goal: Goal | undefined,
  preset: Preset | undefined,
  tracker: SessionTracker,
  history: StepResult[],
  client: OpenAI,
  interventionMetrics: InterventionMetrics,
  intervention?: Intervention,
  customSystemPrompt?: string,
): Promise<ThinkResult> {
  const model = getDefaultModel();
  const verbose = process.env.VERBOSE === 'true';

  const { systemPrompt, situationPrompt, tokenStats } = buildExecutionPrompt(
    pageState,
    goal,
    preset,
    tracker,
    history,
    interventionMetrics,
    intervention,
    undefined, // limits
    customSystemPrompt,
  );

  // Always log prompts to trace file for debugging
  logPromptToFile('SYSTEM PROMPT', systemPrompt);
  logPromptToFile('SITUATION PROMPT', situationPrompt);
  logPromptToFile('TOKEN STATS', `Total: ${tokenStats.totalTokens} (System: ${tokenStats.systemTokens}, Situation: ${tokenStats.situationTokens})`);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: situationPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content || '{}';
    
    if (verbose) {
      console.log(`   Raw response: ${content.substring(0, 200)}...`);
    }

    // -------------------------------------------------------------------------
    // ZOD PARSING & VALIDATION
    // -------------------------------------------------------------------------
    const parsed = ThinkResultSchema.parse(JSON.parse(content));

    // Map Zod result back to internal ThinkResult (removes "thinking" field if needed or keeps it)
    // The Zod output is structuraly compatible with ThinkResult, but let's be explicit
    
    if (parsed.resultType === 'ACTION') {
        return {
            type: 'ACTION',
            action: parsed.action
        };
    }
    
    if (parsed.resultType === 'GOAL_SUCCESS') {
        return { type: 'GOAL_SUCCESS', finalAnswer: parsed.finalAnswer };
    }
    
    if (parsed.resultType === 'FAIL') {
        return { type: 'FAIL', error: parsed.error };
    }

    if (parsed.resultType === 'REPLAN') {
        return { type: 'REPLAN', reason: parsed.reason };
    }

    if (parsed.resultType === 'RETRY_PERCEPTION') {
        return { type: 'RETRY_PERCEPTION' };
    }
    
    throw new Error('Unreachable: Invalid Zod Parse Result');

  } catch (error) {
    if (verbose) {
        try {
            console.error('❌ RAW Error Object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        } catch {
            console.error('❌ RAW Error Object (Stringified):', String(error));
        }
    } else {
        console.error('❌ LLM/Reasoning Error:', error instanceof Error ? error.message : String(error));
    }
    
    if (error instanceof z.ZodError) {
        return {
            type: 'FAIL',
            error: `Invalid JSON format from LLM: ${error.message}`
        };
    }

    return {
      type: 'FAIL',
      error: `LLM API error: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    };
  }
}

// -----------------------------------------------------------------------------
// UTILITY: SIMPLE QUESTION
// -----------------------------------------------------------------------------

export async function askLLM(
  question: string,
  client: OpenAI,
): Promise<string> {
  const model = getDefaultModel();
  const { userPrompt } = buildSimpleQuestionPrompt(question); // Destructure to get userPrompt

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.7,
    max_tokens: 500,
  });

  return response.choices[0]?.message?.content || '';
}

// -----------------------------------------------------------------------------
// GENERATE PLAN (Initial + Replan)
// -----------------------------------------------------------------------------

export async function generatePlan(
  goal: Goal,
  client: OpenAI,
  existingPlan?: SessionTracker,
  replanReason?: string,
): Promise<SessionTracker> {
  const model = getDefaultModel();
  const now = new Date();

  let promptData: { systemPrompt: string; userPrompt: string };

  if (existingPlan && replanReason) {
    promptData = buildReplanPrompt(replanReason, existingPlan);
  } else {
    promptData = buildPlanGenerationPrompt(goal);
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
          { role: 'system', content: promptData.systemPrompt },
          { role: 'user', content: promptData.userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    const cycleCount = parsed.cycleCount || 1;
    const cycleDescription = parsed.cycleDescription || 'Complete the task';
    const goalSummary = parsed.goalSummary || goal.description;

    let cycles: SessionTracker['cycles'];

    if (existingPlan && replanReason) {
      const completedCycles = existingPlan.cycles.filter((c) => c.isCompleted);
      const remainingCount = Math.max(0, cycleCount - completedCycles.length);

      cycles = [
        ...completedCycles,
        ...Array.from({ length: remainingCount }, () => ({
          isCompleted: false,
          cycleSteps: [],
        })),
      ];
      
      const currentCycleIdx = getCurrentCycleIndex(existingPlan);
      if(currentCycleIdx >= 0 && currentCycleIdx < existingPlan.cycles.length){
          const currentCycle = existingPlan.cycles[currentCycleIdx];
          if(!currentCycle.isCompleted && cycles[completedCycles.length]){
              cycles[completedCycles.length].cycleSteps = currentCycle.cycleSteps;
          }
      }

    } else {
      cycles = Array.from({ length: cycleCount }, () => ({
        isCompleted: false,
        cycleSteps: [],
      }));
    }

    return {
      goalSummary,
      cycleDescription,
      cycles,
      startedAt: existingPlan?.startedAt || now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    };
  } catch {
    return {
      goalSummary: goal.description,
      cycleDescription: 'Complete the goal',
      cycles: [{ isCompleted: false, cycleSteps: [] }],
      startedAt: existingPlan?.startedAt || now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    };
  }
}

// -----------------------------------------------------------------------------
// VALIDATE SESSION PLAN
// -----------------------------------------------------------------------------

export function validateSessionPlan(tracker: SessionTracker): ValidationResult {
  const errors: string[] = [];

  if (!tracker.goalSummary || typeof tracker.goalSummary !== 'string' || tracker.goalSummary.trim() === '') {
    errors.push('goalSummary is required and must be a non-empty string');
  }

  if (!tracker.cycleDescription || typeof tracker.cycleDescription !== 'string' || tracker.cycleDescription.trim() === '') {
    errors.push('cycleDescription is required and must be a non-empty string');
  }

  if (!Array.isArray(tracker.cycles)) {
    errors.push('cycles must be an array');
  } else if (tracker.cycles.length === 0) {
    errors.push('cycles must contain at least one cycle');
  } else {
    // Basic structural check only
    tracker.cycles.forEach((cycle, idx) => {
      if (typeof cycle.isCompleted !== 'boolean') errors.push(`cycles[${idx}].isCompleted must be a boolean`);
    });
  }

  if (typeof tracker.startedAt !== 'string') errors.push('startedAt must be a string');
  if (typeof tracker.lastUpdatedAt !== 'string') errors.push('lastUpdatedAt must be a string');

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract a winning strategy from successful history.
 * Used for multi-cycle goals to improve subsequent cycles.
 */
export async function generateStrategy(
  history: StepResult[],
  client: OpenAI
): Promise<CycleStrategy | undefined> {
  const { systemPrompt, userPrompt } = buildStrategyPrompt(history);
  const model = getDefaultModel();

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content) as CycleStrategy;
  } catch (error) {
    console.error('Failed to generate strategy:', error);
    return undefined;
  }
}

