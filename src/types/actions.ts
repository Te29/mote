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
 */
export type WebAction = 'click' | 'type' | 'scroll' | 'navigate' | 'wait' | 'hover' | 'select' | 'checkbox' | 'drag' | 'multi_click';

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
// EXECUTION PATH (Cached Strategy)
// -----------------------------------------------------------------------------
// A linear sequence of steps learned from a successful Explore run.
// Used for fast-path execution.

/**
 * A single cached step in an execution path.
 * Contains both the expected condition and the action to take.
 */
export interface ExecutionStep {
  /** Unique ID for this step in the sequence */
  stepId: string;

  /** Human-readable description */
  description: string;

  /** 
   * Expected URL (or pattern) for verification.
   * Optional: Many tasks have dynamic URLs (session IDs, quiz IDs) that make strict matching unreliable.
   */
  url?: string;

  /**
   * The state we expect to see before acting.
   * Storing full PageState allows robust "Diff" later if needed.
   */
  expectedPageState: PageState;

  /**
   * The specific element we need for the next action.
   * This is a selector string.
   */
  targetCssSelector: string;

  /** The action to perform (Result of previous Reason step) */
  action: Action;
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
