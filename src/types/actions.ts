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
 * Dynamic condition for loop continuation.
 */
export type LoopCondition =
  | { type: 'element_exists' | 'element_missing'; selector: string; maxIterationsSafety?: number }
  | { type: 'custom_script'; script: string; maxIterationsSafety?: number };

export interface PromptRef {
  /** Which preset's prompt file */
  presetId: string;

  /** Which prompt file inside the preset (usually one) */
  file: 'main' | 'recovery' | 'analysis';

  /** JSON path / key path inside the prompt file */
  key: string;

  /** Optional progressive layer (e.g. base + step override) */
  variant?: string;
}

/** 
 * Blueprint for a single step, independent of execution results.
 * Defines WHAT to do, not what happened.
 */
export interface ExecutionStep {
  /** Global unique ID */
  stepId: string;
  
  /** Human-readable description */
  description: string;
  
  /** Optional URL constraint (wait for this URL before acting) */
  url?: string;
  
  /** If true, URL match must be exact; otherwise partial/pattern */
  isUrlFixed?: boolean;
  
  /** 
   * CSS selector for the target element. 
   * Optional because some steps might be purely reasoning/navigation without specific element interaction.
   * or for dynamic element selection without fixed element info indicated. 
   */
  targetElementSelector?: string;
  
  /** 
   * Action to execute.
   * Optional because the step might be "Wait" or "Verify" without a browser action.
   */
  action?: Action;
  
  /**
   * Page state expected before execution.
   * Used for verification and self-healing.
   */
  expectedPageState?: PageState;
  
  /** Whether LLM reasoning is required for this step (vs fast-path deterministic) */
  llmRequired?: boolean;
  
  /** Reference to a specific prompt template for this step */
  customPromptRef?: PromptRef;
}

/** 
 * Loop Block: A sequence of steps that repeats.
 */
export interface LoopBlock {
  /** Global unique ID */
  loopId: string;
  
  /** Hardcoded number of iterations (for-loop style) */
  iterations?: number;
  
  /** Dynamic loop condition (while-loop style) */
  loopCondition?: LoopCondition;
  
  /** Sequence of steps inside the loop */
  steps: ExecutionStep[];
}

/** 
 * ExecutionUnit: Unified sequential unit.
 * Can be a single atomic step or a complex block (loop).
 */
export type ExecutionUnit =
  | { type: 'step'; step: ExecutionStep }
  | { type: 'loop'; loop: LoopBlock };

/** 
 * ExecutionPath: Blueprint layer.
 * Arrangement of execution units in order.
 */
export interface ExecutionPath {
  /** Global sequence guarantee */
  units: ExecutionUnit[];
  
  /** Optional starting URL for this entire path */
  startUrl?: string;
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
