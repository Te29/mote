// =============================================================================
// REASON MODULE
// =============================================================================
//
// This module is the agent's "brain" - it decides what to do next based on
// what it sees on the page and what goal it's trying to achieve.
//
// Features:
// - Returns ThinkResult discriminated union with 5 result types:
//   ACTION, REPLAN, RETRY_PERCEPTION, GOAL_SUCCESS, FAIL
// - Separates browser actions from terminal/control states
// - Supports both Preset (with systemPrompt) and Goal (generates prompt)
// - User intervention support via optional parameter
// - Plan generation for both initial and replan scenarios
// - SessionPlan validation for presets
//
// The process:
// 1. Take the current page state (from observe.ts)
// 2. Build a prompt that explains the situation to the AI (via prompt.ts)
// 3. Send it to the LLM (Ollama or OpenAI)
// 4. Parse the AI's response into a structured ThinkResult
//
// Exported Functions:
// - createLLMClient(config?) - Create OpenAI-compatible client for Ollama/OpenAI
// - think(pageState, goal, preset, plan, history, client, metrics, intervention?) - Core reasoning
// - askLLM(question, client) - Ask LLM a simple question
// - generatePlan(goal, client, existingPlan?, replanReason?) - Generate or adjust plan
// - validateSessionPlan(plan) - Validate preset's SessionPlan
// =============================================================================

import OpenAI from 'openai';
import { config } from 'dotenv';
import type {
  PageState,
  Goal,
  Preset,
  LLMConfig,
  StepResult,
  ThinkResult,
  SessionPlan,
} from './types.js';
import { getCurrentCycleIndex } from './types.js';
import { fileURLToPath } from 'url';
import {
  buildPrompt,
  logTokenUsage,
  buildPlanGenerationPrompt,
  buildReplanPrompt,
  buildSimpleQuestionPrompt,
  type ExecutionMetrics,
  type Intervention,
} from './prompt.js';

// Re-export types from prompt.ts for backwards compatibility
export type { ExecutionMetrics, Intervention } from './prompt.ts';

// Load environment variables
config();

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/**
 * Result of SessionPlan validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// -----------------------------------------------------------------------------
// LLM CLIENT
// -----------------------------------------------------------------------------

/**
 * Create an OpenAI-compatible client.
 * Works with Ollama, OpenAI, and other compatible APIs.
 */
export function createLLMClient(llmConfig?: LLMConfig): OpenAI {
  // Use provided config or fall back to environment variables
  const baseURL =
    llmConfig?.baseUrl ||
    process.env.LLM_BASE_URL ||
    'http://localhost:11434/v1';
  const apiKey = llmConfig?.apiKey || process.env.LLM_API_KEY || 'ollama';

  return new OpenAI({
    baseURL,
    apiKey,
  });
}

// Get default model from environment
function getDefaultModel(): string {
  return process.env.LLM_MODEL || 'llama3.2';
}

// -----------------------------------------------------------------------------
// MAIN THINK FUNCTION
// -----------------------------------------------------------------------------

/**
 * Decide what to do next based on the current page state and goal.
 * This is the core reasoning function called by the agent loop.
 *
 * Returns ThinkResult discriminated union instead of just Action.
 * Supports optional user intervention to guide decisions.
 *
 * @param pageState - What the agent sees (from observe.ts)
 * @param goal - What the agent is trying to accomplish (optional if preset provided)
 * @param preset - Pre-configured task template (optional)
 * @param plan - Current session plan for progress tracking
 * @param history - Previous actions taken (for context)
 * @param client - LLM client (created by createLLMClient)
 * @param sessionState - Execution state (failures, replan count, etc.)
 * @param intervention - Optional user intervention to guide decision
 * @returns ThinkResult - ACTION, REPLAN, RETRY_PERCEPTION, GOAL_SUCCESS, or FAIL
 *
 * @example
 * // Normal thinking
 * const result = await think(pageState, goal, undefined, plan, history, client, sessionState)
 *
 * // With user intervention
 * const result = await think(pageState, goal, undefined, plan, history, client, sessionState, {
 *   point: 'ACTION',
 *   previousResult: lastResult,
 *   instruction: 'Try clicking the blue button instead'
 * })
 */
