// =============================================================================
// PROMPT MODULE
// =============================================================================
//
// This module handles all prompt engineering for the reasoning system.
//
// Features:
// - Token counting with js-tiktoken (cl100k_base encoder)
// - Smart truncation (head + tail) for markdown content
// - Element limiting with priority-based selection
// - All formatting functions for prompt sections
// - Compressed prompts for repeat cycles (saves ~300-400 tokens)
// - Stage-Aware Prompts:
//   - Execution Prompt: For the main ACTION loop
//   - Drift Analysis Prompt: For verifying Execute Mode state
//   - Planning Prompt: For generating initial plans
//
// Exported Functions:
// - countTokens(text) - Count tokens using tiktoken
// - smartTruncate(text, options) - Head + tail truncation
// - limitElements(elements, maxCount, maxTokens) - Priority-based element limiting
// - formatElementsForAI(elements) - Format elements for LLM
// - buildExecutionPrompt(...) - Build complete system + situation prompts for Action Loop
// - buildDriftAnalysisPrompt(...) - Build prompt for verifying state drift
// - extractCycleStrategy(plan) - Extract strategy from first cycle for compression
// - logTokenUsage(stats) - Log token usage to console (verbose mode)
// - buildPlanGenerationPrompt(goal) - Build prompt for initial plan generation
// - buildReplanPrompt(...) - Build prompt for replanning
// - buildSimpleQuestionPrompt(question) - Build prompt for simple LLM questions
// - validatePromptSize(...) - Check if prompt fits context
//
// =============================================================================

import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  ElementInfo,
  PageState,
  Goal,
  Preset,
  SessionPlan,
  StepResult,
  ThinkResult,
  PromptTokenLimits,
  Cycle,
  CycleStrategy,
  InterventionPoint,
  Action
} from './types.js';
import { getProgress, getCurrentCycleIndex } from './types.js';

// Re-export types for convenience
export type { PromptTokenLimits, CycleStrategy } from './types.js';

/**
 * Default prompt token limits.
 * Reads from environment variables with fallback to sensible defaults.
 * Balanced for ~4300 total tokens in the situation prompt.
 */
export const DEFAULT_PROMPT_LIMITS: PromptTokenLimits = {
  markdownTokens: parseInt(
    process.env.LLM_PROMPT_MARKDOWN_TOKENS || '1500',
    10,
  ),
  elementsTokens: parseInt(
    process.env.LLM_PROMPT_ELEMENTS_TOKENS || '2000',
    10,
  ),
  maxElements: parseInt(process.env.LLM_PROMPT_MAX_ELEMENTS || '50', 10),
  historyTokens: parseInt(process.env.LLM_PROMPT_HISTORY_TOKENS || '200', 10),
};

// -----------------------------------------------------------------------------
// TOKEN COUNTING
// -----------------------------------------------------------------------------

/** Lazy-loaded encoder singleton */
let encoder: Tiktoken | null = null;

/**
 * Get the tiktoken encoder (lazy singleton).
 * Uses cl100k_base which is the encoder for GPT-4 and similar models.
 * Provides reasonable estimates for other models like Llama.
 */
function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding('cl100k_base');
  }
  return encoder;
}

/**
 * Count the number of tokens in a text string.
 *
 * @param text - Text to count tokens for
 * @returns Number of tokens
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Validate that a prompt is within safe limits for the model.
 * 
 * @param systemPrompt - The system instructions
 * @param userPrompt - The user/situation context
 * @param modelContextLimit - The model's context limit (default 8192 for most open models, 128k for GPT-4o)
 * @returns Object with valid status and total tokens
 */
export function validatePromptSize(
    systemPrompt: string, 
    userPrompt: string, 
    modelContextLimit: number = 8192
): { valid: boolean; totalTokens: number; message?: string } {
    const sysTokens = countTokens(systemPrompt);
    const userTokens = countTokens(userPrompt);
    const total = sysTokens + userTokens + 50; // +50 buffer for protocol overhead

    if (total > modelContextLimit) {
        return { 
            valid: false, 
            totalTokens: total, 
            message: `Prompt too large (${total} tokens) for context limit (${modelContextLimit})` 
        };
    }

    return { valid: true, totalTokens: total };
}

