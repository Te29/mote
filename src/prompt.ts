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
//
// Exported Functions:
// - countTokens(text) - Count tokens using tiktoken
// - smartTruncate(text, options) - Head + tail truncation
// - limitElements(elements, maxCount, maxTokens) - Priority-based element limiting
// - formatElementsForAI(elements) - Format elements for LLM
// - buildPrompt(...) - Build complete system + situation prompts
// - extractCycleStrategy(plan) - Extract strategy from first cycle for compression
// - logTokenUsage(stats) - Log token usage to console (verbose mode)
// - buildPlanGenerationPrompt(goal) - Build prompt for initial plan generation
// - buildReplanPrompt(...) - Build prompt for replanning
// - buildSimpleQuestionPrompt(question) - Build prompt for simple LLM questions
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
} from './types.js';
import { getProgress, getCurrentCycleIndex } from './types.js';

// Re-export types for convenience
export type { PromptTokenLimits, CycleStrategy } from './types.js';

/**
 * Default prompt token limits.
 * Reads from environment variables with fallback to sensible defaults.
 * Balanced for ~4300 total tokens in the situation prompt.
 *
 * Environment variables:
 * - LLM_PROMPT_MARKDOWN_TOKENS (default: 1500)
 * - LLM_PROMPT_ELEMENTS_TOKENS (default: 2000)
 * - LLM_PROMPT_MAX_ELEMENTS (default: 50)
 * - LLM_PROMPT_HISTORY_TOKENS (default: 200)
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
 *
 * @example
 * countTokens('Hello, world!') // Returns ~4
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

// -----------------------------------------------------------------------------
// SMART TRUNCATION
// -----------------------------------------------------------------------------

/**
 * Options for smart truncation.
 */
export interface TruncationOptions {
  /** Maximum tokens to keep */
  maxTokens: number;
  /** Ratio of head content (0.6 = 60% head, 40% tail) */
  headRatio: number;
  /** Separator between head and tail */
  separator: string;
}

/** Default truncation options */
const DEFAULT_TRUNCATION_OPTIONS: TruncationOptions = {
  maxTokens: 1500,
  headRatio: 0.6,
  separator: '\n\n[... content truncated ...]\n\n',
};

/**
 * Truncate text to a token limit using binary search.
 * Adjusts to word boundaries to avoid mid-word cuts.
 *
 * @param text - Text to truncate
 * @param targetTokens - Target token count
 * @param direction - 'head' keeps beginning, 'tail' keeps end
 * @returns Truncated text
 */
function truncateToTokens(
  text: string,
  targetTokens: number,
  direction: 'head' | 'tail',
): string {
  if (targetTokens <= 0) return '';

  const totalTokens = countTokens(text);
  if (totalTokens <= targetTokens) {
    return text;
  }

  // Binary search for the boundary
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

  // Get the slice
  const boundary = low - 1;
  let result =
    direction === 'head'
      ? text.substring(0, boundary)
      : text.substring(text.length - boundary);

  // Adjust to word boundary
  if (direction === 'head') {
    // Remove partial word at end
    result = result.replace(/\s+\S*$/, '');
  } else {
    // Remove partial word at start
    result = result.replace(/^\S*\s+/, '');
  }

  return result;
}

/**
 * Smart truncation that preserves both head and tail of content.
 *
 * Web pages often have important information at both the beginning
 * (header, main content) and end (footer with actions, submit buttons).
 * This function keeps both portions, removing less important middle content.
 *
 * @param text - Text to truncate
 * @param options - Truncation options (defaults to 1500 tokens, 60/40 split)
 * @returns Truncated text with separator if truncation occurred
 *
 * @example
 * smartTruncate(longText, { maxTokens: 1000, headRatio: 0.7, separator: '\n...\n' })
 */
export function smartTruncate(
  text: string,
  options: Partial<TruncationOptions> = {},
): string {
  const opts = { ...DEFAULT_TRUNCATION_OPTIONS, ...options };

  if (!text) return '';

  const currentTokens = countTokens(text);
  if (currentTokens <= opts.maxTokens) {
    return text;
  }

  const separatorTokens = countTokens(opts.separator);
  const contentTokens = opts.maxTokens - separatorTokens;

  if (contentTokens <= 0) {
    return opts.separator;
  }

  const headTokens = Math.floor(contentTokens * opts.headRatio);
  const tailTokens = contentTokens - headTokens;

  const headText = truncateToTokens(text, headTokens, 'head');
  const tailText = truncateToTokens(text, tailTokens, 'tail');

  return headText + opts.separator + tailText;
}

