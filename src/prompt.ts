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
//   - Drift Analysis Prompt: For verifying execution path state
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
  SessionTracker,
  StepResult,
  ThinkResult,
  ResolvedConfig,
  Cycle,
  CycleStrategy,
  InterventionPoint,
  Action
} from './types/index.js';
import { getProgress, getCurrentCycleIndex } from './types/index.js';

// Re-export types for convenience
export type { CycleStrategy } from './types/index.js';

export type PromptTokenLimits = Pick<
  ResolvedConfig,
  'tokenMarkdown' | 'tokenElements' | 'tokenMaxElements' | 'tokenHistory'
>;

/**
 * Default prompt token limits.
 * Reads from environment variables with fallback to sensible defaults.
 * Balanced for ~4300 total tokens in the situation prompt.
 */


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
  const keyAttrs = ['href', 'placeholder', 'name', 'checked'];
  for (const attr of keyAttrs) {
    if (el.attributes[attr]) {
      line += ` [${attr}="${el.attributes[attr]}"]`;
    }
  }
  // Mark elements that are outside the viewport
  if (el.offscreen) {
    line += ` [OFFSCREEN - scroll to see]`;
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

export interface InterventionMetrics {
  consecutiveFailures: number;
  replanCount: number;
  reobserveCount: number;
  llmParseFailures: number;
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

export function getPlanState(tracker: SessionTracker): PlanState {
  const completedCycles = tracker.cycles.filter((c) => c.isCompleted).length;
  const currentCycleIdx = getCurrentCycleIndex(tracker);
  const currentCycle = currentCycleIdx >= 0 ? tracker.cycles[currentCycleIdx] : null;
  const stepsInCurrentCycle = currentCycle?.cycleSteps.length || 0;
  return { completedCycles, currentCycleIdx, currentCycle, stepsInCurrentCycle };
}

// -----------------------------------------------------------------------------
// PROMPT FORMATTING HELPERS
// -----------------------------------------------------------------------------

export function formatTaskContext(tracker: SessionTracker, planState: PlanState): string {
  const lastStep = planState.currentCycle?.cycleSteps[
      planState.currentCycle.cycleSteps.length - 1
  ];

  let context = `TASK CONTEXT:
Goal: ${tracker.goalSummary}
Cycle ${planState.currentCycleIdx + 1}/${tracker.cycles.length}: ${tracker.cycleDescription}
Steps in this cycle: ${planState.stepsInCurrentCycle}`;

  // Add page context from last step if available
  if (lastStep?.pageContext) {
    const pc = lastStep.pageContext;
    if (pc.topic) {
      context += `\nTopic: ${pc.topic}`;
    }
    if (pc.progress) {
      context += `\nProgress: ${pc.progress}`;
    }
  }

  if (lastStep) {
    context += `\nLast action: ${lastStep.stepDescription}`;
  }
  return context;
}

export function formatInterventionMetrics(metrics: InterventionMetrics): string {
  const items: string[] = [];
  if (metrics.consecutiveFailures > 0) items.push(`⚠️ ${metrics.consecutiveFailures} consecutive failure(s)`);
  if (metrics.replanCount > 0) items.push(`Replanned ${metrics.replanCount} time(s) this cycle`);
  if (metrics.reobserveCount > 0) items.push(`Re-observed ${metrics.reobserveCount} time(s)`);
  if (metrics.llmParseFailures > 0) items.push(`⚠️ ${metrics.llmParseFailures} LLM parse failure(s)`);
  return items.length > 0 ? `\n\nSESSION STATE:\n${items.join('\n')}` : '';
}

export function formatHistory(history: StepResult[], maxItems: number = 5, maxTokens?: number): string {
  if (history.length === 0) return '';
  const recentHistory = history.slice(-maxItems);

  // Detect loops: same action type + same selectors appearing multiple times
  const actionSignatures = recentHistory.map(h => {
    const ids = h.action.elementIds?.join(',') || h.action.elementId || '';
    return `${h.action.type}:${ids}`;
  });
  const signatureCounts = new Map<string, number>();
  for (const sig of actionSignatures) {
    signatureCounts.set(sig, (signatureCounts.get(sig) || 0) + 1);
  }
  const hasLoop = Array.from(signatureCounts.values()).some(count => count >= 2);

  let formatted = '\n\nPREVIOUS ACTIONS:';
  if (hasLoop) {
    formatted += '\n⚠️ WARNING: Repeated actions detected! You are stuck in a loop. Try a DIFFERENT approach (e.g., scroll first, use JS click, or check if task is already done).';
  }

  formatted += '\n' + recentHistory.map((step, i) => {
    const status = step.success ? '✔' : '✗';
    const ids = step.action.elementIds?.join(', ') || step.action.elementId || '';
    const target = ids ? ` on [${ids}]` : '';
    let line = `${i + 1}. [${status}] ${step.action.type}${target}: ${step.action.reason}`;
    
    if (!step.success && step.error) {
       line += `\n   ERROR: ${step.error}`;
    }
    return line;
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

export function formatStrategy(strategy?: CycleStrategy): string {
  if (!strategy) return '';
  return `\n\nLEARNED STRATEGY from previous cycles:
- Pattern: ${strategy.pattern}
- Best Sequence: ${strategy.stepSequence.join(' -> ')}
- Critical Elements: ${strategy.keyElements.join(', ')}`;
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
  customInstructions?: string,
): string {
  const identity = customInstructions || 
    'You are a web automation agent. Analyze the page and decide the SINGLE next action.';

  return `${identity}

GOAL: ${goalName}
${goalDescription}
${successCriteria ? `\nSUCCESS CRITERIA: ${successCriteria}` : ''}

PROGRESS: ${progress}

DECISION PROCESS:
1. Understand the GOAL and SUCCESS CRITERIA - what you are trying to accomplish
2. Check PREVIOUS ACTIONS to understand context and avoid repeating failed/same actions
3. Analyze INTERACTIVE ELEMENTS to see what actions are available on this page
4. Determine the logical next step that progresses toward the goal, or submit if ready

RULES:
- NEVER click elements already in desired state (e.g., [checked="true"] means already selected)
- NEVER repeat the same action on same elements - check PREVIOUS ACTIONS
- After filling forms or selecting options, click the submit/next button to proceed
- If needed elements are marked [OFFSCREEN], use scroll_to_element to bring them into view in one step
- Include page context (title, progress indicators) in your action reason

AVAILABLE ACTIONS:
- click: Click one element. Requires "elementId" (element index). Use this for buttons, links, and any element whose click may trigger navigation, modals, or DOM changes.
- multi_click: Select multiple checkboxes, toggles, or radio buttons in one step. Requires "elementIds" array. ONLY use for form controls that do NOT trigger page navigation or major DOM re-renders (e.g. ticking several checkboxes in a list). NEVER use for buttons, links, or elements that open modals/popups. If unsure, use individual "click" actions instead.
- type: Type text. Requires "elementId" and "text"
- scroll_to_element: Scroll a specific element into view. Requires "elementId". PREFERRED when you need to reach an [OFFSCREEN] element — brings it into the viewport in one step regardless of distance. Use this instead of repeated "scroll" actions.
- scroll: Blind scroll the page. Requires "text" ("up" or "down"). Only use when exploring for elements not yet observed (e.g. scanning a long page for content). If you already see the target element marked [OFFSCREEN], use scroll_to_element instead.
- navigate: Go to URL. Requires "text" (the URL)
- wait: Wait for page to update

REASON FIELD RULES:
- The "reason" field must describe ONLY what THIS action does, not future steps
- BAD: "Scroll down to bring button into view and click it" (describes two actions)
- GOOD: "Scroll down to bring 'Submit' button into view" (describes only scroll)
- Each action is separate - you will decide the next action after this one completes

GOAL_SUCCESS RULES:
- Only declare when you see CLEAR EVIDENCE of completion (confirmation message, results page, success indicator)
- If there's still a submit/next button visible, you are NOT done

RESPONSE FORMAT (JSON):

For click/type/scroll_to_element/scroll/navigate/wait (single element):
{
  "resultType": "ACTION",
  "thinking": "Why this action based on current page state and previous actions",
  "action": {
    "type": "click|type|scroll_to_element|scroll|navigate|wait",
    "elementId": "14",
    "text": "optional text",
    "reason": "Brief description with page context"
  }
}

For multi_click (checkboxes/toggles only):
{
  "resultType": "ACTION",
  "thinking": "These are all checkboxes that won't trigger navigation or re-renders",
  "action": {
    "type": "multi_click",
    "elementIds": ["6", "8", "10"],
    "reason": "Select the three unchecked option checkboxes"
  }
}

{
  "resultType": "GOAL_SUCCESS",
  "thinking": "What evidence on the page proves completion",
  "finalAnswer": "Summary of what was accomplished"
}

{ "resultType": "FAIL", "thinking": "...", "error": "Why impossible to proceed" }
{ "resultType": "REPLAN", "thinking": "...", "reason": "Why strategy needs to change" }
{ "resultType": "RETRY_PERCEPTION", "thinking": "Why page needs to be re-scanned" }`;
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
    const systemPrompt = `You are an adaptive execution expert for browser automation.
Your job is to compare an EXPECTED page state with the CURRENT page state and decide if the PLANNED ACTION can still proceed.

OUTPUT FORMAT: JSON
{
  "decision": "can_proceed" | "cannot_complete",
  "reason": "explanation...",
  "adaptedAction": { // ONLY if can_proceed and action needs adaptation
    "type": "action_type",
    "elementId": "element_index",
    "text": "text if needed",
    "reason": "why this action"
  }
}

DECISION RULES:
- can_proceed: The goal can still be accomplished. Either:
  1. The expected element exists with same elementId (return decision without adaptedAction)
  2. The expected element moved/changed but it's still the same control (return decision WITH adaptedAction containing new elementId)

- cannot_complete: The page changed fundamentally. The goal is no longer achievable on this page.
  Examples: Complete UI redesign, page no longer has the feature, completely different content.

ADAPTATION GUIDELINES:
1. If you find the same element with different elementId/index, provide adaptedAction
2. If the element text/context changed slightly but it's still the same control, provide adaptedAction
3. Only return "cannot_complete" if the goal is truly impossible on this page
4. Be adaptive - minor changes should result in "can_proceed"`;

    const userPrompt = `PLANNED ACTION: ${plannedAction.type} on ${plannedAction.elementId} ("${plannedAction.reason}")

EXPECTED TARGET CONTEXT:
${elementContext}

CURRENT PAGE STATE (Interactive Elements):
${formatElementsForAI(limitElements(currentState.elements, 50, 2000))}

Can we proceed with this action (possibly adapted)? Or is the goal impossible on this page?`;

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
  tracker: SessionTracker,
  history: StepResult[],
  interventionMetrics: InterventionMetrics,
  limits: PromptTokenLimits,
  intervention?: Intervention,
  customSystemPrompt?: string,
): BuildPromptResult {

  // 1. Analyze Plan State
  const planState = getPlanState(tracker);

  // 2. Build Context Strings
  const goalName = preset?.name || goal?.name || 'Task';
  const goalDescription = preset?.description || goal?.description || ''; // Assuming description handles intervention overrides if any
  const successCriteria = preset?.goal?.successCriteria || goal?.successCriteria || '';
  const progressStr = getProgress(tracker);
  const taskContext = formatTaskContext(tracker, planState);
  const goalContextStr = formatGoalContext(goal);
  const interventionStr = formatIntervention(intervention);
  const metricsStr = formatInterventionMetrics(interventionMetrics);
  const historyStr = formatHistory(history, 5, limits.tokenHistory);
  const strategyStr = formatStrategy(tracker.cycleStrategy);


  // 3. Build System Prompt
  // Check for compressed mode
  const useCompressed = false; // logic removed for brevity/safety - always use full prompt for V2 stability for now
  
  // Use hybrid injection: custom instructions (persona) + base protocol
  const systemPrompt = buildBaseSystemPrompt(
    goalName, 
    goalDescription, 
    successCriteria, 
    progressStr,
    customSystemPrompt
  );

  // 4. Build Situation Prompt (The User Message)
  // Order optimized for LLM decision-making:
  // 1. Task context (what am I doing?)
  // 2. Previous actions (what did I do? - critical for loop detection)
  // 3. Session state (any warnings?)
  // 4. User intervention (highest priority override)
  // 5. Current page (where am I?)
  // 6. Content summary (what's on the page?)
  // 7. Interactive elements (what can I do?)

  // Limit elements
  const limitedElements = limitElements(pageState.elements, limits.tokenMaxElements, limits.tokenElements);
  const elementsStr = formatElementsForAI(limitedElements);

  // Truncate markdown
  const markdownStr = smartTruncate(pageState.markdown, { maxTokens: limits.tokenMarkdown });

  const situationPrompt = `${taskContext}
${goalContextStr}
${strategyStr}
${historyStr}
${metricsStr}
${interventionStr}

CURRENT PAGE:
Title: ${pageState.title}
URL: ${pageState.url}

CONTENT SUMMARY:
${markdownStr}

INTERACTIVE ELEMENTS:
${elementsStr}

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

IMPORTANT GUIDELINES:
1. A "cycle" represents ONE complete unit of work that can be repeated.
2. For quizzes: Use 1 cycle for the ENTIRE quiz (all questions), NOT one cycle per question.
   - The cycle includes: answering all questions AND submitting the quiz
3. For multi-item tasks (e.g., "apply to 5 jobs"): Use 5 cycles (one per application).
4. cycleDescription should describe what completes ONE cycle.
5. goalSummary should describe the overall objective including the final completion step.

Return JSON:
{
  "goalSummary": "Complete description including what indicates success (e.g., 'Complete the quiz and submit it, then see the results page')",
  "cycleDescription": "What one cycle accomplishes (e.g., 'Answer all questions and submit the quiz')",
  "cycleCount": 1
}`;
    const userPrompt = `Goal: ${goal.name}\nDescription: ${goal.description}\n\nCreate a plan with appropriate cycle structure.`;
    return { systemPrompt, userPrompt };
}

export function buildReplanPrompt(reason: string, tracker: SessionTracker): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `You are a planning expert. The agent is stuck. Update the plan.`;
    const userPrompt = `Current Plan: ${JSON.stringify(tracker)}\nReason for replan: ${reason}\n\nProvide updated plan JSON.`;
    return { systemPrompt, userPrompt };
}

export function buildSimpleQuestionPrompt(question: string): { systemPrompt: string; userPrompt: string } {
    return { systemPrompt: 'You are a helpful assistant.', userPrompt: question };
}

export function buildStrategyPrompt(history: StepResult[]): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `You are an automation expert. Review the successful history and extract a "Winning Strategy" (CycleStrategy) for repeat cycles.
Return JSON: { "pattern": "Short description", "stepSequence": ["Action 1", "Action 2"], "keyElements": ["Target ID", "Submit button"] }`;
    const userPrompt = `History: ${JSON.stringify(history.map(h => ({ action: h.action, success: h.success })))}\n\nExtract strategy JSON.`;
    return { systemPrompt, userPrompt };
}

export function logTokenUsage(stats: TokenUsageStats): void {
    if (process.env.VERBOSE !== 'true') return;
    console.log(`\nToken Usage: Total ${stats.totalTokens} (Sys: ${stats.systemTokens}, User: ${stats.situationTokens})`);
}