export async function think(
  pageState: PageState,
  goal: Goal | undefined,
  preset: Preset | undefined,
  plan: SessionPlan,
  history: StepResult[],
  client: OpenAI,
  sessionState: ExecutionMetrics,
  intervention?: Intervention,
): Promise<ThinkResult> {
  const model = getDefaultModel();
  const verbose = process.env.VERBOSE === 'true';

  // Build the prompt (uses preset.systemPrompt if available,
  // otherwise generates from goal and inject to baseSystemPrompt)
  const { systemPrompt, situationPrompt, tokenStats } = buildPrompt(
    pageState,
    goal,
    preset,
    plan,
    history,
    sessionState,
    intervention,
  );

  if (verbose) {
    console.log('\n🧠 Thinking...');
    console.log(`   Model: ${model}`);
    if (intervention) {
      console.log(`   With user intervention at: ${intervention.point}`);
    }
    logTokenUsage(tokenStats);
  }

  try {
    // ---------------------------------------------------------------------------
    // Call the LLM
    // ---------------------------------------------------------------------------
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: situationPrompt },
      ],
      // Request JSON output (Ollama supports this with some models)
      response_format: { type: 'json_object' },
      temperature: 0.2, // Lower = more deterministic
      max_tokens: 500, // We only need a short response
    });

    // Extract the response content
    const content = response.choices[0]?.message?.content || '';

    if (verbose) {
      console.log(`   Raw response: ${content.substring(0, 200)}...`);
    }

    // Parse the response into a ThinkResult
    return parseThinkResult(content);
  } catch (error) {
    // Handle LLM errors gracefully
    console.error('❌ LLM Error:', error);
    return {
      type: 'FAIL',
      error: `LLM error: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    };
  }
}

// -----------------------------------------------------------------------------
// PARSE THINK RESULT (v2)
// -----------------------------------------------------------------------------

/**
 * Parse the LLM's response into a structured ThinkResult.
 *
 * v2: Handles discriminated union with 5 result types.
 */
function parseThinkResult(content: string): ThinkResult {
  try {
    // ---------------------------------------------------------------------------
    // Clean up the response
    // ---------------------------------------------------------------------------
    let cleaned = content.trim();

    // Remove markdown code blocks if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // ---------------------------------------------------------------------------
    // Parse JSON
    // ---------------------------------------------------------------------------
    const parsed = JSON.parse(cleaned);

    // Validate the response has required fields
    if (!parsed.resultType) {
      throw new Error('Response missing resultType');
    }

    // ---------------------------------------------------------------------------
    // Handle each result type
    // ---------------------------------------------------------------------------
    switch (parsed.resultType) {
      case 'ACTION': {
        if (!parsed.action || !parsed.action.type) {
          throw new Error('ACTION result missing action or action.type');
        }

        const validActions = ['click', 'type', 'scroll', 'navigate', 'wait'];
        if (!validActions.includes(parsed.action.type)) {
          throw new Error(`Invalid action type: ${parsed.action.type}`);
        }

        return {
          type: 'ACTION',
          action: {
            type: parsed.action.type,
            selector: parsed.action.selector?.toString(),
            text: parsed.action.text,
            reason:
              parsed.action.reason || parsed.thinking || 'No reason provided',
          },
        };
      }

      case 'GOAL_SUCCESS': {
        return {
          type: 'GOAL_SUCCESS',
          finalAnswer:
            parsed.finalAnswer || parsed.thinking || 'Goal accomplished',
        };
      }

      case 'FAIL': {
        return {
          type: 'FAIL',
          error: parsed.error || parsed.thinking || 'Unknown failure',
        };
      }

      case 'REPLAN': {
        return {
          type: 'REPLAN',
          reason: parsed.reason || parsed.thinking || 'Needs replanning',
        };
      }

      case 'RETRY_PERCEPTION': {
        return {
          type: 'RETRY_PERCEPTION',
        };
      }

      default:
        throw new Error(`Unknown resultType: ${parsed.resultType}`);
    }
  } catch (error) {
    // ---------------------------------------------------------------------------
    // Handle parse failures
    // ---------------------------------------------------------------------------
    console.error('❌ Failed to parse LLM response:', error);
    console.error('   Raw content:', content.substring(0, 200));

    return {
      type: 'FAIL',
      error: `Could not parse LLM response: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    };
  }
}

// -----------------------------------------------------------------------------
// UTILITY: SIMPLE QUESTION
// -----------------------------------------------------------------------------

/**
 * Ask the LLM a simple question (not related to page state).
 * Useful for clarification or general knowledge.
 *
 * @param question - The question to ask
 * @param client - LLM client
 * @returns The LLM's response
 */
export async function askLLM(
  question: string,
  client: OpenAI,
): Promise<string> {
  const model = getDefaultModel();
  const prompt = buildSimpleQuestionPrompt(question);

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 500,
  });

  return response.choices[0]?.message?.content || '';
}

// -----------------------------------------------------------------------------
// GENERATE PLAN (Initial + Replan)
// -----------------------------------------------------------------------------

/**
 * Generate or adjust a SessionPlan.
 *
 * Handles two scenarios:
 * 1. Initial plan generation (no existingPlan) - analyze goal to determine cycles
 * 2. Replan (existingPlan + replanReason) - adjust approach based on what's not working
 *
 * @param goal - User's goal
 * @param client - LLM client
 * @param existingPlan - Current plan (for replan scenarios)
 * @param replanReason - Why replan is needed (for replan scenarios)
 * @returns SessionPlan with cycles
 */
