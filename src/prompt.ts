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
// - Section-based system prompt with extend/override customization
// - Stage-Aware Prompts:
//   - Execution Prompt: For the main ACTION loop
//   - Drift Analysis Prompt: For verifying execution path state
//   - Planning Prompt: For generating initial plans
//
// Key Exports:
// - DEFAULT_SECTIONS - Default prompt section content
// - CustomPromptConfig - Interface for customizing prompt sections
// - buildExecutionPrompt(...) - Build system + situation prompts
// - buildSystemPromptFromSections(...) - Build system prompt from sections
// - resolveSection(...) - Resolve section with extend/override logic
// - countTokens(text) - Count tokens using tiktoken
// - smartTruncate(text, options) - Head + tail truncation
// - limitElements(...) - Priority-based element limiting
// - formatElementsForAI(elements) - Format elements for LLM
// - buildDriftAnalysisPrompt(...) - Build prompt for verifying state drift
// - buildPlanGenerationPrompt(goal) - Build prompt for initial plan generation
// - buildReplanPrompt(...) - Build prompt for replanning
// - buildStrategyPrompt(...) - Build prompt for strategy extraction
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
  CycleTracker,
  CycleStrategy,
  InterventionPoint,
  Action,
  WebAction
} from './types/index.js';
import { getCurrentCycleIndex } from './types/index.js';

// Re-export types for convenience
export type { CycleStrategy } from './types/index.js';

// -----------------------------------------------------------------------------
// ACTION DOCUMENTATION (Single Source of Truth)
// -----------------------------------------------------------------------------
// TypeScript will error if any WebAction is missing from this record.
// This ensures prompt stays in sync with implemented actions.

/**
 * Documentation for each action type, used to generate prompt content.
 * Adding a new WebAction requires adding documentation here (compile-time enforced).
 */
export const ACTION_DOCS: Record<WebAction, string> = {
  click: 'Click one element. Requires "elementId". Use for buttons, links, and elements that may trigger navigation or DOM changes. Auto-scrolls into view.',
  multi_click: 'Click multiple checkboxes/toggles in one step. Requires "elementIds" array. ONLY for form controls that do NOT trigger navigation. Auto-scrolls into view.',
  type: 'Type text into input. Requires "elementId" and "text". Auto-scrolls into view.',
  hover: 'Hover over element to trigger dropdowns, tooltips, or reveal hidden content. Requires "elementId". Auto-scrolls into view.',
  select: 'Select option from <select> dropdown. Requires "elementId" and "text" (the option value or label). Auto-scrolls into view.',
  checkbox: 'Toggle checkbox/switch. Requires "elementId", optional "text" ("check"|"uncheck"|"toggle", default: toggle). Auto-scrolls into view.',
  drag: 'Drag element to another element. Requires "elementId" (source) and "text" (target element index). Auto-scrolls into view.',
  scroll: 'Blind scroll page. Requires "text" ("up"|"down"). Only for exploring when target element is not yet visible in element list.',
  navigate: 'Go to URL. Requires "text" (the URL)',
  wait: 'Wait for page to update',
};

/**
 * Generate the AVAILABLE ACTIONS section from ACTION_DOCS.
 * Ensures prompt always matches implemented actions.
 */
export function buildActionsPrompt(): string {
  return Object.entries(ACTION_DOCS)
    .map(([action, desc]) => `- ${action}: ${desc}`)
    .join('\n');
}

// -----------------------------------------------------------------------------
// PROMPT SECTION SYSTEM (Customizable Sections)
// -----------------------------------------------------------------------------

/**
 * Available prompt sections that can be customized.
 * - System sections: Static instructions (same for entire session)
 * - Situation sections: Dynamic state (changes each step)
 */
export type PromptSection =
  | 'identity'           // Who the agent is
  | 'terminalRules'      // GOAL_SUCCESS, FAIL guidance
  | 'recoveryRules'      // REPLAN, RETRY_PERCEPTION guidance
  | 'executionRules'     // WebAction behavioral rules
  | 'responseFormat';    // JSON schemas (protocol - typically immutable)