// -----------------------------------------------------------------------------
// ELEMENT LIMITING
// -----------------------------------------------------------------------------

/**
 * Get priority score for an element (lower = higher priority).
 * Form elements are highest priority, then buttons, then links.
 */
function getElementPriority(element: ElementInfo): number {
  const tag = element.tag.toLowerCase();

  // Priority 0: Form inputs (most important for automation)
  if (['input', 'textarea', 'select'].includes(tag)) {
    return 0;
  }

  // Priority 1: Buttons (primary actions)
  if (tag === 'button') {
    return 1;
  }

  // Priority 2: Links (navigation)
  if (tag === 'a') {
    return 2;
  }

  // Priority 3: Everything else (role-based, onclick, etc.)
  return 3;
}

/**
 * Format a single element for the prompt.
 * Used for token counting during element limiting.
 */
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

/**
 * Limit elements to fit within count and token budgets.
 *
 * Uses priority-based selection:
 * 1. Sort by priority (inputs > buttons > links > others)
 * 2. Take elements until count or token limit reached
 * 3. Re-sort by original index to preserve page order
 *
 * @param elements - All interactive elements from the page
 * @param maxCount - Maximum number of elements (default: 50)
 * @param maxTokens - Maximum tokens for formatted elements (default: 2000)
 * @returns Filtered elements, preserving original index order
 *
 * @example
 * const limited = limitElements(pageState.elements, 30, 1500);
 */
export function limitElements(
  elements: ElementInfo[],
  maxCount: number = 50,
  maxTokens: number = 2000,
): ElementInfo[] {
  if (elements.length === 0) return [];

  // Sort by priority (lower = higher priority)
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

  // Re-sort by original index to preserve page order
  return result.sort((a, b) => a.index - b.index);
}

// -----------------------------------------------------------------------------
// ELEMENT FORMATTING
// -----------------------------------------------------------------------------

/**
 * Format interactive elements for the AI prompt.
 *
 * Each element is formatted as:
 * [index] tag (type): "text" [attr="value"]
 *
 * @param elements - Interactive elements from the page
 * @returns Formatted string for LLM consumption
 *
 * @example
 * // Output:
 * // [1] input (text): "Search Google or type a URL" [placeholder="Search..."]
 * // [2] button: "Google Search"
 * // [3] link: "Gmail" [href="https://mail.google.com"]
 */
export function formatElementsForAI(elements: ElementInfo[]): string {
  if (elements.length === 0) {
    return 'No interactive elements found on this page.';
  }

  return elements.map((el) => formatSingleElement(el)).join('\n');
}

// -----------------------------------------------------------------------------
// TYPES FOR PROMPT BUILDING
// -----------------------------------------------------------------------------

/**
 * Execution metrics - tracks retry patterns to help LLM avoid infinite loops.
 * Re-exported from reason.ts for use in prompt building.
 */
export interface ExecutionMetrics {
  /** Number of consecutive action failures */
  consecutiveFailures: number;
  /** Number of times replanned in current cycle */
  replanCount: number;
  /** Number of times re-perceived in current cycle */
  reperceiveCount: number;
}

/**
 * User intervention context - when user wants to guide the LLM.
 */
export interface Intervention {
  /** Where user intervened */
  point: InterventionPoint;
  /** What LLM decided before (if applicable) */
  previousResult?: ThinkResult;
  /** User's instruction to guide next decision */
  instruction: string;
}

/**
 * Extracted plan state for prompt building.
 */
export interface PlanState {
  completedCycles: number;
  currentCycleIdx: number;
  currentCycle: Cycle | null;
  stepsInCurrentCycle: number;
}

/**
 * Token usage statistics for a built prompt.
 * Useful for debugging and tuning token limits.
 */
export interface TokenUsageStats {
  /** Tokens in system prompt */
  systemTokens: number;
  /** Tokens in situation prompt */
  situationTokens: number;
  /** Combined total */
  totalTokens: number;
  /** Whether compressed mode was used for this prompt */
  isCompressed: boolean;
  /** Breakdown of situation prompt components */
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
  };
  /** Configured limits for reference */
  limits: PromptTokenLimits;
}