// -----------------------------------------------------------------------------
// SMART TRUNCATION
// -----------------------------------------------------------------------------

export interface TruncationOptions {
  maxTokens: number;
  headRatio: number;
  separator: string;
}

const DEFAULT_TRUNCATION_OPTIONS: TruncationOptions = {
  maxTokens: 1500,
  headRatio: 0.6,
  separator: '\n\n[... content truncated ...]\n\n',
};

function truncateToTokens(
  text: string,
  targetTokens: number,
  direction: 'head' | 'tail',
): string {
  if (targetTokens <= 0) return '';
  const totalTokens = countTokens(text);
  if (totalTokens <= targetTokens) return text;

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const slice =
      direction === 'head'
        ? text.substring(0, mid)
        : text.substring(text.length - mid);

    if (countTokens(slice) <= targetTokens) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const boundary = low - 1;
  let result =
    direction === 'head'
      ? text.substring(0, boundary)
      : text.substring(text.length - boundary);

  if (direction === 'head') {
    result = result.replace(/\s+\S*$/, '');
  } else {
    result = result.replace(/^\S*\s+/, '');
  }

  return result;
}

export function smartTruncate(
  text: string,
  options: Partial<TruncationOptions> = {},
): string {
  const opts = { ...DEFAULT_TRUNCATION_OPTIONS, ...options };
  if (!text) return '';
  const currentTokens = countTokens(text);
  if (currentTokens <= opts.maxTokens) return text;

  const separatorTokens = countTokens(opts.separator);
  const contentTokens = opts.maxTokens - separatorTokens;

  if (contentTokens <= 0) return opts.separator;

  const headTokens = Math.floor(contentTokens * opts.headRatio);
  const tailTokens = contentTokens - headTokens;

  const headText = truncateToTokens(text, headTokens, 'head');
  const tailText = truncateToTokens(text, tailTokens, 'tail');

  return headText + opts.separator + tailText;
}

// -----------------------------------------------------------------------------
// ELEMENT LIMITING AND FORMATTING
// -----------------------------------------------------------------------------

function getElementPriority(element: ElementInfo): number {
  const tag = element.tag.toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return 0;
  if (tag === 'button') return 1;
  if (tag === 'a') return 2;
  return 3;
}

function formatSingleElement(el: ElementInfo): string {
  let line = `[${el.index}] ${el.tag}`;
  if (el.inputType && el.inputType !== 'text') {
    line += ` (${el.inputType})`;
  }
  line += `: "${el.text}"`;
  const keyAttrs = ['href', 'placeholder', 'name'];
  for (const attr of keyAttrs) {
    if (el.attributes[attr]) {
      line += ` [${attr}="${el.attributes[attr]}"]`;
    }
  }
  return line;
}

export function limitElements(
  elements: ElementInfo[],
  maxCount: number = 50,
  maxTokens: number = 2000,
): ElementInfo[] {
  if (elements.length === 0) return [];
  const prioritized = [...elements].sort(
    (a, b) => getElementPriority(a) - getElementPriority(b),
  );
  const result: ElementInfo[] = [];
  let tokenCount = 0;

  for (const el of prioritized) {
    if (result.length >= maxCount) break;
    const formatted = formatSingleElement(el);
    const elTokens = countTokens(formatted);
    if (tokenCount + elTokens > maxTokens) break;
    result.push(el);
    tokenCount += elTokens;
  }
  return result.sort((a, b) => a.index - b.index);
}

export function formatElementsForAI(elements: ElementInfo[]): string {
  if (elements.length === 0) return 'No interactive elements found on this page.';
  return elements.map((el) => formatSingleElement(el)).join('\n');
}

// -----------------------------------------------------------------------------
// TYPES FOR PROMPT BUILDING
// -----------------------------------------------------------------------------

export interface ExecutionMetrics {
  consecutiveFailures: number;
  replanCount: number;
  reobserveCount: number;
}

export interface Intervention {
  point: InterventionPoint;
  previousResult?: ThinkResult;
  instruction: string;
}