/**
 * Configuration for a single section.
 * Can be a string (append shorthand) or full config object.
 */
export interface SectionConfig {
  /** Content to add or replace */
  content: string;
  /** If true, replaces default. If false/undefined, appends to default. */
  override?: boolean;
}

/**
 * Custom prompt configuration for presets.
 * All sections are optional - defaults are used when not provided.
 * String values are shorthand for { content: string, override: false } (append mode).
 */
export interface CustomPromptConfig {
  identity?: SectionConfig | string;
  terminalRules?: SectionConfig | string;
  recoveryRules?: SectionConfig | string;
  executionRules?: SectionConfig | string;
  responseFormat?: SectionConfig | string;  // Usually shouldn't override
}

/**
 * Default content for each system prompt section.
 * Designed for clarity and minimal universal coverage.
 */
export const DEFAULT_SECTIONS: Record<PromptSection, string> = {
  identity: `You are a web automation agent. Analyze the page and decide the next action.`,

  terminalRules: `[TERMINAL DECISIONS] - Check first, exit early if applicable
GOAL_SUCCESS: Declare only when you see CLEAR EVIDENCE of completion:
  - Confirmation message, success page, or completion indicator visible
  - All success criteria from [GOAL] section satisfied
  - NO remaining submit/next buttons for the goal
FAIL: Declare only when goal is IMPOSSIBLE to achieve:
  - Required feature doesn't exist on this site
  - Access denied with no workaround
  - Critical error with no recovery path`,

  recoveryRules: `[RECOVERY DECISIONS] - Check if stuck before taking action
RETRY_PERCEPTION: When page state seems stale or incomplete:
  - Expected elements not visible after action completed
  - Page appears changed but elements don't match expectations
REPLAN: When current approach isn't working:
  - Same action failed multiple times (check [PREVIOUS ACTIONS])
  - Detected loop pattern in recent actions
  - Page structure fundamentally different than expected`,

  executionRules: `[EXECUTION RULES]
- Never click elements already in desired state (checked="true" means done)
- Never repeat the same action on same elements - check [PREVIOUS ACTIONS]
- Do NOT scroll before clicking - all actions auto-scroll elements into view
- One action at a time - describe only THIS action in reason field

[AVAILABLE ACTIONS]
${buildActionsPrompt()}`,

  responseFormat: `[RESPONSE FORMAT] - Choose exactly ONE response type

Terminal (check first):
{"resultType":"GOAL_SUCCESS","thinking":"evidence visible...","finalAnswer":"what was accomplished"}
{"resultType":"FAIL","thinking":"why impossible...","error":"specific blocker"}

Recovery (if stuck):
{"resultType":"REPLAN","thinking":"why current approach failing...","reason":"what needs to change"}
{"resultType":"RETRY_PERCEPTION","thinking":"why page state unclear..."}

Execution (default - take action):
{"resultType":"ACTION","thinking":"why this action...","action":{"type":"...","elementId":"...","text":"...","reason":"..."}}

For multi_click only (multiple checkboxes/toggles):
{"resultType":"ACTION","thinking":"...","action":{"type":"multi_click","elementIds":["6","8"],"reason":"..."}}`
};

/**
 * Resolve a section with custom configuration.
 * - No custom config → use default
 * - String → append to default
 * - SectionConfig with override=true → replace default
 * - SectionConfig with override=false/undefined → append to default
 */
export function resolveSection(
  section: PromptSection,
  custom: SectionConfig | string | undefined
): string {
  const defaultContent = DEFAULT_SECTIONS[section];

  // No custom → use default
  if (!custom) {
    return defaultContent;
  }

  // String shorthand → append mode
  if (typeof custom === 'string') {
    return `${defaultContent}\n${custom}`;
  }

  // Override mode → replace
  if (custom.override) {
    return custom.content;
  }

  // Extend mode (default) → append
  return `${defaultContent}\n${custom.content}`;
}

/**
 * Build the complete system prompt from sections.
 * System prompt is static for the session - contains instructions only.
 */