export async function generatePlan(
  goal: Goal,
  client: OpenAI,
  existingPlan?: SessionPlan,
  replanReason?: string,
): Promise<SessionPlan> {
  const model = getDefaultModel();
  const now = new Date();

  // ---------------------------------------------------------------------------
  // Build prompt based on scenario (prompts defined in prompt.ts)
  // ---------------------------------------------------------------------------
  let prompt: string;

  if (existingPlan && replanReason) {
    // Replan scenario
    const completedCycles = existingPlan.cycles.filter(
      (c) => c.isCompleted,
    ).length;
    const currentCycleIdx = getCurrentCycleIndex(existingPlan);
    const currentCycle =
      currentCycleIdx >= 0 ? existingPlan.cycles[currentCycleIdx] : null;
    const stepsInCurrentCycle = currentCycle?.cycleSteps.length || 0;

    prompt = buildReplanPrompt(
      goal,
      existingPlan,
      replanReason,
      completedCycles,
      stepsInCurrentCycle,
    );
  } else {
    // Initial plan generation
    prompt = buildPlanGenerationPrompt(goal);
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    const cycleCount = parsed.cycleCount || 1;
    const cycleDescription = parsed.cycleDescription || 'Complete the task';
    const goalSummary = parsed.goalSummary || goal.description;

    // ---------------------------------------------------------------------------
    // Build cycles array
    // ---------------------------------------------------------------------------
    let cycles: SessionPlan['cycles'];

    if (existingPlan && replanReason) {
      // Replan: preserve completed cycles, rebuild remaining
      const completedCycles = existingPlan.cycles.filter((c) => c.isCompleted);
      const remainingCount = Math.max(0, cycleCount - completedCycles.length);

      cycles = [
        ...completedCycles,
        ...Array.from({ length: remainingCount }, () => ({
          isCompleted: false,
          cycleSteps: [],
        })),
      ];

      // If we're mid-cycle, keep current cycle's steps
      const currentCycleIdx = getCurrentCycleIndex(existingPlan);
      if (
        currentCycleIdx >= 0 &&
        currentCycleIdx < existingPlan.cycles.length
      ) {
        const currentCycle = existingPlan.cycles[currentCycleIdx];
        if (!currentCycle.isCompleted && cycles[completedCycles.length]) {
          cycles[completedCycles.length].cycleSteps = currentCycle.cycleSteps;
        }
      }
    } else {
      // Initial: create fresh cycles
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
    // Default to single cycle if generation fails
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

/**
 * Validate a SessionPlan (typically from a preset).
 * Ensures the plan has all required fields with valid values.
 *
 * @param plan - SessionPlan to validate
 * @returns ValidationResult with valid flag and any errors
 */
export function validateSessionPlan(plan: SessionPlan): ValidationResult {
  const errors: string[] = [];

  // Check required string fields
  if (
    !plan.goalSummary ||
    typeof plan.goalSummary !== 'string' ||
    plan.goalSummary.trim() === ''
  ) {
    errors.push('goalSummary is required and must be a non-empty string');
  }

  if (
    !plan.cycleDescription ||
    typeof plan.cycleDescription !== 'string' ||
    plan.cycleDescription.trim() === ''
  ) {
    errors.push('cycleDescription is required and must be a non-empty string');
  }

  // Check cycles array
  if (!Array.isArray(plan.cycles)) {
    errors.push('cycles must be an array');
  } else if (plan.cycles.length === 0) {
    errors.push('cycles must contain at least one cycle');
  } else {
    // Validate each cycle
    plan.cycles.forEach((cycle, idx) => {
      if (typeof cycle.isCompleted !== 'boolean') {
        errors.push(`cycles[${idx}].isCompleted must be a boolean`);
      }
      if (!Array.isArray(cycle.cycleSteps)) {
        errors.push(`cycles[${idx}].cycleSteps must be an array`);
      } else {
        // Validate each step
        cycle.cycleSteps.forEach((step, stepIdx) => {
          if (typeof step.isCompleted !== 'boolean') {
            errors.push(
              `cycles[${idx}].cycleSteps[${stepIdx}].isCompleted must be a boolean`,
            );
          }
          if (typeof step.stepDescription !== 'string') {
            errors.push(
              `cycles[${idx}].cycleSteps[${stepIdx}].stepDescription must be a string`,
            );
          }
        });
      }
    });
  }

  // Check dates
  if (typeof plan.startedAt !== 'string' || plan.startedAt.trim() === '') {
    errors.push('startedAt must be a non-empty string (ISO 8601 format)');
  }
  if (
    typeof plan.lastUpdatedAt !== 'string' ||
    plan.lastUpdatedAt.trim() === ''
  ) {
    errors.push('lastUpdatedAt must be a non-empty string (ISO 8601 format)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// -----------------------------------------------------------------------------
// TEST: Run this file directly to verify LLM connection
// -----------------------------------------------------------------------------
// Usage: npm run test:reason (shortcut for npx tsx src/reason.ts)

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('🧪 Testing reason module (v2)...\n');

  // Create client
  const client = createLLMClient();
  const model = getDefaultModel();

  console.log(`📡 Connecting to LLM...`);
  console.log(
    `   Base URL: ${process.env.LLM_BASE_URL || 'http://localhost:11434/v1'}`,
  );
  console.log(`   Model: ${model}`);

  // Test simple question
  console.log('\n💬 Testing simple question...');
  try {
    const answer = await askLLM(
      'What is 2 + 2? Answer with just the number.',
      client,
    );
    console.log(`   Answer: ${answer}`);
  } catch (error) {
    console.error('❌ LLM connection failed:', error);
    console.log('\n⚠️  Make sure Ollama is running:');
    console.log('   1. Install Ollama: https://ollama.ai');
    console.log('   2. Start Ollama: ollama serve');
    console.log('   3. Pull a model: ollama pull llama3.2');
    process.exit(1);
  }

  // Test generatePlan
  console.log('\n📋 Testing generatePlan...');
  const mockGoal: Goal = {
    name: 'Web Search',
    description: 'Search for "weather today" on Google',
    context: { query: 'weather today' },
    successCriteria: 'Search results are displayed',
  };

  const plan = await generatePlan(mockGoal, client);
  console.log(`   Goal Summary: ${plan.goalSummary}`);
  console.log(`   Cycle Description: ${plan.cycleDescription}`);
  console.log(`   Cycles: ${plan.cycles.length}`);

  // Test validateSessionPlan
  console.log('\n✅ Testing validateSessionPlan...');
  const validation = validateSessionPlan(plan);
  console.log(`   Valid: ${validation.valid}`);
  if (validation.errors.length > 0) {
    console.log(`   Errors: ${validation.errors.join(', ')}`);
  }

  // Test think function with mock page state
  console.log('\n🧠 Testing think function with mock page state...');

  const mockPageState: PageState = {
    url: 'https://www.google.com',
    title: 'Google',
    markdown: 'Google Search page with a search box and buttons.',
    elements: [
      {
        index: 1,
        tag: 'input',
        text: 'Search',
        selector: 'input[name="q"]',
        inputType: 'text',
        attributes: { name: 'q', placeholder: 'Search Google' },
      },
      {
        index: 2,
        tag: 'button',
        text: 'Google Search',
        selector: 'input[name="btnK"]',
        attributes: {},
      },
      {
        index: 3,
        tag: 'button',
        text: "I'm Feeling Lucky",
        selector: 'input[name="btnI"]',
        attributes: {},
      },
    ],
  };

  const mockExecutionMetrics: ExecutionMetrics = {
    consecutiveFailures: 0,
    replanCount: 0,
    reobserveCount: 0,
  };

  const result = await think(
    mockPageState,
    mockGoal,
    undefined,
    plan,
    [],
    client,
    mockExecutionMetrics,
  );

  console.log('\n📋 Think Result:');
  console.log(`   Type: ${result.type}`);

  switch (result.type) {
    case 'ACTION':
      console.log(`   Action: ${result.action.type}`);
      console.log(`   Selector: ${result.action.selector || 'N/A'}`);
      console.log(`   Text: ${result.action.text || 'N/A'}`);
      console.log(`   Reason: ${result.action.reason}`);
      break;
    case 'GOAL_SUCCESS':
      console.log(`   Final Answer: ${result.finalAnswer}`);
      break;
    case 'FAIL':
      console.log(`   Error: ${result.error}`);
      break;
    case 'REPLAN':
      console.log(`   Reason: ${result.reason}`);
      break;
    case 'RETRY_PERCEPTION':
      console.log(`   (Re-scrape page)`);
      break;
  }

  // Test think with intervention
  console.log('\n🧠 Testing think with user intervention...');
  const interventionResult = await think(
    mockPageState,
    mockGoal,
    undefined,
    plan,
    [],
    client,
    mockExecutionMetrics,
    {
      point: 'ACTION',
      previousResult: result,
      instruction: 'Actually, type "weather forecast" instead',
    },
  );

  console.log('\n📋 Think Result (with intervention):');
  console.log(`   Type: ${interventionResult.type}`);
  if (interventionResult.type === 'ACTION') {
    console.log(`   Action: ${interventionResult.action.type}`);
    console.log(`   Text: ${interventionResult.action.text || 'N/A'}`);
  }

  console.log('\n✅ Reason test complete!');
}
