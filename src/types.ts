// =============================================================================
// MOTE TYPE DEFINITIONS (v2)
// =============================================================================
//
// This file defines the "shape" of data that flows through Mote.
// Think of types as contracts - they guarantee what data looks like.
//
// Key changes in v2:
// - ThinkResult: Discriminated union separating actions from terminal states
// - SessionPlan: Hierarchical structure (cycles → steps) with computed progress
// - Preset & Goal: Both optional, enabling interactive mode
// - Simplified config: maxSteps from env only, removed redundant fields
//
// =============================================================================

// -----------------------------------------------------------------------------
// WEB ACTIONS
// -----------------------------------------------------------------------------
// These are the primitive browser operations the agent can perform.
// Separated from terminal states (SUCCESS/FAIL) for cleaner logic.

/**
 * Browser actions the agent can execute.
 *
 * - click: Click on an element (button, link, etc.)
 * - type: Enter text into an input field
 * - scroll: Scroll the page up or down
 * - navigate: Go to a new URL
 * - wait: Pause for content to load
 */
export type WebAction = 'click' | 'type' | 'scroll' | 'navigate' | 'wait';

/**
 * A browser action with its parameters.
 *
 * @example
 * // Click a button
 * { type: 'click', selector: '3', reason: 'Click submit button' }
 *
 * @example
 * // Type into search box
 * { type: 'type', selector: '1', text: 'weather today', reason: 'Enter search query' }
 */
export interface Action {
  /** Which browser action to perform */
  type: WebAction;

  /** Element index for click/type actions (e.g., "1", "2", "3") */
  selector?: string;

  /** Text to type, URL to navigate to, or scroll direction */
  text?: string;

  /** Human-readable explanation of why this action is taken */
  reason: string;
}

// -----------------------------------------------------------------------------
// THINK RESULT (Discriminated Union)
// -----------------------------------------------------------------------------
// The LLM returns one of these variants. Using a discriminated union makes
// the control flow in mote.ts clean and type-safe.
//
// switch (result.type) {
//   case 'ACTION': // execute action
//   case 'REPLAN': // regenerate plan
//   case 'RETRY_PERCEPTION': // re-scrape page
//   case 'SUCCESS': // goal achieved
//   case 'FAIL': // unrecoverable error
// }

/**
 * Result from the reasoning module.
 * Discriminated union - check `type` to determine which variant.
 */
export type ThinkResult =
  | ThinkResultAction
  | ThinkResultReplan
  | ThinkResultRetryPerception
  | ThinkResultGoalSuccess
  | ThinkResultFail;

/** Execute a browser action */
export interface ThinkResultAction {
  type: 'ACTION';
  action: Action;
}

/** Current plan is invalid, LLM will adjust */
export interface ThinkResultReplan {
  type: 'REPLAN';
  reason: string;
}

/** Perception missed something, retry scraping */
export interface ThinkResultRetryPerception {
  type: 'RETRY_PERCEPTION';
}

/** Goal successfully achieved */
export interface ThinkResultGoalSuccess {
  type: 'SUCCESS';
  finalAnswer: string;
}

/** Unrecoverable error, cannot proceed */
export interface ThinkResultFail {
  type: 'FAIL';
  error: string;
}

// -----------------------------------------------------------------------------
// SESSION PLAN
// -----------------------------------------------------------------------------
// Hierarchical structure tracking progress through cycles and steps.
// Progress is computed from the structure, not stored separately.
//
// SessionPlan
//   └── cycles[]
//         └── Cycle
//               ├── isCompleted
//               └── cycleSteps[]
//                     └── CycleStep
//                           ├── isCompleted
//                           ├── action?
//                           └── stepDescription

/**
 * A single step within a cycle.
 * Steps are discovered dynamically during execution.
 *
 * @example
 * { isCompleted: true, action: {...}, stepDescription: 'Selected answer B' }
 */
export interface CycleStep {
  /** Has this step been executed? */
  isCompleted: boolean;

  /** The action that was executed (filled after execution) */
  action?: Action;

  /** Human-readable description of what this step does/did */
  stepDescription: string;
}

/**
 * One complete unit of the goal.
 *
 * Examples:
 * - "Complete 10 quiz sets" → 10 cycles (each quiz = 1 cycle)
 * - "Apply to 5 jobs" → 5 cycles (each application = 1 cycle)
 * - "Complete this quiz" → 1 cycle (the entire quiz)
 */
export interface Cycle {
  /** Has this entire cycle been completed? */
  isCompleted: boolean;

  /** Steps within this cycle (grows dynamically) */
  cycleSteps: CycleStep[];
}

/**
 * Session-level plan tracking overall progress.
 * Created once at session start, updated throughout execution.
 *
 * Progress is computed from the structure:
 * - currentCycle = cycles.findIndex(c => !c.isCompleted)
 * - currentStep = cycle.cycleSteps.findIndex(s => !s.isCompleted)
 * - completedCycles = cycles.filter(c => c.isCompleted).length
 */
