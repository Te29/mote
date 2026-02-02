// =============================================================================
// ACTION TYPES
// =============================================================================
// Defines browser actions and LLM reasoning results

import type { PageState } from './page.js';

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
 * - hover: Move mouse over an element (for dropdowns, tooltips)
 * - select: Choose an option from a dropdown menu
 * - checkbox: Toggle a checkbox or switch
 * - drag: Drag an element to another location
 * - scroll_to_element: Scroll a specific element into view (uses scrollIntoViewIfNeeded)
 */
export type WebAction = 'click' | 'type' | 'scroll' | 'scroll_to_element' | 'navigate' | 'wait' | 'hover' | 'select' | 'checkbox' | 'drag' | 'multi_click';

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
  elementId?: string;

  /** Multiple element indices for multi_click action (e.g., ["5", "6", "8"]) */
  elementIds?: string[];

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
//   case 'GOAL_SUCCESS': // goal achieved
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
  type: 'GOAL_SUCCESS';
  finalAnswer: string;
}

/** Unrecoverable error, cannot proceed */
export interface ThinkResultFail {
  type: 'FAIL';
  error: string;
  isParseError?: boolean; // true when failure is due to LLM response parsing, not intentional
}

// -----------------------------------------------------------------------------
// EXECUTION PATH BLUEPRINT (Static Plan)
// -----------------------------------------------------------------------------
// A linear or nested sequence of steps defined in a preset.
// This is the "Code" or "Recipe" the agent follows.

/**
 * Loop continuation configuration.
 * Uses script-based verification with optional iteration safety limit.
 */
export interface LoopCondition {
  /** Verification script configuration */
  verification: VerificationConfig;

  /** Maximum iterations as safety limit (default: 100) */
  maxIterations?: number;
}

/**
 * Script-based verification configuration.
 * Scripts execute in browser context and must return boolean.
 */
export interface VerificationConfig {
  /**
   * JavaScript code to execute in browser context.
   * Must return boolean: true = pass, false = fail.
   * Throw Error for critical failures.
   *
   * @example
   * "() => document.querySelector('.success') !== null"
   *
   * @example
   * "() => document.querySelectorAll('.cart-item').length > 0"
   */
  script: string;

  /** Human-readable description of what's being verified */
  description?: string;

  /**
   * Strategy when script fails or throws error.
   * - 'llm': Fall back to LLM reasoning (default)
   * - 'continue': Treat as success, continue execution
   * - 'fail': Treat as failure, terminate or exit loop
   */
  onFailure?: 'llm' | 'continue' | 'fail';
}

/**
 * Pre-observe wait configuration.
 * Async script that resolves when page is ready for observation.
 * Used to handle SPAs, lazy loading, and dynamic content.
 */
export interface WaitForReadyConfig {
  /**
   * Async JavaScript code to execute in browser context.
   * Script should resolve/complete when page is ready.
   * No return value needed - completion signals readiness.
   *
   * @example
   * "new Promise(resolve => {
   *   if (document.querySelector('.content-loaded')) return resolve();
   *   const observer = new MutationObserver(() => {
   *     if (document.querySelector('.content-loaded')) {
   *       observer.disconnect();
   *       resolve();
   *     }
   *   });
   *   observer.observe(document.body, { childList: true, subtree: true });
   * })"
   */
  waitScript: string;

  /** Human-readable description of what we're waiting for */
  description?: string;

  /** Max time to wait in milliseconds (default: 10000) */
  timeout?: number;

  /**
   * Strategy when script times out.
   * - 'continue': Proceed with observation anyway (default)
   * - 'fail': Terminate the step/cycle
   */
  onTimeout?: 'continue' | 'fail';
}

/**
 * Reference to a prompt file for step-level customization.
 * Simple relative path from the preset directory.
 *
 * @example
 * "./prompts/fill-form.md"
 * "./prompts/select-product.md"
 */
export type StepPromptRef = string;

/**
 * Blueprint for a single step, independent of execution results.
 * Defines WHAT to do, not what happened.
 *
 * Execution modes:
 * - llmRequired: false + complete action → Fast path (execute directly)
 * - llmRequired: true (default) → LLM path (reasoning module determines action)
 */
export interface StepPlan {
  /** Global unique ID */
  stepId: string;

  /** Human-readable description (for logging/display) */
  description: string;

  /**
   * Detailed instruction for LLM reasoning.
   * Describes WHAT to accomplish, not HOW.
   * Used when llmRequired is true.
   *
   * @example
   * "Find the username or email input field and enter the login credentials.
   *  Look for fields labeled 'Username', 'Email', or 'Login ID'."
   */
  instruction?: string;

  /** Optional URL constraint (wait for this URL before acting) */
  url?: string;

  /** If true, URL match must be exact; otherwise partial/pattern */
  isUrlFixed?: boolean;

  /**
   * CSS selector hint for the target element.
   * For llmRequired:false → Used directly for element selection.
   * For llmRequired:true → Optional hint to guide LLM's element search.
   */
  targetElementSelector?: string;

  /**
   * Action to execute.
   * For llmRequired:false → Complete action executed directly.
   * For llmRequired:true → Optional partial hints (LLM fills in elementId, etc.)
   */
  action?: Action;

  /**
   * Page state expected before execution.
   * Used for verification and self-healing.
   */
  expectedPageState?: PageState;

