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

/**
 * A single step within a cycle.
 * Steps are discovered dynamically during execution.
 *
 * @example
 * { isCompleted: true, action: {...}, stepDescription: 'Selected answer B', pageContext: { title: 'Quiz', progress: 'Q3/5' } }
 */
export interface CycleStep {
  /** Has this step been executed? */
  isCompleted: boolean;

  /** The action that was executed (filled after execution) */
  action?: Action;

  /** Human-readable description of what this step does/did */
  stepDescription: string;

  /** Key page context at time of step (topic, progress, etc.) */
  pageContext?: PageContext;
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
 * Learned strategy from first cycle, used to compress prompts for repeat cycles.
 * Extracted after the first cycle completes successfully.
 */
export interface CycleStrategy {
  /** Short description of the repeating pattern */
  pattern: string;

  /** Typical step sequence observed in first cycle */
  stepSequence: string[];

  /** Key element types/patterns to look for */
  keyElements: string[];
}

/**
 * Session tracker for both plan structure and live execution progress.
 * Created once at session start, updated throughout execution.
 *
 * Progress is computed from the structure:
 * - currentCycle = cycles.findIndex(c => !c.isCompleted)
 * - currentStep = cycle.cycleSteps.findIndex(s => !s.isCompleted)
 * - completedCycles = cycles.filter(c => c.isCompleted).length
 */
export interface SessionTracker {
  /** High-level summary of the goal */
  goalSummary: string;

  /** Description of what one cycle accomplishes */
  cycleDescription: string;

  /** All cycles (fixed count from initial analysis, steps grow dynamically) */
  cycles: Cycle[];

  /** When the session started (ISO 8601 string) */
  startedAt: string;

  /** Last time the plan was updated (ISO 8601 string) */
  lastUpdatedAt: string;

  /** Optional URL to navigate to at the beginning of each cycle */
  cycleStartUrl?: string;

  /** Learned strategy from first successful cycle (enables compressed prompts) */
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