export interface SessionPlan {
  /** High-level summary of the goal */
  goalSummary: string;

  /** Description of what one cycle accomplishes */
  cycleDescription: string;

  /** All cycles (fixed count from initial analysis, steps grow dynamically) */
  cycles: Cycle[];

  /** When the session started */
  startedAt: Date;

  /** Last time the plan was updated */
  lastUpdatedAt: Date;
}

// -----------------------------------------------------------------------------
// GOAL
// -----------------------------------------------------------------------------
// Lightweight metadata about what the user wants to accomplish.
// Optional - if not provided, interactive mode asks the user.

/**
 * User's goal definition.
 *
 * @example
 * {
 *   name: 'Web Search',
 *   description: 'Search for TypeScript tutorials',
 *   context: { query: 'typescript tutorial 2024' }
 * }
 */
export interface Goal {
  /** Short name for this goal */
  name: string;

  /** What the user wants to accomplish */
  description: string;

  /** Runtime context data (e.g., search query, username) */
  context?: Record<string, string>;

  /** How to determine if the goal is achieved */
  successCriteria?: string;
}

// -----------------------------------------------------------------------------
// PRESET
// -----------------------------------------------------------------------------
// Pre-configured task templates that include plan structure and prompts.
// Optional - provides a complete task definition for common use cases.

/**
 * A pre-configured task template.
 *
 * Presets bundle everything needed for a specific task type:
 * - Session plan structure (how many cycles, what pattern)
 * - System prompt (how to instruct the LLM)
 * - Custom config (task-specific settings)
 *
 * @example
 * // Quiz preset
 * {
 *   name: 'Quiz Completion',
 *   description: 'Automatically complete online quizzes',
 *   sessionPlan: { ... },
 *   systemPrompt: 'You are a quiz-taking assistant...',
 *   customConfig: { defaultUrl: 'https://example.com/quiz' }
 * }
 */
export interface Preset {
  /** Display name for this preset */
  name: string;

  /** Description shown in interactive menu */
  description: string;

  /** Pre-configured plan structure */
  sessionPlan: SessionPlan;

  /** System prompt injected to LLM */
  systemPrompt: string;

  /** Task-specific configuration */
  customConfig?: Record<string, any>;
}

// -----------------------------------------------------------------------------
// PAGE STATE
// -----------------------------------------------------------------------------
// What the agent "sees" - a simplified view of the web page.

/**
 * Snapshot of the current page state.
 * Produced by perceive.ts, consumed by reason.ts
 */
export interface PageState {
  /** Current page URL */
  url: string;

  /** Page title (from <title> tag) */
  title: string;

  /** Main content converted to Markdown (token-efficient for LLM) */
  markdown: string;

  /** Interactive elements the agent can interact with */
  elements: ElementInfo[];
}

/**
 * An interactive element on the page.
 *
 * Each element gets an index number for LLM reference:
 * "[1] Button: Sign In"
 * "[2] Input: Search..."
 */
export interface ElementInfo {
  /** Reference number (1, 2, 3, ...) */
  index: number;

  /** HTML tag (button, a, input, etc.) */
  tag: string;

  /** Visible text or placeholder */
  text: string;

  /** CSS selector to find this element */
  selector: string;

  /** Input type for form elements (text, password, email, etc.) */
  inputType?: string;

  /** Key HTML attributes (href, name, aria-label, etc.) */
  attributes: Record<string, string>;
}

// -----------------------------------------------------------------------------
// MOTE CONFIGURATION
// -----------------------------------------------------------------------------
// Top-level configuration for running the agent.
// Both preset and goal are optional - interactive mode handles missing inputs.

/**
 * Configuration for a Mote agent run.
 *
 * All fields are optional:
 * - If preset provided: use preset's plan and prompts
 * - If goal provided: generate plan via LLM
 * - If neither: interactive mode asks the user
 *
 * Note: maxSteps is controlled by environment variable only (MAX_STEPS, -1 for unlimited)
 */
export interface MoteConfig {
  /** Pre-configured task template */
  preset?: Preset;

  /** User's goal definition */
  goal?: Goal;

  /** Starting URL (preset may have a default) */
  startUrl?: string;

  /** Run browser without visible window? */
  headless?: boolean;

  /** Slow down actions by this many ms */
  slowMo?: number;

  /** Human-in-the-loop settings */
  humanControl?: HumanControlConfig;
}

// -----------------------------------------------------------------------------
// HUMAN-IN-THE-LOOP CONFIGURATION
// -----------------------------------------------------------------------------

/**
 * Confirmation modes for human oversight.
 *
 * - 'all': Confirm every action (maximum control)
 * - 'destructive': Only confirm clicks and form submissions (balanced)
 * - 'none': Fully autonomous (use with caution)
 */
