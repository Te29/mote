// =============================================================================
// RESULT TYPES
// =============================================================================
// Results from steps and complete agent runs

import type { Action } from './actions.js';
import type { SessionTracker } from './session.js';
import type { PageState } from './page.js';

// -----------------------------------------------------------------------------
// STEP RESULT
// -----------------------------------------------------------------------------

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

  /** Page state before the action (used for Execute mode verification) */
  pageStateBefore: PageState;

  /** Page state after the action */
  pageStateAfter?: PageState;

  /** When this step was executed (ISO 8601 string) */
  timestamp: string;
}

// -----------------------------------------------------------------------------
// AGENT RESULT
// -----------------------------------------------------------------------------

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

  /** Final state of the session tracker */
  plan: SessionTracker;

  /** Number of cycles completed (0 if none) */
  cyclesCompleted: number;

  /** Total time taken (ms) */
  duration: number;

  /** Final page URL */
  finalUrl: string;
}

// -----------------------------------------------------------------------------
// DRIFT EVALUATION (Execute Mode Adaptive Execution)
// -----------------------------------------------------------------------------

/**
 * Result of evaluating drift between expected and current page state.
 * Used in Execute Mode to determine if cached step can proceed.
 */
export type DriftEvaluationDecision = 'exact_match' | 'can_proceed' | 'cannot_complete';

export interface DriftEvaluationResult {
  /** The drift decision */
  decision: DriftEvaluationDecision;

  /** Explanation of the decision */
  reason: string;

  /** Adapted execution step (only if decision = 'can_proceed') */
  adaptedStep?: import('./actions.js').ExecutionStep;

  /** Whether the ExecutionStep was modified during adaptation */
  wasAdapted: boolean;
}

// -----------------------------------------------------------------------------
// UTILITY TYPES
// -----------------------------------------------------------------------------

/**
 * Information about a downloaded file.
 */
export interface DownloadInfo {
  /** Suggested filename from the server */
  suggestedFilename: string;

  /** Path where the file was saved */
  path: string;

  /** URL the download was initiated from */
  url: string;
}

/**
 * Result of executing a browser action.
 */
export interface ExecuteResult {
  /** Did the action succeed? */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** New page if action opened a new tab */
  newPage?: any;  // Page type from playwright

  /** Download info if action triggered a download */
  download?: DownloadInfo;
}

/**
 * Loop control type for breaking/continuing loops.
 */
export type LoopControl = 'continue' | 'break' | null;
