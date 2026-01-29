// =============================================================================
// SESSION TYPES
// =============================================================================
// Session tracking, cycles, steps, and progress helpers

import type { Action } from './actions.js';
import type { PageContext } from './page.js';

// -----------------------------------------------------------------------------
// TIMESTAMP HELPERS
// -----------------------------------------------------------------------------
// Date objects don't serialize well to JSON. We use ISO 8601 strings instead.

/**
 * Create a timestamp in ISO 8601 format.
 * Use this instead of `new Date()` for SessionTracker and StepResult timestamps.
 *
 * @returns ISO 8601 timestamp string (e.g., "2024-01-18T12:34:56.789Z")
 */
export function createTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Parse an ISO 8601 timestamp string into a Date object.
 *
 * @param timestamp - ISO 8601 string
 * @returns Date object
 */
export function parseTimestamp(timestamp: string): Date {
  return new Date(timestamp);
}

// -----------------------------------------------------------------------------
// SESSION TRACKER
// -----------------------------------------------------------------------------
// Hierarchical structure tracking progress through cycles and steps.
// Progress is computed from the structure, not stored separately.
//
// SessionTracker
//   └── cycles[]
//         └── Cycle
//               ├── isCompleted
//               └── cycleSteps[]
//                     └── CycleStep
//                           ├── isCompleted
//                           ├── action?
//                           └── stepDescription

// -----------------------------------------------------------------------------
// SESSION TRACKER (Runtime State)
// -----------------------------------------------------------------------------

/** 
 * DOM snapshot structure for metadata.
 * captured at the moment of interaction.
 */
export interface ElementSnapshot {
  tagName: string;
  textContent?: string;
  role?: string;
  attributes?: Record<string, string>;
  domPath?: string;
}

/** 
 * Optional execution metadata (DOM/timing etc.) 
 */
export interface StepExecutionMeta {
  /** Actually used selector (might differ from blueprint if self-healed) */
  resolvedSelector?: string;
  
  /** DOM snapshot of the target */
  elementSnapshot?: ElementSnapshot;
  
  /** Execution timing metrics (ms) */
  timing?: {
    waitForElement?: number;
    actionDuration?: number;
    totalStepTime?: number;
  };
}

/** 
 * Runtime single-step execution record.
 * Mirrors ExecutionStep but contains results.
 */
export interface CycleStep {
  /** Global sequence index (0, 1, 2...) */
  globalIndex: number;
  
  /** Reference to the ExecutionStep ID from blueprint */
  stepId: string;
  
  /** Reference to LoopBlock ID if inside a loop */
  loopId?: string;
  
  /** Whether the step successfully completed */
  isCompleted: boolean;
  
  /** The action that was actually executed */
  action?: Action;
  
  /** Description of execution result */
  stepDescription: string;
  
  /** Page snapshot at the time of execution */
  pageContext?: PageContext;
  
  /** Detailed execution metadata */
  executionMeta?: StepExecutionMeta;
}

/** 
 * Single loop statistics.
 * Tracks loop execution progress.
 */
export interface LoopStats {
  /** ID of the LoopBlock */
  loopId: string;
  
  /** Actual number of iterations completed */
  iterations: number;
  
  /** List of conditions that were met to continue each iteration */
  conditionsMet: string[];
}

/** 
 * Cycle: One complete execution unit of the goal.
 */
export interface Cycle {
  /** Has this entire cycle been completed? */
  isCompleted: boolean;
  
  /** Runtime step records */
  cycleSteps: CycleStep[];
  
  /** Loop statistics for loops within this cycle */
  loopStats?: LoopStats[];
}

/**
 * Learned execution strategy, used for prompt compression / element learning
 */
export interface CycleStrategy {
  /** Natural language description of loop pattern */
  pattern: string;
  
  /** Common step sequence */
  stepSequence: string[];
  
  /** Common element patterns */
  keyElements: string[];
}

/**
 * SessionTracker: Entire session runtime state.
 * created once at session start, updated throughout execution.
 */
export interface SessionTracker {
  /** High-level goal description */
  goalSummary: string;
  
  /** Description of what one cycle accomplishes */
  cycleDescription: string;
  
  /** Execution records of all cycles */
  cycles: Cycle[];
  
  /** Session start time (ISO string) */
  startedAt: string;
  
  /** Last updated time (ISO string) */
  lastUpdatedAt: string;
  
  /** Starting URL for each cycle (optional) */
  cycleStartUrl?: string;
  
  /** Learned execution strategy */
  cycleStrategy?: CycleStrategy;
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS (for SessionTracker)
// -----------------------------------------------------------------------------
// These compute values from the tracker structure rather than storing them.

/**
 * Get the index of the current (incomplete) cycle.
 * Returns -1 if all cycles are complete.
 */
export function getCurrentCycleIndex(tracker: SessionTracker): number {
  return tracker.cycles.findIndex((c) => !c.isCompleted);
}

/**
 * Get the current (incomplete) cycle, or null if all complete.
 */
export function getCurrentCycle(tracker: SessionTracker): Cycle | null {
  return tracker.cycles.find((c) => !c.isCompleted) || null;
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
export function getTotalCycles(tracker: SessionTracker): number {
  return tracker.cycles.length;
}

/**
 * Get number of completed cycles.
 */
export function getCompletedCycles(tracker: SessionTracker): number {
  return tracker.cycles.filter((c) => c.isCompleted).length;
}

/**
 * Get human-readable progress string.
 *
 * @example
 * "Cycle 3/10, Step 2/5"
 */
export function getProgress(tracker: SessionTracker): string {
  const currentCycleIdx = getCurrentCycleIndex(tracker);
  const totalCycles = getTotalCycles(tracker);

  if (currentCycleIdx === -1) {
    return `All ${totalCycles} cycles complete`;
  }

  const cycle = tracker.cycles[currentCycleIdx];
  const currentStepIdx = getCurrentStepIndex(cycle);
  const totalSteps = cycle.cycleSteps.length;

  const cycleNum = currentCycleIdx + 1;
  const stepNum = currentStepIdx === -1 ? totalSteps : currentStepIdx + 1;

  return `Cycle ${cycleNum}/${totalCycles}, Step ${stepNum}`;
}