export function buildSystemPromptFromSections(
  customConfig?: CustomPromptConfig
): string {
  const c = customConfig || {};

  const identity = resolveSection('identity', c.identity);
  const terminalRules = resolveSection('terminalRules', c.terminalRules);
  const recoveryRules = resolveSection('recoveryRules', c.recoveryRules);
  const executionRules = resolveSection('executionRules', c.executionRules);
  const responseFormat = resolveSection('responseFormat', c.responseFormat);

  return `${identity}

═══════════════════════════════════════════════════════════════
DECISION FRAMEWORK - Evaluate in this order
═══════════════════════════════════════════════════════════════

${terminalRules}

${recoveryRules}

${executionRules}

${responseFormat}`;
}

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
  // Note: OFFSCREEN tag removed - all actions auto-scroll elements into view
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
  currentCycle: CycleTracker | null;
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
    if (!h.action) return 'no-action';
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
    if (!step.action) return `${i + 1}. [${status}] (no action)`;
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
// SITUATION PROMPT HELPERS
// -----------------------------------------------------------------------------

/**
 * Build the [GOAL] section for situation prompt.
 * Contains objective, success criteria, and runtime context.
 */
function formatGoalSection(
  goalName: string,
  goalDescription: string,
  successCriteria: string,
  goalContext: string
): string {
  let section = `[GOAL]
Objective: ${goalName}`;

  if (goalDescription) {
    section += `\n${goalDescription}`;
  }

  if (successCriteria) {
    section += `\nSuccess Criteria: ${successCriteria}`;
  }

  // goalContext may have leading newlines from formatGoalContext() - strip them
  if (goalContext) {
    section += `\n${goalContext.replace(/^\n+/, '')}`;
  }

  return section;
}

/**
 * Build the [PROGRESS] section for situation prompt.
 * Contains cycle info, steps, and learned strategy.
 */
function formatProgressSection(
  tracker: SessionTracker,
  planState: PlanState,
  strategyStr: string
): string {
  const lastStep = planState.currentCycle?.cycleSteps[
    planState.currentCycle.cycleSteps.length - 1
  ];

  let section = `[PROGRESS]
Cycle ${planState.currentCycleIdx + 1}/${tracker.cycles.length}: ${tracker.cycleDescription}
Steps in this cycle: ${planState.stepsInCurrentCycle}`;

  // Add page context from last step if available
  if (lastStep?.pageContext) {
    const pc = lastStep.pageContext;
    if (pc.topic) {
      section += `\nTopic: ${pc.topic}`;
    }
    if (pc.progress) {
      section += `\nPage Progress: ${pc.progress}`;
    }
  }

  if (lastStep) {
    section += `\nLast action: ${lastStep.stepDescription}`;
  }

  // strategyStr may have leading newlines from formatStrategy() - strip them
  if (strategyStr) {
    section += `\n${strategyStr.replace(/^\n+/, '')}`;
  }

  return section;
}

/**
 * Build the [SESSION STATE] section for situation prompt.
 * Contains warnings, failures, and user interventions.
 */
function formatSessionStateSection(
  metricsStr: string,
  interventionStr: string
): string {
  if (!metricsStr && !interventionStr) {
    return '';
  }

  let section = '[SESSION STATE]';

  if (metricsStr) {
    // metricsStr has '\n\nSESSION STATE:\n' prefix - strip header, keep content
    section += metricsStr.replace(/^\n*SESSION STATE:\n?/i, '\n').replace(/^\n+/, '\n');
  }

  if (interventionStr) {
    // interventionStr has '\n\nUSER INTERVENTION...' prefix - strip leading newlines
    section += interventionStr.replace(/^\n+/, '\n');
  }

  return section;
}


// -----------------------------------------------------------------------------
// DRIFT ANALYSIS HELPERS
// -----------------------------------------------------------------------------

/**
 * Notable changes between two page states.
 * Used for drift detection without overwhelming the AI with full state dumps.
 */