export type ConfirmMode = 'all' | 'destructive' | 'none';

/**
 * Human oversight configuration.
 */
export interface HumanControlConfig {
  /** Which actions require confirmation */
  confirmMode: ConfirmMode;

  /** Pause between steps (ms) for observation */
  stepPause: number;

  /** Show detailed logs */
  verbose: boolean;
}

// -----------------------------------------------------------------------------
// STEP RESULT
// -----------------------------------------------------------------------------
// Records what happened after executing an action.

/**
 * Result of executing a single step.
 */
export interface StepResult {
  /** Step number (1, 2, 3, ...) */
  step: number;

  /** The action that was executed */
  action: Action;

  /** Did execution succeed? */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Page state after the action */
  pageStateAfter?: PageState;

  /** When this step was executed */
  timestamp: Date;
}

// -----------------------------------------------------------------------------
// AGENT RESULT
// -----------------------------------------------------------------------------
// Final result after the agent finishes.

/**
 * Final result of an agent run.
 *
 * Note: plan and cyclesCompleted are always present (not optional)
 */
export interface AgentResult {
  /** Did the agent accomplish its goal? */
  success: boolean;

  /** Final message (success description or error) */
  message: string;

  /** Complete history of all steps */
  history: StepResult[];

  /** Final state of the session plan */
  plan: SessionPlan;

  /** Number of cycles completed (0 if none) */
  cyclesCompleted: number;

  /** Total time taken (ms) */
  duration: number;

  /** Final page URL */
  finalUrl: string;
}

// -----------------------------------------------------------------------------
// LLM CONFIGURATION
// -----------------------------------------------------------------------------

/**
 * LLM (Large Language Model) configuration.
 * Uses OpenAI-compatible API interface.
 */
export interface LLMConfig {
  /** Base URL of the API (e.g., http://localhost:11434/v1 for Ollama) */
  baseUrl: string;

  /** API key (use "ollama" for local Ollama) */
  apiKey: string;

  /** Model name (e.g., "llama3.2", "gpt-4o-mini") */
  model: string;
}

// -----------------------------------------------------------------------------
// BROWSER CONFIGURATION
// -----------------------------------------------------------------------------

/**
 * Browser launch configuration.
 */
export interface BrowserConfig {
  /** Run without visible window? */
  headless: boolean;

  /** Slow down actions by this many ms */
  slowMo: number;

  /** Default timeout for operations (ms) */
  timeout: number;
}

// -----------------------------------------------------------------------------
// UTILITY TYPES
// -----------------------------------------------------------------------------

/**
 * Result of executing an action.
 */
export interface ExecuteResult {
  /** Did the action succeed? */
  success: boolean;

  /** Error message if failed */
  error?: string;
}

/**
 * Control signal for the agent loop.
 */
export type LoopControl = 'continue' | 'break';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS (for SessionPlan)
// -----------------------------------------------------------------------------
// These compute values from the plan structure rather than storing them.

/**
 * Get the index of the current (incomplete) cycle.
 * Returns -1 if all cycles are complete.
 */
export function getCurrentCycleIndex(plan: SessionPlan): number {
  return plan.cycles.findIndex((c) => !c.isCompleted);
}

/**
 * Get the current (incomplete) cycle, or null if all complete.
 */
export function getCurrentCycle(plan: SessionPlan): Cycle | null {
  return plan.cycles.find((c) => !c.isCompleted) || null;
}

/**
 * Get the index of the current (incomplete) step within a cycle.
 * Returns -1 if all steps are complete.
 */
export function getCurrentStepIndex(cycle: Cycle): number {
  return cycle.cycleSteps.findIndex((s) => !s.isCompleted);
}

/**
 * Get total number of cycles.
 */
export function getTotalCycles(plan: SessionPlan): number {
  return plan.cycles.length;
}

/**
 * Get number of completed cycles.
 */
export function getCompletedCycles(plan: SessionPlan): number {
  return plan.cycles.filter((c) => c.isCompleted).length;
}

/**
 * Get human-readable progress string.
 *
 * @example
 * "Cycle 3/10, Step 2/5"
 */
export function getProgress(plan: SessionPlan): string {
  const currentCycleIdx = getCurrentCycleIndex(plan);
  const totalCycles = getTotalCycles(plan);

  if (currentCycleIdx === -1) {
    return `All ${totalCycles} cycles complete`;
  }

  const cycle = plan.cycles[currentCycleIdx];
  const currentStepIdx = getCurrentStepIndex(cycle);
  const totalSteps = cycle.cycleSteps.length;

  const cycleNum = currentCycleIdx + 1;
  const stepNum = currentStepIdx === -1 ? totalSteps : currentStepIdx + 1;

  return `Cycle ${cycleNum}/${totalCycles}, Step ${stepNum}/${
    totalSteps || '?'
  }`;
}