  /**
   * Whether LLM reasoning is required for this step.
   * - true (default): Call reasoning module with instruction + custom prompt
   * - false: Fast path, execute action directly without LLM
   */
  llmRequired?: boolean;

  /**
   * Relative path to step-specific prompt file.
   * Path is relative to the preset directory.
   *
   * @example "./prompts/fill-form.md"
   */
  promptRef?: StepPromptRef;

  /**
   * Pre-observe wait configuration.
   * Ensures page is ready before observation for this step.
   * Useful for SPAs, lazy loading, or pages with dynamic content.
   */
  waitForReady?: WaitForReadyConfig;
}

/** 
 * Loop Block: A sequence of steps that repeats.
 */
export interface LoopPlan {
  /** Global unique ID */
  loopId: string;
  
  /** Hardcoded number of iterations (for-loop style) */
  iterations?: number;
  
  /** Dynamic loop condition (while-loop style) */
  loopCondition?: LoopCondition;
  
  /** Sequence of steps inside the loop */
  steps: StepPlan[];
}

/** 
 * PlanUnit: Unified sequential unit.
 * Can be a single atomic step or a complex block (loop).
 */
export type PlanUnit =
  | { type: 'step'; step: StepPlan }
  | { type: 'loop'; loop: LoopPlan };

/**
 * CyclePlan: Blueprint for ONE cycle.
 * Contains the sequence of steps/loops that make up a single cycle.
 *
 * stepId convention: Use descriptive strings (e.g., "fill-username", "click-submit")
 * to support dynamic blueprints where step count is uncertain.
 */
export interface CyclePlan {
  /** Cycle execution units (steps and loops) */
  units: PlanUnit[];

  /** Optional starting URL for this cycle */
  startUrl?: string;

  /**
   * Optional verification to run before marking cycle complete.
   * Executes after LLM thinks GOAL_SUCCESS but before CYCLE_END transition.
   * If verification fails, returns to OBSERVE to continue working.
   */
  verification?: VerificationConfig;
}

/**
 * SessionPlan: Complete blueprint for session execution.
 * Human-authored, stored in preset files.
 * Self-contained with all metadata needed for execution.
 *
 * Structure:
 *   setupSteps[]  → One-time setup before cycles (flat, no loops)
 *   cyclePlan     → Blueprint for each cycle (can contain loops)
 *   wrapupSteps[] → One-time finalization after cycles (flat, no loops)
 *
 * Execution flow: setup → setupVerification → cycles → wrapup → wrapupVerification → verification
 */
export interface SessionPlan {
  /**
   * High-level description of what this session accomplishes.
   * Used for runtime tracking and LLM prompts.
   */
  goalSummary: string;

  /**
   * Description of what one cycle accomplishes.
   * Used for cycle tracking and prompt context.
   */
  cycleDescription: string;

  /**
   * Session-level setup steps (executed once before cycles).
   * Flat array - no loops allowed in setup phase.
   */
  setupSteps?: StepPlan[];

  /**
   * Optional verification to run after setup steps complete.
   * Validates initial state is correct before starting cycles.
   * If fails, can retry setup or abort session.
   */
  setupVerification?: VerificationConfig;

  /**
   * Blueprint for each cycle (the repeatable part).
   * Can contain steps and loops.
   */
  cyclePlan: CyclePlan;

  /**
   * How many times to execute the cyclePlan.
   * Default: 1 (single cycle execution)
   * Use -1 for unlimited cycles (keep going until verification passes)
   */
  numberOfCycles?: number;

  /**
   * Session-level wrapup steps (executed once after all cycles complete).
   * Flat array - no loops allowed in wrapup phase.
   */
  wrapupSteps?: StepPlan[];

  /**
   * Optional verification to run after wrapup steps complete.
   * Validates cleanup/finalization was successful.
   */
  wrapupVerification?: VerificationConfig;

  /**
   * Optional final verification to run when session completes.
   * Executes after wrapupVerification, before final TERMINATED transition.
   * Most comprehensive - can validate entire session outcome end-to-end.
   */
  verification?: VerificationConfig;
}

// -----------------------------------------------------------------------------
// TYPE GUARDS
// -----------------------------------------------------------------------------

/**
 * Type guard for ACTION result.
 *
 * @example
 * if (isActionResult(result)) {
 *   // result.action is accessible
 *   console.log(result.action.type);
 * }
 */
export function isActionResult(
  result: ThinkResult,
): result is ThinkResultAction {
  return result.type === 'ACTION';
}

/**
 * Type guard for GOAL_SUCCESS result.
 */
export function isGoalSuccess(
  result: ThinkResult,
): result is ThinkResultGoalSuccess {
  return result.type === 'GOAL_SUCCESS';
}

/**
 * Type guard for FAIL result.
 */
export function isFailure(result: ThinkResult): result is ThinkResultFail {
  return result.type === 'FAIL';
}

/**
 * Type guard for REPLAN result.
 */
export function isReplan(result: ThinkResult): result is ThinkResultReplan {
  return result.type === 'REPLAN';
}

/**
 * Type guard for RETRY_PERCEPTION result.
 */
export function isRetryPerception(
  result: ThinkResult,
): result is ThinkResultRetryPerception {
  return result.type === 'RETRY_PERCEPTION';
}