export interface NotableChanges {
  urlChanged: boolean;
  expectedUrl?: string;
  currentUrl?: string;
  titleChanged: boolean;
  expectedTitle?: string;
  currentTitle?: string;
  modalDetected: boolean;
  modalElements: string[];
  targetElementMissing: boolean;
  elementCountDelta: number;
  captchaAppeared: boolean;
}

/**
 * Detect if an element looks like a modal/dialog/overlay.
 */
export function isModalLikeElement(el: ElementInfo): boolean {
  const tag = el.tag.toLowerCase();
  const role = el.attributes['role']?.toLowerCase();
  const ariaModal = el.attributes['aria-modal'];
  const className = el.attributes['class']?.toLowerCase() || '';

  return (
    tag === 'dialog' ||
    role === 'dialog' ||
    role === 'alertdialog' ||
    ariaModal === 'true' ||
    className.includes('modal') ||
    className.includes('overlay') ||
    className.includes('popup') ||
    className.includes('lightbox')
  );
}

/**
 * Extract notable changes between expected and current page states.
 * Provides high-signal drift information without full state comparison.
 */
export function extractNotableChanges(
  expectedState: PageState,
  currentState: PageState,
  targetElementId: string
): NotableChanges {
  const urlChanged = expectedState.url !== currentState.url;
  const titleChanged = expectedState.title !== currentState.title;

  // Detect modal-like elements in current state that weren't in expected state
  const expectedModalIds = new Set(
    expectedState.elements.filter(isModalLikeElement).map(e => e.selector)
  );
  const newModals = currentState.elements.filter(
    el => isModalLikeElement(el) && !expectedModalIds.has(el.selector)
  );

  // Check if target element still exists
  const targetIndex = parseInt(targetElementId, 10);
  const targetExists = currentState.elements.some(el => el.index === targetIndex);

  // Element count change
  const elementCountDelta = currentState.elements.length - expectedState.elements.length;

  // Captcha detection
  const captchaAppeared = !expectedState.captcha?.detected && !!currentState.captcha?.detected;

  return {
    urlChanged,
    expectedUrl: urlChanged ? expectedState.url : undefined,
    currentUrl: urlChanged ? currentState.url : undefined,
    titleChanged,
    expectedTitle: titleChanged ? expectedState.title : undefined,
    currentTitle: titleChanged ? currentState.title : undefined,
    modalDetected: newModals.length > 0,
    modalElements: newModals.map(el => `[${el.index}] ${el.tag}: "${el.text}"`),
    targetElementMissing: !targetExists,
    elementCountDelta,
    captchaAppeared,
  };
}

/**
 * Format notable changes as a concise summary for the AI.
 */
