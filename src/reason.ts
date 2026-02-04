// =============================================================================
// REASON MODULE
// =============================================================================
//
// This module is the decision-making engine.
//
// Features:
// - Zod validation for all LLM outputs (Type Safety)
// - Drift Analysis for execution paths (evaluateDrift)
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
  SessionPlan,
  Action,
  CycleStrategy
} from './types/index.js';
import { getCurrentCycleIndex, createTimestamp } from './types/index.js';
import {
  buildExecutionPrompt,
  buildDriftAnalysisPrompt,
  buildStrategyPrompt,
  buildPlanGenerationPrompt,
  buildReplanPrompt,
  buildSimpleQuestionPrompt,
  type InterventionMetrics,
  type Intervention,
  type PromptTokenLimits,
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
  type: z.enum(['click', 'type', 'scroll', 'navigate', 'wait', 'hover', 'select', 'checkbox', 'drag', 'multi_click']),
  elementId: z.string().optional(), // Index or selector for single actions
  elementIds: z.array(z.string()).optional(), // Multiple indices for multi_click
  text: z.string().optional(),
  reason: z.string(),
});

const PlanResultSchema = z.object({
  cycleCount: z.number().optional().default(1),
  cycleDescription: z.string().optional().default('Complete the task'),
  goalSummary: z.string().optional(),
});

const CycleStrategySchema = z.object({
  pattern: z.string(),
  stepSequence: z.array(z.string()),
  keyElements: z.array(z.string()),
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
    elementId: z.string().optional(),
    text: z.string().optional(),
    reason: z.string(),
  }).optional(),
});

// Extends the Zod-inferred type with 'technical_error', a code-level fallback
// that should never be produced by the LLM itself.
export type DriftAnalysisResult = z.infer<typeof DriftAnalysisSchema> | {
  decision: 'technical_error';
  reason: string;
  adaptedAction?: undefined;
};

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
  llmConfig?: Pick<ResolvedConfig, 'llmBaseUrl' | 'llmApiKey' | 'llmModel' | 'llmTimeout'>,
): OpenAI {
  const baseURL =
    llmConfig?.llmBaseUrl ||
    process.env.LLM_BASE_URL ||
    'http://localhost:11434/v1';
  const apiKey = llmConfig?.llmApiKey || process.env.LLM_API_KEY || 'ollama';
  const timeout = llmConfig?.llmTimeout || 60000;

  return new OpenAI({
    baseURL,
    apiKey,
    timeout,
  });
}

export function getDefaultModel(): string {
  return process.env.LLM_MODEL || 'llama3.2';
}

/**
 * Internal helper to execute an LLM call with built-in retries and Zod validation.
 */
async function executeLLM<T>(
  client: OpenAI,
  schema: z.ZodSchema<T>,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'json_object' | 'text';
    retries?: number;
    verbose?: boolean;
    onRetry?: (error: any, attempt: number) => void;
  } = {}
): Promise<T> {
  const model = options.model || getDefaultModel();
  const retries = options.retries ?? 3;
  const temperature = options.temperature ?? 0.2;
  const maxTokens = options.maxTokens ?? 500;
  const responseFormat = options.responseFormat ?? 'json_object';
  const verbose = options.verbose ?? process.env.VERBOSE === 'true';

  // Clone messages to avoid mutating the caller's array across retries
  const messageHistory = [...messages];
  let lastError: any = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: messageHistory,
        response_format: { type: responseFormat },
        temperature,
        max_tokens: maxTokens,
      });

      const content = response.choices[0]?.message?.content;

      logPromptToFile('LLM RESPONSE', content ?? '(empty)');

      // Guard: treat empty/null LLM responses as errors to avoid
      // schemas with optional defaults silently accepting '{}'
      if (!content || content.trim() === '' || content.trim() === '{}') {
        throw new Error('LLM returned empty or no content');
      }

      let parsed: any;
      if (responseFormat === 'json_object') {
        parsed = JSON.parse(content);
      } else {
        parsed = content;
      }

      return schema.parse(parsed);

    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        if (options.onRetry) options.onRetry(error, attempt);
        const errorMsg = error instanceof z.ZodError 
          ? 'Validation failed' 
          : (error instanceof Error ? error.message : String(error));
        
        if (verbose) {
          console.warn(`    ⚠️ LLM attempt ${attempt}/${retries} failed (${errorMsg}), retrying...`);
        }

        // If it was a ZodError or JSON parse error, we provide feedback for self-correction
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
          messageHistory.push({
            role: 'assistant',
            content: lastError instanceof Error ? lastError.message : 'Invalid response format.'
          });
          messageHistory.push({
            role: 'user',
            content: `Your previous response failed validation: ${error.message}. Please correct the JSON and try again.`
          });
        }
      }
    }
  }

  throw lastError;
}

