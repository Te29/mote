// =============================================================================
// STATE MACHINE TYPES
// =============================================================================
// State machine for controlling agent execution flow
//
// 8-State Design: SETUP → CYCLE_START → OBSERVE → REASON → ACT → CYCLE_END → WRAPUP → TERMINATED
//
// States map directly to modules:
//   - SETUP    → setup handler
//   - OBSERVE  → observe.ts
//   - REASON   → reason.ts
//   - ACT      → act.ts
//   - WRAPUP   → wrapup handler

import type { Action } from './actions.js';
import type { PageState } from './page.js';

// -----------------------------------------------------------------------------
// AGENT STATE MACHINE
// -----------------------------------------------------------------------------
// The agent operates in distinct phases:
// - SETUP: Execute session-level setup steps (one-time, before cycles)
// - CYCLE_START: Beginning of a new cycle (intervention point)
// - OBSERVE: Observe page state (calls observe module)
// - REASON: Reason about next action (calls reason module, handles replan internally)
// - ACT: Execute a browser action (calls act module)
// - CYCLE_END: End of cycle with result (intervention point)
// - WRAPUP: Execute session-level wrapup steps (one-time, after all cycles)
// - TERMINATED: Execution complete (terminal state)

/**
 * State machine for agent execution.
 * Each state represents a distinct phase of execution.
 */
export type AgentState =
  | AgentStateSetup
  | AgentStateCycleStart
  | AgentStateObserve
  | AgentStateReason
  | AgentStateAct
  | AgentStateCycleEnd
  | AgentStateWrapup
  | AgentStateTerminated;

/** Execute session-level setup steps (one-time, before cycles) */
export interface AgentStateSetup {
  phase: 'SETUP';
}

/** Beginning of a cycle (intervention point) */
export interface AgentStateCycleStart {
  phase: 'CYCLE_START';
  cycleIndex: number;
}

/** Observe page state */
export interface AgentStateObserve {
  phase: 'OBSERVE';
  cycleIndex: number;
}

/** Reason about next action */
export interface AgentStateReason {
  phase: 'REASON';
  cycleIndex: number;
  pageState: PageState;
}

/** Execute a browser action */
export interface AgentStateAct {
  phase: 'ACT';
  cycleIndex: number;
  action: Action;
  pageState: PageState;

  /** Blueprint tracking (optional, only if following a defined path or synthetic step) */
  stepId?: string;
  loopId?: string;
  loopIteration?: number;
  globalIndex?: number;
}

/** End of cycle with result */
export interface AgentStateCycleEnd {
  phase: 'CYCLE_END';
  cycleIndex: number;
  result: 'SUCCESS' | 'FAILURE';
  detail?: string; // finalAnswer when SUCCESS, error message when FAILURE
}

/** Execute session-level wrapup steps (one-time, after all cycles) */
export interface AgentStateWrapup {
  phase: 'WRAPUP';
}

/** Execution complete (terminal state) */
export interface AgentStateTerminated {
  phase: 'TERMINATED';
  success: boolean;
  message: string;
}

// -----------------------------------------------------------------------------
// STATE TRANSITION VALIDATION
// -----------------------------------------------------------------------------

/**
 * Valid state transitions map.
 * Defines which states can transition to which other states.
 *
 * Flow:
 *   SETUP → CYCLE_START → OBSERVE → REASON → ACT → OBSERVE → ...
 *                              ↓
 *                         CYCLE_END → CYCLE_START (next cycle)
 *                              ↓
 *                         WRAPUP → TERMINATED
 *
 * REASON can transition to:
 *   - ACT: Execute an action
 *   - OBSERVE: Replan or reperceive (go back to observe)
 *   - CYCLE_END: Goal success or failure
 *   - TERMINATED: User quit or max steps
 */
export const VALID_TRANSITIONS: Record<AgentState['phase'], AgentState['phase'][]> = {
  'SETUP': ['OBSERVE', 'CYCLE_START', 'TERMINATED'],  // SETUP can observe, start cycles, or terminate
  'CYCLE_START': ['OBSERVE', 'TERMINATED'],
  'OBSERVE': ['REASON', 'TERMINATED'],
  'REASON': ['ACT', 'OBSERVE', 'CYCLE_END', 'TERMINATED'],
  'ACT': ['OBSERVE', 'ACT', 'TERMINATED'],  // ACT→ACT for intervention rejection
  'CYCLE_END': ['CYCLE_START', 'WRAPUP', 'OBSERVE', 'ACT', 'TERMINATED'],  // Can go to wrapup, next cycle, or intervention rejection
  'WRAPUP': ['OBSERVE', 'TERMINATED'],  // WRAPUP can observe for steps, or terminate
  'TERMINATED': [],
};

/**
 * Validate a state transition.
 * Throws an error if the transition is invalid.
 *
 * @param from - Source state phase
 * @param to - Target state phase
 * @throws Error if transition is invalid
 */
export function validateTransition(from: AgentState['phase'], to: AgentState['phase']): void {
  const validTargets = VALID_TRANSITIONS[from];
  if (!validTargets.includes(to)) {
    const validList = validTargets.length > 0 ? validTargets.join(', ') : 'none';
    throw new Error(
      `Invalid state transition: ${from} → ${to}. Valid transitions from ${from}: ${validList}`
    );
  }
}