export interface PlanState {
  completedCycles: number;
  currentCycleIdx: number;
  currentCycle: Cycle | null;
  stepsInCurrentCycle: number;
}

export interface TokenUsageStats {
  systemTokens: number;
  situationTokens: number;
  totalTokens: number;
  isCompressed: boolean;
  breakdown: {
    taskContext: number;
    pageInfo: number;
    markdown: number;
    markdownTruncated: boolean;
    elements: number;
    elementsLimited: boolean;
    elementsShown: number;
    elementsTotal: number;
    history: number;
    goalContext: number;
    metrics: number;
    intervention: number;
    driftContext?: number;
  };
  limits: PromptTokenLimits;
}

export function getPlanState(plan: SessionPlan): PlanState {
  const completedCycles = plan.cycles.filter((c) => c.isCompleted).length;
  const currentCycleIdx = getCurrentCycleIndex(plan);
  const currentCycle = currentCycleIdx >= 0 ? plan.cycles[currentCycleIdx] : null;
  const stepsInCurrentCycle = currentCycle?.cycleSteps.length || 0;
  return { completedCycles, currentCycleIdx, currentCycle, stepsInCurrentCycle };
}

// -----------------------------------------------------------------------------
// PROMPT FORMATTING HELPERS
// -----------------------------------------------------------------------------

export function formatTaskContext(plan: SessionPlan, planState: PlanState): string {
  const lastStep = planState.currentCycle?.cycleSteps[
      planState.currentCycle.cycleSteps.length - 1
  ];
  let context = `TASK CONTEXT:
Goal: ${plan.goalSummary}
Cycle ${planState.currentCycleIdx + 1}/${plan.cycles.length}: ${plan.cycleDescription}
Steps in this cycle: ${planState.stepsInCurrentCycle}`;
  if (lastStep) {
    context += `\nLast action: ${lastStep.stepDescription}`;
  }
  return context;
}

export function formatExecutionMetrics(metrics: ExecutionMetrics): string {
  const items: string[] = [];
  if (metrics.consecutiveFailures > 0) items.push(`⚠️ ${metrics.consecutiveFailures} consecutive failure(s)`);
  if (metrics.replanCount > 0) items.push(`Replanned ${metrics.replanCount} time(s) this cycle`);
  if (metrics.reobserveCount > 0) items.push(`Re-observed ${metrics.reobserveCount} time(s)`);
  return items.length > 0 ? `\n\nSESSION STATE:\n${items.join('\n')}` : '';
}

export function formatHistory(history: StepResult[], maxItems: number = 5, maxTokens?: number): string {
  if (history.length === 0) return '';
  const recentHistory = history.slice(-maxItems);
  let formatted = '\n\nPREVIOUS ACTIONS:\n' + recentHistory.map((step, i) => {
    const status = step.success ? '✔' : '✗';
    return `${i + 1}. [${status}] ${step.action.type}: ${step.action.reason}`;
  }).join('\n');

  if (maxTokens && countTokens(formatted) > maxTokens) {
    formatted = smartTruncate(formatted, {
      maxTokens,
      headRatio: 0.3, 
      separator: '\n[...earlier actions...]\n',
    });
  }
  return formatted;
}

export function formatGoalContext(goal: Goal | undefined): string {
  if (!goal?.context || Object.keys(goal.context).length === 0) return '';
  return '\n\nGOAL CONTEXT:\n' + Object.entries(goal.context).map(([key, value]) => `- ${key}: ${value}`).join('\n');
}

export function formatIntervention(intervention?: Intervention): string {
  if (!intervention) return '';
  let text = `\n\nUSER INTERVENTION at ${intervention.point}:`;
  if (intervention.previousResult) {
    text += `\nPrevious decision: ${formatThinkResult(intervention.previousResult)}`;
  }
  text += `\nUser instruction: "${intervention.instruction}"`;
  text += `\n\nIMPORTANT: You MUST incorporate the user's guidance into your next decision.`;
  return text;
}