// -----------------------------------------------------------------------------
// DRIFT ANALYSIS (With preset and execution path)
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
  const targetElement = expectedState.elements.find(e => String(e.index) === plannedAction.elementId);
  const elementContext = targetElement 
      ? `Target Element: <${targetElement.tag}> "${targetElement.text}" (Selector: ${targetElement.selector})`
      : "Target Element not found in expected state record.";

  const { systemPrompt, userPrompt } = buildDriftAnalysisPrompt(
      expectedState, currentState, plannedAction, elementContext
  );

  try {
      return await executeLLM(client, DriftAnalysisSchema, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
      ], { temperature: 0.1 });

  } catch (error) {
      console.error('❌ Drift Analysis Failed after retries:', String(error));
      return { 
          decision: 'technical_error', 
          reason: `LLM technical failure: ${error instanceof Error ? error.message : String(error)}` 
      };
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
  limits: PromptTokenLimits,
  intervention?: Intervention,
  customSystemPrompt?: string,
): Promise<ThinkResult> {
  const verbose = process.env.VERBOSE === 'true';

  const { systemPrompt, situationPrompt, tokenStats } = buildExecutionPrompt(
    pageState,
    goal,
    preset,
    tracker,
    history,
    interventionMetrics,
    limits,
    intervention,
    customSystemPrompt,
  );

  // Always log prompts to trace file for debugging
  logPromptToFile('SYSTEM PROMPT', systemPrompt);
  logPromptToFile('SITUATION PROMPT', situationPrompt);
  logPromptToFile('TOKEN STATS', `Total: ${tokenStats.totalTokens} (System: ${tokenStats.systemTokens}, Situation: ${tokenStats.situationTokens})`);

  try {
    const parsed = await executeLLM(client, ThinkResultSchema, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: situationPrompt },
    ], {
      onRetry: () => {
        interventionMetrics.llmParseFailures++;
      }
    });

    // Map Zod result back to internal ThinkResult
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
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (verbose) {
      console.error('❌ LLM/Reasoning Error after retries:', errorMsg);
    } else {
      console.error('LLM/Reasoning Error:', errorMsg);
    }

    if (error instanceof z.ZodError) {
      return {
        type: 'FAIL',
        error: `Invalid JSON format from LLM after retries: ${error.message}`,
        isParseError: true,
      };
    }

    return {
      type: 'FAIL',
      error: `LLM API error after retries: ${error instanceof Error ? error.message : 'Unknown error'}`,
      isParseError: true,
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
  const { systemPrompt, userPrompt } = buildSimpleQuestionPrompt(question);

  try {
    return await executeLLM(client, z.string().min(1), [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], {
      temperature: 0.7,
      responseFormat: 'text',
      retries: 2,
    });
  } catch (error) {
    console.error('askLLM failed:', error instanceof Error ? error.message : String(error));
    return '';
  }
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
  const now = new Date();

  let promptData: { systemPrompt: string; userPrompt: string };

  if (existingPlan && replanReason) {
    promptData = buildReplanPrompt(replanReason, existingPlan);
  } else {
    promptData = buildPlanGenerationPrompt(goal);
  }

  try {
    const parsed = await executeLLM(client, PlanResultSchema, [
      { role: 'system', content: promptData.systemPrompt },
      { role: 'user', content: promptData.userPrompt }
    ], { temperature: 0.3, maxTokens: 300 });

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
  } catch (error) {
    console.error('❌ Plan Generation Failed after retries:', error);
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
// VALIDATE SESSION PLAN (Blueprint from preset)
// -----------------------------------------------------------------------------

export function validateSessionPlan(plan: SessionPlan | SessionTracker): ValidationResult {
  const errors: string[] = [];

  // Validate required metadata
  if (!plan.goalSummary || typeof plan.goalSummary !== 'string' || plan.goalSummary.trim() === '') {
    errors.push('goalSummary is required and must be a non-empty string');
  }

  if (!plan.cycleDescription || typeof plan.cycleDescription !== 'string' || plan.cycleDescription.trim() === '') {
    errors.push('cycleDescription is required and must be a non-empty string');
  }

  // Validate cyclePlan (for SessionPlan) or cycles (for SessionTracker)
  if ('cyclePlan' in plan) {
    // SessionPlan validation
    if (!plan.cyclePlan) {
      errors.push('cyclePlan is required');
    } else {
      if (!Array.isArray(plan.cyclePlan.units)) {
        errors.push('cyclePlan.units must be an array');
      } else if (plan.cyclePlan.units.length === 0) {
        errors.push('cyclePlan.units must contain at least one unit');
      }
    }
  } else if ('cycles' in plan) {
    // SessionTracker validation
    if (!Array.isArray(plan.cycles)) {
      errors.push('cycles must be an array');
    } else if (plan.cycles.length === 0) {
      errors.push('cycles must contain at least one cycle');
    }
  } else {
    errors.push('Either cyclePlan or cycles is required');
  }

  // Validate setupSteps if present
  if (plan.setupSteps && !Array.isArray(plan.setupSteps)) {
    errors.push('setupSteps must be an array');
  }

  // Validate wrapupSteps if present
  if (plan.wrapupSteps && !Array.isArray(plan.wrapupSteps)) {
    errors.push('wrapupSteps must be an array');
  }

  // Validate numberOfCycles if present (SessionPlan only)
  if ('numberOfCycles' in plan && plan.numberOfCycles !== undefined) {
    if (typeof plan.numberOfCycles !== 'number') {
      errors.push('numberOfCycles must be a number');
    } else if (plan.numberOfCycles !== -1 && plan.numberOfCycles < 1) {
      errors.push('numberOfCycles must be -1 (unlimited) or >= 1');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// -----------------------------------------------------------------------------
// VALIDATE SESSION TRACKER (Runtime execution state)
// -----------------------------------------------------------------------------

export function validateSessionTracker(tracker: SessionTracker): ValidationResult {
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

// -----------------------------------------------------------------------------
// CONVERT SESSION PLAN TO TRACKER
// -----------------------------------------------------------------------------

/**
 * Convert SessionPlan (blueprint) to SessionTracker (runtime state).
 * Initializes empty execution tracking based on the plan structure.
 *
 * @param sessionPlan - The blueprint from preset
 * @returns Fresh SessionTracker ready for execution
 */
export function initializeTrackerFromPlan(sessionPlan: SessionPlan): SessionTracker {
  const numberOfCycles = sessionPlan.numberOfCycles || 1;

  return {
    // Reference to the blueprint
    sessionPlan,

    // Copy metadata (for quick access)
    goalSummary: sessionPlan.goalSummary,
    cycleDescription: sessionPlan.cycleDescription,
    cycleStartUrl: sessionPlan.cyclePlan.startUrl,

    // Initialize empty execution arrays (populated during runtime)
    cycles: Array.from({ length: numberOfCycles === -1 ? 1 : numberOfCycles }, () => ({
      isCompleted: false,
      cycleSteps: [],
    })),

    // Initialize empty setup/wrapup arrays if defined in plan
    setupSteps: sessionPlan.setupSteps ? [] : undefined,
    wrapupSteps: sessionPlan.wrapupSteps ? [] : undefined,

    // Initialize timestamps
    startedAt: createTimestamp(),
    lastUpdatedAt: createTimestamp(),
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

  try {
    return await executeLLM(client, CycleStrategySchema, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.1 });
  } catch (error) {
    console.error('❌ Failed to generate strategy after retries:', error);
    return undefined;
  }
}