export function formatNotableChanges(changes: NotableChanges): string {
  const lines: string[] = [];

  if (changes.urlChanged) {
    lines.push(`⚠️ URL CHANGED: "${changes.expectedUrl}" → "${changes.currentUrl}"`);
  }

  if (changes.titleChanged) {
    lines.push(`⚠️ TITLE CHANGED: "${changes.expectedTitle}" → "${changes.currentTitle}"`);
  }

  if (changes.modalDetected) {
    lines.push(`⚠️ NEW MODAL/DIALOG DETECTED:`);
    changes.modalElements.forEach(el => lines.push(`   ${el}`));
  }

  if (changes.captchaAppeared) {
    lines.push(`⚠️ CAPTCHA APPEARED: Page now shows a captcha challenge`);
  }

  if (changes.targetElementMissing) {
    lines.push(`⚠️ TARGET ELEMENT MISSING: The planned element is not in current state`);
  }

  if (Math.abs(changes.elementCountDelta) > 10) {
    const direction = changes.elementCountDelta > 0 ? 'increased' : 'decreased';
    lines.push(`ℹ️ Element count ${direction} by ${Math.abs(changes.elementCountDelta)}`);
  }

  if (lines.length === 0) {
    return 'No significant page-level changes detected.';
  }

  return lines.join('\n');
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
    // Extract high-signal changes between expected and current state
    const notableChanges = extractNotableChanges(
        expectedState,
        currentState,
        plannedAction.elementId ?? ''
    );
    const changesSection = formatNotableChanges(notableChanges);

    const systemPrompt = `You are an adaptive execution expert for browser automation.
Your job is to analyze PAGE CHANGES and decide if the PLANNED ACTION can still proceed.

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
  Examples: URL navigated away, modal blocking access, captcha appeared, target feature removed.

ADAPTATION GUIDELINES:
1. If you find the same element with different elementId/index, provide adaptedAction
2. If the element text/context changed slightly but it's still the same control, provide adaptedAction
3. If a modal appeared, check if it needs to be dismissed first (cannot_complete with clear reason)
4. If URL changed unexpectedly, this usually means cannot_complete
5. Only return "cannot_complete" if the goal is truly impossible on this page
6. Be adaptive - minor changes should result in "can_proceed"`;

    const userPrompt = `PLANNED ACTION: ${plannedAction.type} on ${plannedAction.elementId} ("${plannedAction.reason}")

PAGE CHANGES DETECTED:
${changesSection}

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
  customPromptConfig?: CustomPromptConfig | string,
): BuildPromptResult {

  // 1. Analyze Plan State
  const planState = getPlanState(tracker);

  // 2. Extract goal information
  const goalName = preset?.name || goal?.name || 'Task';
  const goalDescription = preset?.description || goal?.description || '';
  const successCriteria = preset?.goal?.successCriteria || goal?.successCriteria || '';
  const goalContextStr = formatGoalContext(goal);

  // 3. Build format helpers
  const interventionStr = formatIntervention(intervention);
  const metricsStr = formatInterventionMetrics(interventionMetrics);
  const historyStr = formatHistory(history, 5, limits.tokenHistory);
  const strategyStr = formatStrategy(tracker.cycleStrategy);

  // 4. Build System Prompt (static instructions)
  // Uses section-based architecture with extend/override support
  // Backward compatibility: string is treated as identity section (extend mode)
  const resolvedConfig: CustomPromptConfig | undefined =
    typeof customPromptConfig === 'string'
      ? { identity: customPromptConfig }
      : customPromptConfig;
  const systemPrompt = buildSystemPromptFromSections(resolvedConfig);

  // 5. Build Situation Prompt (dynamic state)
  // Order: Goal → Progress → Session State → Previous Actions → Current Page → Elements

  // Limit elements
  const limitedElements = limitElements(pageState.elements, limits.tokenMaxElements, limits.tokenElements);
  const elementsStr = formatElementsForAI(limitedElements);

  // Truncate markdown
  const markdownStr = smartTruncate(pageState.markdown, { maxTokens: limits.tokenMarkdown });

  // Build sections
  const goalSection = formatGoalSection(goalName, goalDescription, successCriteria, goalContextStr);
  const progressSection = formatProgressSection(tracker, planState, strategyStr);
  const sessionStateSection = formatSessionStateSection(metricsStr, interventionStr);

  // Assemble situation prompt with clear section markers
  let situationPrompt = `${goalSection}

${progressSection}`;

  // Add session state only if there's content
  if (sessionStateSection) {
    situationPrompt += `\n\n${sessionStateSection}`;
  }

  // Add history with section marker
  if (historyStr) {
    situationPrompt += `\n\n[PREVIOUS ACTIONS]${historyStr.replace(/\n\nPREVIOUS ACTIONS:/, '')}`;
  }

  situationPrompt += `

[CURRENT PAGE]
Title: ${pageState.title}
URL: ${pageState.url}

[PAGE CONTENT]
${markdownStr}

[INTERACTIVE ELEMENTS]
${elementsStr}

What is the next step? Respond in JSON.`;

  // 6. Calculate Token Stats
  const tokenStats: TokenUsageStats = {
    systemTokens: countTokens(systemPrompt),
    situationTokens: countTokens(situationPrompt),
    totalTokens: countTokens(systemPrompt) + countTokens(situationPrompt),
    isCompressed: false,
    breakdown: {
      taskContext: countTokens(goalSection + progressSection),
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
