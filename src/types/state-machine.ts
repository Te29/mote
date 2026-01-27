// =============================================================================
// STATE MACHINE TYPES
// =============================================================================
// State machine for controlling agent execution flow
//
// 6-State Design: CYCLE_START → OBSERVE → REASON → ACT → CYCLE_END → TERMINATED
//
// States map directly to modules:
//   - OBSERVE  → observe.ts
//   - REASON   → reason.ts
//   - ACT      → act.ts

import type { Action } from './actions.js';
import type { PageState } from './page.js';

// -----------------------------------------------------------------------------
// AGENT STATE MACHINE
// -----------------------------------------------------------------------------
// The agent operates in distinct phases:
// - CYCLE_START: Beginning of a new cycle (intervention point)
// - OBSERVE: Observe page state (calls observe module)
// - REASON: Reason about next action (calls reason module, handles replan internally)
// - ACT: Execute a browser action (calls act module)
// - CYCLE_END: End of cycle with result (intervention point)
// - TERMINATED: Execution complete (terminal state)

/**
 * State machine for agent execution.
 * Each state represents a distinct phase of execution.
 */
export type AgentState =
  | AgentStateCycleStart
  | AgentStateObserve
  | AgentStateReason
  | AgentStateAct
  | AgentStateCycleEnd
  | AgentStateTerminated;

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
}

/** End of cycle with result */
export interface AgentStateCycleEnd {
  phase: 'CYCLE_END';
  cycleIndex: number;
  result: 'SUCCESS' | 'FAILURE';
  detail?: string; // finalAnswer when SUCCESS, error message when FAILURE
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
 *   CYCLE_START → OBSERVE → REASON → ACT → OBSERVE → ...
 *                              ↓
 *                         CYCLE_END → CYCLE_START (next cycle)
 *                              ↓
 *                         TERMINATED
 *
 * REASON can transition to:
 *   - ACT: Execute an action
 *   - OBSERVE: Replan or reperceive (go back to observe)
 *   - CYCLE_END: Goal success or failure
 *   - TERMINATED: User quit or max steps
 */
export const VALID_TRANSITIONS: Record<AgentState['phase'], AgentState['phase'][]> = {
  'CYCLE_START': ['OBSERVE', 'TERMINATED'],
  'OBSERVE': ['REASON', 'TERMINATED'],
  'REASON': ['ACT', 'OBSERVE', 'CYCLE_END', 'TERMINATED'],
  'ACT': ['OBSERVE', 'ACT', 'TERMINATED'],  // ACT→ACT for intervention rejection
  'CYCLE_END': ['CYCLE_START', 'OBSERVE', 'ACT', 'TERMINATED'],  // OBSERVE/ACT for intervention rejection
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