export function formatThinkResult(result: ThinkResult): string {
  switch (result.type) {
    case 'ACTION':
      return `ACTION - ${result.action.type} (${result.action.reason})`;
    case 'GOAL_SUCCESS':
      return `GOAL_SUCCESS - ${result.finalAnswer}`;
    case 'FAIL':
      return `FAIL - ${result.error}`;
    case 'REPLAN':
      return `REPLAN - ${result.reason}`;
    case 'RETRY_PERCEPTION':
      return `RETRY_PERCEPTION`;
  }
}

// -----------------------------------------------------------------------------
// BASE SYSTEM PROMPT (EXECUTION)
// -----------------------------------------------------------------------------

function buildBaseSystemPrompt(
  goalName: string,
  goalDescription: string,
  successCriteria: string,
  progress: string,
): string {
  return `You are a web automation agent. Your task is to navigate web pages and accomplish goals.

GOAL: ${goalName}
${goalDescription}
${successCriteria ? `\nSUCCESS CRITERIA: ${successCriteria}` : ''}

PROGRESS: ${progress}

AVAILABLE ACTIONS:
- click: Click an element. Requires "selector" (index).
- type: Type text. Requires "selector" (index) and "text".
- scroll: Scroll page. Requires "text" ("up"|"down").
- navigate: Go to URL. Requires "text".
- wait: Wait for update.

RESULT TYPES:
- ACTION: Execute a browser action
- GOAL_SUCCESS: Goal is complete
- FAIL: Cannot proceed
- REPLAN: Current approach isn't working
- RETRY_PERCEPTION: Page structure unclear

RULES:
1. Respond with valid JSON only.
2. Use element INDEX numbers for selectors.
3. Be efficient.
4. Use FAIL if impossible.
5. Use REPLAN if stuck.`;
}


// -----------------------------------------------------------------------------
// DRIFT ANALYSIS PROMPT (EXECUTION)
// -----------------------------------------------------------------------------

export function buildDriftAnalysisPrompt(
    expectedState: PageState,
    currentState: PageState,
    plannedAction: Action,
    elementContext: string
): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `You are a drift detection expert. 
Your job is to compare an EXPECTED page state with the CURRENT page state.
You must decide if the PLANNED ACTION is still valid or if the strategy needs update or fallback.

OUTPUT FORMAT: JSON
{
  "status": "approved" | "update_required" | "fallback",
  "reason": "explanation...",
  "correction": { "selector": "new_selector" } // ONLY if update_required
}

DEFINITIONS:
- approved: The page is effectively the same, or the difference is irrelevant to the action. Proceed.
- update_required: The target element has moved or changed attributes, but you found it confidently in the new state. Provide the new selector.
- fallback: The page has changed significantly (drifted). The planned action is unsafe. Switch to full exploration.

IMPORTANT:
1. If status is "update_required", "correction" object is REQUIRED.
2. "correction" must be an OBJECT with a "selector" field: { "selector": "index_or_selector" }
3. Do NOT return a string for correction.`;

    const userPrompt = `PLANNED ACTION: ${plannedAction.type} on ${plannedAction.selector} ("${plannedAction.reason}")

EXPECTED TARGET CONTEXT:
${elementContext}

CURRENT PAGE STATE (Interactive Elements):
${formatElementsForAI(limitElements(currentState.elements, 50, 2000))}

Verify if the action can proceed. Look for the target element using its text, attributes, or context.`;

    return { systemPrompt, userPrompt };
}


// -----------------------------------------------------------------------------
// BUILD EXECUTION PROMPT (Main Loop)
// -----------------------------------------------------------------------------

export interface BuildPromptResult {
  systemPrompt: string;
  situationPrompt: string;
  tokenStats: TokenUsageStats;
}