// -----------------------------------------------------------------------------
// HELPER: PLAN STATE EXTRACTION
// -----------------------------------------------------------------------------

/**
 * Extract commonly-needed plan state in one place.
 * Reduces repetitive code for analyzing current cycle/step progress.
 */
export function getPlanState(plan: SessionPlan): PlanState {
  const completedCycles = plan.cycles.filter((c) => c.isCompleted).length;
  const currentCycleIdx = getCurrentCycleIndex(plan);
  const currentCycle =
    currentCycleIdx >= 0 ? plan.cycles[currentCycleIdx] : null;
  const stepsInCurrentCycle = currentCycle?.cycleSteps.length || 0;

  return {
    completedCycles,
    currentCycleIdx,
    currentCycle,
    stepsInCurrentCycle,
  };
}

// -----------------------------------------------------------------------------
// PROMPT FORMATTING HELPERS
// -----------------------------------------------------------------------------

/**
 * Format task context section showing current cycle and progress.
 */
export function formatTaskContext(
  plan: SessionPlan,
  planState: PlanState,
): string {
  const lastStep =
    planState.currentCycle?.cycleSteps[
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

/**
 * Format execution metrics section (failures, replans, reperceives).
 */
export function formatExecutionMetrics(metrics: ExecutionMetrics): string {
  const items: string[] = [];

  if (metrics.consecutiveFailures > 0) {
    items.push(`⚠️ ${metrics.consecutiveFailures} consecutive failure(s)`);
  }
  if (metrics.replanCount > 0) {
    items.push(`Replanned ${metrics.replanCount} time(s) this cycle`);
  }
  if (metrics.reperceiveCount > 0) {
    items.push(`Re-perceived ${metrics.reperceiveCount} time(s)`);
  }

  return items.length > 0 ? `\n\nSESSION STATE:\n${items.join('\n')}` : '';
}

/**
 * Format action history section.
 *
 * @param history - Previous steps
 * @param maxItems - Maximum items to show (default: 5)
 * @param maxTokens - Optional token limit for history section
 */
export function formatHistory(
  history: StepResult[],
  maxItems: number = 5,
  maxTokens?: number,
): string {
  if (history.length === 0) return '';

  const recentHistory = history.slice(-maxItems);
  let formatted =
    '\n\nPREVIOUS ACTIONS:\n' +
    recentHistory
      .map((step, i) => {
        const status = step.success ? '✔' : '✗';
        return `${i + 1}. [${status}] ${step.action.type}: ${step.action.reason}`;
      })
      .join('\n');

  // Apply token limit if specified
  if (maxTokens && countTokens(formatted) > maxTokens) {
    formatted = smartTruncate(formatted, {
      maxTokens,
      headRatio: 0.3, // Keep more recent (tail) for history
      separator: '\n[...earlier actions...]\n',
    });
  }

  return formatted;
}

/**
 * Format goal context section (additional context data).
 */
export function formatGoalContext(goal: Goal | undefined): string {
  if (!goal?.context || Object.keys(goal.context).length === 0) return '';

  return (
    '\n\nGOAL CONTEXT:\n' +
    Object.entries(goal.context)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n')
  );
}

/**
 * Format user intervention section (if present).
 */
export function formatIntervention(intervention?: Intervention): string {
  if (!intervention) return '';

  let text = `\n\nUSER INTERVENTION at ${intervention.point}:`;
  if (intervention.previousResult) {
    text += `\nPrevious decision: ${formatThinkResult(intervention.previousResult)}`;
  }
  text += `\nUser instruction: "${intervention.instruction}"`;
  text += `\n\nIncorporate the user's guidance into your next decision.`;

  return text;
}

/**
 * Format a ThinkResult as a human-readable string for intervention context.
 */
export function formatThinkResult(result: ThinkResult): string {
  switch (result.type) {
    case 'ACTION':
      return `ACTION - ${result.action.type}${result.action.selector ? ` on element [${result.action.selector}]` : ''}${result.action.text ? `: "${result.action.text}"` : ''} (${result.action.reason})`;
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
// BASE SYSTEM PROMPT
// -----------------------------------------------------------------------------

/**
 * Build the base system prompt with goal information.
 */
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

AVAILABLE ACTIONS (for type "ACTION"):
- click: Click on an element. Requires "selector" (element index number).
- type: Type text into an input. Requires "selector" (element index) and "text".
- scroll: Scroll the page. Requires "text" with value "up" or "down".
- navigate: Go to a URL. Requires "text" with the URL.
- wait: Wait for the page to update. No parameters needed.

RESULT TYPES:
- ACTION: Execute a browser action (click, type, scroll, navigate, wait)
- GOAL_SUCCESS: Goal is complete. Requires "finalAnswer" with what was accomplished.
- FAIL: Cannot proceed. Requires "error" explaining why.
- REPLAN: Current approach isn't working. Requires "reason" for replanning.
- RETRY_PERCEPTION: Page changed or elements missing. Triggers re-scrape.

RULES:
1. Always respond with valid JSON in this exact format:

For actions:
{
  "thinking": "your step-by-step reasoning",
  "resultType": "ACTION",
  "action": {
    "type": "click|type|scroll|navigate|wait",
    "selector": "element index number (for click/type)",
    "text": "text to type, URL to navigate, or scroll direction",
    "reason": "brief explanation"
  }
}

For goal success:
{
  "thinking": "your reasoning",
  "resultType": "GOAL_SUCCESS",
  "finalAnswer": "what was accomplished"
}

For failure:
{
  "thinking": "your reasoning",
  "resultType": "FAIL",
  "error": "why it failed"
}

For replan:
{
  "thinking": "your reasoning",
  "resultType": "REPLAN",
  "reason": "why the current approach needs to change"
}

For retry perception:
{
  "thinking": "your reasoning",
  "resultType": "RETRY_PERCEPTION"
}

2. For click and type actions, use the element INDEX NUMBER (e.g., "1", "2", "3") from the interactive elements list.

3. Be efficient - don't take unnecessary actions.

4. Use FAIL only when the goal is truly impossible.

5. Use GOAL_SUCCESS only when the goal is truly accomplished.

6. Use REPLAN if you're stuck or need to try a different approach.

7. Use RETRY_PERCEPTION if you expect elements that aren't showing up.`;
}

/**
 * Build a compressed system prompt for repeat cycles.
 * Omits verbose JSON examples since the model has "learned" them in cycle 1.
 * Saves ~300-400 tokens per repeat cycle.
 */
function buildCompressedSystemPrompt(
  goalName: string,
  progress: string,
  strategy: CycleStrategy,
): string {
  return `You are continuing a repetitive web automation task.

GOAL: ${goalName}
PROGRESS: ${progress}

LEARNED PATTERN (from previous cycles):
${strategy.pattern}

TYPICAL STEPS: ${strategy.stepSequence.join(' → ')}

KEY ELEMENTS TO LOOK FOR: ${strategy.keyElements.join(', ')}

ACTIONS: click, type, scroll, navigate, wait (use element index for selector)
RESULTS: ACTION, GOAL_SUCCESS, FAIL, REPLAN, RETRY_PERCEPTION

Respond with JSON: {"thinking": "...", "resultType": "...", ...}
For ACTION: include "action": {"type": "...", "selector": "...", "text": "...", "reason": "..."}`;
}

/**
 * Check if we should use compressed prompt mode.
 * Returns true if:
 * - At least one cycle completed successfully
 * - CycleStrategy exists
 * - No recent failures
 * - Multi-cycle task (more than 1 cycle total)
 */
function shouldUseCompressedMode(
  plan: SessionPlan,
  planState: PlanState,
  consecutiveFailures: number,
): boolean {
  return (
    plan.cycles.length > 1 &&
    planState.completedCycles > 0 &&
    plan.cycleStrategy !== undefined &&
    consecutiveFailures === 0
  );
}

/**
 * Extract a cycle strategy from the first completed cycle.
 * Call this after cycle 1 completes successfully.
 */
export function extractCycleStrategy(plan: SessionPlan): CycleStrategy | null {
  const firstCycle = plan.cycles[0];
  if (
    !firstCycle ||
    !firstCycle.isCompleted ||
    firstCycle.cycleSteps.length === 0
  ) {
    return null;
  }

  // Extract step descriptions as the sequence
  const stepSequence = firstCycle.cycleSteps.map((s) => s.stepDescription);

  // Extract key element patterns from step descriptions
  const keyElements: string[] = [];
  const elementPatterns = [
    'button',
    'input',
    'link',
    'form',
    'submit',
    'next',
    'answer',
  ];
  for (const step of stepSequence) {
    const lower = step.toLowerCase();
    for (const pattern of elementPatterns) {
      if (lower.includes(pattern) && !keyElements.includes(pattern)) {
        keyElements.push(pattern);
      }
    }
  }

  return {
    pattern: plan.cycleDescription,
    stepSequence: stepSequence.slice(0, 5), // Keep first 5 steps max
    keyElements:
      keyElements.length > 0 ? keyElements : ['interactive elements'],
  };
}

// -----------------------------------------------------------------------------
// BUILD PROMPT
// -----------------------------------------------------------------------------

/**
 * Result from buildPrompt including token usage statistics.
 */
export interface BuildPromptResult {
  systemPrompt: string;
  situationPrompt: string;
  tokenStats: TokenUsageStats;
}

/**
 * Construct the prompt that tells the AI what to do.
 *
 * Applies token limits to ensure prompts fit within model context windows.
 *
 * @param pageState - Current page state from perceive.ts
 * @param goal - User's goal (optional if preset provided)
 * @param preset - Pre-configured task template (optional)
 * @param plan - Current session plan
 * @param history - Previous actions taken
 * @param sessionState - Execution metrics
 * @param intervention - Optional user intervention
 * @param limits - Token limits (defaults to DEFAULT_PROMPT_LIMITS)
 * @returns System prompt, situation prompt, and token usage statistics
 */
export function buildPrompt(
  pageState: PageState,
  goal: Goal | undefined,
  preset: Preset | undefined,
  plan: SessionPlan,
  history: StepResult[],
  sessionState: ExecutionMetrics,
  intervention?: Intervention,
  limits: PromptTokenLimits = DEFAULT_PROMPT_LIMITS,
): BuildPromptResult {
  // ---------------------------------------------------------------------------
  // Extract plan state first (needed for compression check)
  // ---------------------------------------------------------------------------
  const planState = getPlanState(plan);
  const goalName = preset?.name || goal?.name || 'Unknown Goal';
  const goalDescription = goal?.description || preset?.description || '';
  const successCriteria = goal?.successCriteria || '';
  const progress = getProgress(plan);

  // ---------------------------------------------------------------------------
  // System Prompt - use compressed version for repeat cycles
  // ---------------------------------------------------------------------------
  const useCompressed = shouldUseCompressedMode(
    plan,
    planState,
    sessionState.consecutiveFailures,
  );

  let systemPrompt: string;

  if (useCompressed && plan.cycleStrategy) {
    // Compressed mode for repeat cycles
    systemPrompt = buildCompressedSystemPrompt(
      goalName,
      progress,
      plan.cycleStrategy,
    );

    // Still add preset's custom system prompt if available (but abbreviated)
    if (preset?.systemPrompt) {
      systemPrompt += `\n\nADDITIONAL: ${preset.systemPrompt}`;
    }
  } else {
    // Full mode for first cycle or after failures
    const baseSystemPrompt = buildBaseSystemPrompt(
      goalName,
      goalDescription,
      successCriteria,
      progress,
    );

    systemPrompt = preset?.systemPrompt
      ? `${baseSystemPrompt}\n\nADDITIONAL INSTRUCTIONS:\n${preset.systemPrompt}`
      : baseSystemPrompt;
  }

  // ---------------------------------------------------------------------------
  // Situation Prompt (the current situation)
  // ---------------------------------------------------------------------------
  const taskContext = formatTaskContext(plan, planState);
  const metricsText = formatExecutionMetrics(sessionState);
  const historyText = formatHistory(history, 5, limits.historyTokens);
  const contextText = formatGoalContext(goal);
  const interventionText = formatIntervention(intervention);

  // Track if markdown was truncated
  const originalMarkdownTokens = countTokens(pageState.markdown);
  const markdownTruncated = originalMarkdownTokens > limits.markdownTokens;

  // Apply token limits to content
  const truncatedMarkdown = smartTruncate(pageState.markdown, {
    maxTokens: limits.markdownTokens,
    headRatio: 0.6,
    separator: '\n\n[... content truncated ...]\n\n',
  });

  // Limit elements by count and tokens
  const limitedElements = limitElements(
    pageState.elements,
    limits.maxElements,
    limits.elementsTokens,
  );
  const elementsText = formatElementsForAI(limitedElements);
  const elementsLimited = limitedElements.length < pageState.elements.length;

  // Add note if elements were limited
  const elementsNote = elementsLimited
    ? `\n(Showing ${limitedElements.length} of ${pageState.elements.length} elements, prioritized by importance)`
    : '';

  // Build page info section
  const pageInfo = `CURRENT PAGE:\nURL: ${pageState.url}\nTitle: ${pageState.title}`;

  const situationPrompt = `${taskContext}

${pageInfo}

PAGE CONTENT:
${truncatedMarkdown}

INTERACTIVE ELEMENTS:${elementsNote}
${elementsText}
${contextText}
${metricsText}
${historyText}
${interventionText}

What should you do next? Remember to respond with valid JSON only.`;

  // ---------------------------------------------------------------------------
  // Calculate token statistics
  // ---------------------------------------------------------------------------
  const systemTokens = countTokens(systemPrompt);
  const situationTokens = countTokens(situationPrompt);

  const tokenStats: TokenUsageStats = {
    systemTokens,
    situationTokens,
    totalTokens: systemTokens + situationTokens,
    isCompressed: useCompressed,
    breakdown: {
      taskContext: countTokens(taskContext),
      pageInfo: countTokens(pageInfo),
      markdown: countTokens(truncatedMarkdown),
      markdownTruncated,
      elements: countTokens(elementsText + elementsNote),
      elementsLimited,
      elementsShown: limitedElements.length,
      elementsTotal: pageState.elements.length,
      history: countTokens(historyText),
      goalContext: countTokens(contextText),
      metrics: countTokens(metricsText),
      intervention: countTokens(interventionText),
    },
    limits,
  };

  return { systemPrompt, situationPrompt, tokenStats };
}

/**
 * Log token usage statistics to console.
 * Call this in verbose mode to debug token budgets.
 */
export function logTokenUsage(stats: TokenUsageStats): void {
  const { breakdown, limits } = stats;

  console.log('\n📊 Token Usage:');
  console.log(
    `   Mode:      ${stats.isCompressed ? '⚡ Compressed (repeat cycle)' : '📝 Full (first cycle)'}`,
  );
  console.log(`   System:    ${stats.systemTokens} tokens`);
  console.log(`   Situation: ${stats.situationTokens} tokens`);
  console.log(`   Total:     ${stats.totalTokens} tokens`);

  console.log('\n   Breakdown:');
  console.log(`   - Task context:  ${breakdown.taskContext}`);
  console.log(`   - Page info:     ${breakdown.pageInfo}`);
  console.log(
    `   - Markdown:      ${breakdown.markdown}/${limits.markdownTokens}${breakdown.markdownTruncated ? ' (truncated)' : ''}`,
  );
  console.log(
    `   - Elements:      ${breakdown.elements}/${limits.elementsTokens} (${breakdown.elementsShown}/${breakdown.elementsTotal} items)${breakdown.elementsLimited ? ' (limited)' : ''}`,
  );
  console.log(
    `   - History:       ${breakdown.history}/${limits.historyTokens}`,
  );

  if (breakdown.goalContext > 0) {
    console.log(`   - Goal context:  ${breakdown.goalContext}`);
  }
  if (breakdown.metrics > 0) {
    console.log(`   - Metrics:       ${breakdown.metrics}`);
  }
  if (breakdown.intervention > 0) {
    console.log(`   - Intervention:  ${breakdown.intervention}`);
  }
}

// -----------------------------------------------------------------------------
// PLAN GENERATION PROMPTS
// -----------------------------------------------------------------------------

/** Default token limit for goal descriptions in plan prompts */
const PLAN_PROMPT_DESCRIPTION_LIMIT = 500;

/**
 * Truncate goal fields if they exceed token limits.
 * Keeps prompts reasonable even with verbose user input.
 */
function truncateGoalFields(
  goal: Goal,
  maxDescriptionTokens: number = PLAN_PROMPT_DESCRIPTION_LIMIT,
): { name: string; description: string; successCriteria: string } {
  const name = goal.name; // Names are typically short, no truncation needed
  const description = smartTruncate(goal.description, {
    maxTokens: maxDescriptionTokens,
    headRatio: 0.7,
    separator: ' [...] ',
  });
  const successCriteria = goal.successCriteria
    ? smartTruncate(goal.successCriteria, {
        maxTokens: Math.floor(maxDescriptionTokens / 2),
        headRatio: 0.8,
        separator: ' [...] ',
      })
    : '';

  return { name, description, successCriteria };
}

/**
 * Build the prompt for initial plan generation.
 * Analyzes the goal to determine how many cycles are needed.
 *
 * @param goal - User's goal
 * @param maxDescriptionTokens - Max tokens for description (default: 500)
 * @returns Prompt string for the LLM
 */
export function buildPlanGenerationPrompt(
  goal: Goal,
  maxDescriptionTokens: number = PLAN_PROMPT_DESCRIPTION_LIMIT,
): string {
  const { name, description, successCriteria } = truncateGoalFields(
    goal,
    maxDescriptionTokens,
  );

  return `Analyze this automation goal and determine how many "cycles" it requires.
A cycle is one complete unit of work. Examples:
- "Complete 10 quizzes" = 10 cycles (each quiz is one cycle)
- "Apply to 5 jobs" = 5 cycles (each application is one cycle)
- "Search for weather" = 1 cycle (one search task)

Goal: ${name}
Description: ${description}
${successCriteria ? `Success criteria: ${successCriteria}` : ''}

Respond with JSON only:
{
  "goalSummary": "<high-level summary of what we're trying to accomplish>",
  "cycleCount": <number>,
  "cycleDescription": "<what one cycle accomplishes>"
}`;
}

/**
 * Build the prompt for replanning when the current approach isn't working.
 *
 * @param goal - User's goal
 * @param existingPlan - Current session plan
 * @param replanReason - Why replanning is needed
 * @param completedCycles - Number of completed cycles
 * @param stepsInCurrentCycle - Steps taken in current cycle
 * @param maxDescriptionTokens - Max tokens for description (default: 500)
 * @returns Prompt string for the LLM
 */
export function buildReplanPrompt(
  goal: Goal,
  existingPlan: SessionPlan,
  replanReason: string,
  completedCycles: number,
  stepsInCurrentCycle: number,
  maxDescriptionTokens: number = PLAN_PROMPT_DESCRIPTION_LIMIT,
): string {
  const { name, description, successCriteria } = truncateGoalFields(
    goal,
    maxDescriptionTokens,
  );

  return `The current automation plan isn't working and needs adjustment.

ORIGINAL GOAL:
Name: ${name}
Description: ${description}
${successCriteria ? `Success criteria: ${successCriteria}` : ''}

CURRENT PLAN:
Goal summary: ${existingPlan.goalSummary}
Cycle description: ${existingPlan.cycleDescription}
Progress: ${completedCycles}/${existingPlan.cycles.length} cycles completed
Steps in current cycle: ${stepsInCurrentCycle}

REASON FOR REPLAN:
${replanReason}

Analyze the situation and provide an adjusted plan. You may:
- Keep the same number of cycles but change approach
- Add more cycles if the task is more complex than expected
- Simplify if the current approach is over-complicated

Respond with JSON only:
{
  "goalSummary": "<updated summary reflecting new approach>",
  "cycleCount": <number>,
  "cycleDescription": "<what one cycle accomplishes with new approach>",
  "adjustment": "<brief explanation of what changed>"
}`;
}

// -----------------------------------------------------------------------------
// SIMPLE QUESTION PROMPT
// -----------------------------------------------------------------------------

/** Default token limit for simple questions */
const SIMPLE_QUESTION_LIMIT = 500;

/**
 * Build a prompt for a simple question to the LLM.
 * Applies token limit to prevent overly long questions.
 *
 * @param question - The question to ask
 * @param maxTokens - Max tokens for the question (default: 500)
 * @returns The (possibly truncated) question
 */
export function buildSimpleQuestionPrompt(
  question: string,
  maxTokens: number = SIMPLE_QUESTION_LIMIT,
): string {
  return smartTruncate(question, {
    maxTokens,
    headRatio: 0.8,
    separator: ' [...] ',
  });
}

// -----------------------------------------------------------------------------
// TEST: Run this file directly to verify prompt module works
// -----------------------------------------------------------------------------
// Usage: npm run test:prompt

import { fileURLToPath } from 'url';

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('🧪 Testing prompt module...\n');

  // Test token counting
  console.log('📊 Token counting tests:');
  const testTexts = [
    'Hello, world!',
    'The quick brown fox jumps over the lazy dog.',
    'A'.repeat(100),
  ];

  for (const text of testTexts) {
    const tokens = countTokens(text);
    console.log(
      `   "${text.substring(0, 30)}..." (${text.length} chars) = ${tokens} tokens`,
    );
  }

  // Test smart truncation
  console.log('\n✂️ Smart truncation test:');
  const longText = Array.from(
    { length: 100 },
    (_, i) =>
      `Paragraph ${i + 1}. This is some sample content that represents a typical web page paragraph.`,
  ).join('\n\n');
  const originalTokens = countTokens(longText);
  console.log(`   Original: ${originalTokens} tokens`);

  const truncated = smartTruncate(longText, { maxTokens: 200 });
  const truncatedTokens = countTokens(truncated);
  console.log(`   Truncated: ${truncatedTokens} tokens`);
  console.log(`   Preview: ${truncated.substring(0, 100)}...`);
  console.log(`   ...${truncated.substring(truncated.length - 100)}`);

  // Test element limiting
  console.log('\n🎯 Element limiting test:');
  const mockElements: ElementInfo[] = [
    {
      index: 1,
      tag: 'a',
      text: 'Home',
      selector: 'a.home',
      attributes: { href: '/' },
    },
    {
      index: 2,
      tag: 'input',
      text: 'Search',
      selector: 'input.search',
      inputType: 'text',
      attributes: { placeholder: 'Search...' },
    },
    {
      index: 3,
      tag: 'button',
      text: 'Submit',
      selector: 'button.submit',
      attributes: {},
    },
    {
      index: 4,
      tag: 'a',
      text: 'About',
      selector: 'a.about',
      attributes: { href: '/about' },
    },
    {
      index: 5,
      tag: 'select',
      text: 'Choose option',
      selector: 'select.options',
      attributes: {},
    },
    {
      index: 6,
      tag: 'div',
      text: 'Click me',
      selector: 'div.clickable',
      attributes: { onclick: 'alert()' },
    },
  ];

  console.log(`   Original: ${mockElements.length} elements`);
  const limited = limitElements(mockElements, 4, 500);
  console.log(`   Limited to 4 max: ${limited.length} elements`);
  console.log(
    `   Kept: ${limited.map((e) => `[${e.index}] ${e.tag}`).join(', ')}`,
  );

  // Test formatElementsForAI
  console.log('\n📝 Format elements test:');
  const formatted = formatElementsForAI(limited);
  console.log(formatted);

  // Test buildPrompt with mock data
  console.log('\n🏗️ Build prompt test:');
  const mockPageState: PageState = {
    url: 'https://example.com',
    title: 'Example Page',
    markdown:
      'This is a test page with some content.\n\n' + 'Lorem ipsum '.repeat(500),
    elements: mockElements,
  };

  const mockGoal: Goal = {
    name: 'Test Goal',
    description: 'Test the prompt building',
    context: { key: 'value' },
  };

  const mockPlan: SessionPlan = {
    goalSummary: 'Testing prompt module',
    cycleDescription: 'One test cycle',
    cycles: [{ isCompleted: false, cycleSteps: [] }],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };

  const mockMetrics: ExecutionMetrics = {
    consecutiveFailures: 0,
    replanCount: 0,
    reperceiveCount: 0,
  };

  const { systemPrompt, situationPrompt } = buildPrompt(
    mockPageState,
    mockGoal,
    undefined,
    mockPlan,
    [],
    mockMetrics,
  );

  console.log(`   System prompt: ${countTokens(systemPrompt)} tokens`);
  console.log(`   Situation prompt: ${countTokens(situationPrompt)} tokens`);
  console.log(
    `   Total: ${countTokens(systemPrompt) + countTokens(situationPrompt)} tokens`,
  );

  console.log('\n✅ Prompt module test complete!');
}