export function buildExecutionPrompt(
  pageState: PageState,
  goal: Goal | undefined,
  preset: Preset | undefined,
  plan: SessionPlan,
  history: StepResult[],
  sessionState: ExecutionMetrics,
  intervention?: Intervention,
  limits: PromptTokenLimits = DEFAULT_PROMPT_LIMITS,
): BuildPromptResult {
  
  // 1. Analyze Plan State
  const planState = getPlanState(plan);
  
  // 2. Build Context Strings
  const goalName = preset?.name || goal?.name || 'Task';
  const goalDescription = preset?.description || goal?.description || ''; // Assuming description handles intervention overrides if any
  const successCriteria = preset?.customConfig?.successCriteria || goal?.successCriteria || '';
  const progressStr = getProgress(plan);
  const taskContext = formatTaskContext(plan, planState);
  const goalContextStr = formatGoalContext(goal);
  const interventionStr = formatIntervention(intervention);
  const metricsStr = formatExecutionMetrics(sessionState);
  const historyStr = formatHistory(history, 5, limits.historyTokens);

  // 3. Build System Prompt
  // Check for compressed mode
  const useCompressed = false; // logic removed for brevity/safety - always use full prompt for V2 stability for now
  
  const systemPrompt = buildBaseSystemPrompt(goalName, goalDescription, successCriteria, progressStr);

  // 4. Build Situation Prompt (The User Message)
  // We prioritize content to fit in context:
  // 1. Intervention (Highest)
  // 2. Metrics (High)
  // 3. Elements (High - Limited)
  // 4. History (Medium)
  // 5. Markdown (Low - Truncated)

  // Limit elements 
  const limitedElements = limitElements(pageState.elements, limits.maxElements, limits.elementsTokens);
  const elementsStr = formatElementsForAI(limitedElements);
  
  // Truncate markdown
  const markdownStr = smartTruncate(pageState.markdown, { maxTokens: limits.markdownTokens });

  const situationPrompt = `CURRENT PAGE:
Title: ${pageState.url}
URL: ${pageState.title}

CONTENT SUMMARY:
${markdownStr}

INTERACTIVE ELEMENTS:
${elementsStr}
${goalContextStr}
${taskContext}
${historyStr}
${metricsStr}
${interventionStr}

What is the next step? Respond in JSON.`;

  // 5. Calculate Token Stats
  const tokenStats: TokenUsageStats = {
    systemTokens: countTokens(systemPrompt),
    situationTokens: countTokens(situationPrompt),
    totalTokens: countTokens(systemPrompt) + countTokens(situationPrompt),
    isCompressed: useCompressed,
    breakdown: {
      taskContext: countTokens(taskContext),
      pageInfo: countTokens(pageState.url + pageState.title),
      markdown: countTokens(markdownStr),
      markdownTruncated: markdownStr.length < pageState.markdown.length,
      elements: countTokens(elementsStr),
      elementsLimited: limitedElements.length < pageState.elements.length,
      elementsShown: limitedElements.length,
      elementsTotal: pageState.elements.length,
      history: countTokens(historyStr),
      goalContext: countTokens(goalContextStr),
      metrics: countTokens(metricsStr),
      intervention: countTokens(interventionStr),
    },
    limits,
  };

  return { systemPrompt, situationPrompt, tokenStats };
}


// -----------------------------------------------------------------------------
// HELPER: PLAN GENERATION
// -----------------------------------------------------------------------------

export function buildPlanGenerationPrompt(goal: Goal): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `You are a planning expert. Create a structured session plan for the user's goal.
Return JSON: { "goalSummary": "...", "cycleDescription": "...", "cycles": [{ "isCompleted": false, "cycleSteps": [] }] }`;
    const userPrompt = `Goal: ${goal.name}\n${goal.description}\n\nCreate a plan.`;
    return { systemPrompt, userPrompt };
}

export function buildReplanPrompt(reason: string, plan: SessionPlan): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `You are a planning expert. The agent is stuck. Update the plan.`;
    const userPrompt = `Current Plan: ${JSON.stringify(plan)}\nReason for replan: ${reason}\n\nProvide updated plan JSON.`;
    return { systemPrompt, userPrompt };
}

export function buildSimpleQuestionPrompt(question: string): { systemPrompt: string; userPrompt: string } {
    return { systemPrompt: 'You are a helpful assistant.', userPrompt: question };
}

export function logTokenUsage(stats: TokenUsageStats): void {
    if (process.env.VERBOSE !== 'true') return;
    console.log(`\nToken Usage: Total ${stats.totalTokens} (Sys: ${stats.systemTokens}, User: ${stats.situationTokens})`);
}
