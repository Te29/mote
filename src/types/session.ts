// =============================================================================
// SESSION TYPES
// =============================================================================
// Session tracking, cycles, steps, and progress helpers

import type { Action, SessionPlan } from './actions.js';
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
//                     └── CycleStepTracker
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

// -----------------------------------------------------------------------------
// STEP TYPES (Runtime)
// -----------------------------------------------------------------------------

/**
 * Runtime step record - common fields for all executed steps.
 * Used directly for session-level steps (setup/wrapup).
 * Extended by CycleStepTracker for cycle-specific fields.
 */
export interface StepTracker {
  /** Global sequence index across entire session (0, 1, 2...) */
  globalIndex: number;

  /** Reference to the ExecutionStep ID from blueprint */
  stepId: string;

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
 * Cycle step - extends StepTracker with cycle-specific fields.
 * Used for steps within repetitive cycles.
 */
export interface CycleStepTracker extends StepTracker {
  /** Reference to LoopPlan ID if inside a loop */
  loopId?: string;

  /** Loop iteration number (1-based) if inside a loop */
  loopIteration?: number;
}

/** 
 * Single loop statistics.
 * Tracks loop execution progress.
 */
export interface LoopStats {
  /** ID of the LoopPlan */
  loopId: string;
  
  /** Actual number of iterations completed */
  iterations: number;
  
  /** List of conditions that were met to continue each iteration */
  conditionsMet: string[];
}

/**
 * CycleTracker: Tracks one complete execution unit (cycle) of the goal.
 */
export interface CycleTracker {
  /** Has this entire cycle been completed? */
  isCompleted: boolean;

  /** Runtime step records */
  cycleSteps: CycleStepTracker[];

  /** Loop statistics for loops within this cycle */
  loopStats?: LoopStats[];

  /** Drift analysis for this cycle */
  driftAnalysis?: DriftAnalysis;
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
 * Record of a single drift detection and adaptation event.
 * Tracks when the actual page state diverged from expected plan.
 */
export interface DriftRecord {
  /** When drift was detected */
  timestamp: string;

  /** Which step experienced drift */
  stepId: string;

  /** Type of drift resolution used */
  resolutionMethod: 'exact_match' | 'alternative_match' | 'llm_adaptation' | 'failed';

  /** Original selector that failed */
  originalSelector: string;

  /** Adapted selector (if successful) */
  adaptedSelector?: string;

  /** LLM reasoning for adaptation (if used) */
  llmReason?: string;
}

/**
 * Drift analysis summary for a cycle.
 * Provides metrics on how much the execution diverged from the plan.
 */
export interface DriftAnalysis {
  /** Total drift incidents detected */
  totalDrifts: number;

  /** Successful adaptations */
  successfulAdaptations: number;

  /** Failed adaptations leading to termination */
  failedAdaptations: number;

  /** Detailed drift records */
  driftRecords: DriftRecord[];

  /** Overall drift severity: low | medium | high */
  severity: 'low' | 'medium' | 'high';
}

/**
 * SessionTracker: Entire session runtime state.
 * Created once at session start, updated throughout execution.
 * Tracks progress through a SessionPlan blueprint (if provided).
 *
 * Structure:
 *   setupSteps[]  → One-time setup before cycles
 *   cycles[]      → Repetitive execution units
 *   wrapupSteps[] → One-time finalization after cycles
 */
export interface SessionTracker {
  /**
   * Reference to the session plan being executed.
   * Provides access to cyclePlan, verification, etc. without duplication.
   * Only present when initialized from SessionPlan (not from goal-based generation).
   */
  sessionPlan?: SessionPlan;

  /** High-level goal description (from SessionPlan or Goal) */
  goalSummary: string;

  /** Description of what one cycle accomplishes (from SessionPlan or Goal) */
  cycleDescription: string;

  /** Session-level setup steps (executed once before cycles) */
  setupSteps?: StepTracker[];

  /** Execution records of all cycles */
  cycles: CycleTracker[];

  /** Session-level wrapup steps (executed once after all cycles complete) */
  wrapupSteps?: StepTracker[];

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
 * Get the current session section for progress reporting.
 * Flow: setup → cycles → wrapup → complete
 */
export function getCurrentSection(tracker: SessionTracker): 'setup' | 'cycles' | 'wrapup' | 'complete' {
  // Check setup phase
  // We're in setup if: SessionPlan defines setupSteps AND not all have been executed
  if (tracker.sessionPlan?.setupSteps && tracker.setupSteps) {
    const totalSetupSteps = tracker.sessionPlan.setupSteps.length;
    const executedSetupSteps = tracker.setupSteps.length;
    const allSetupComplete = tracker.setupSteps.every((s) => s.isCompleted);

    if (executedSetupSteps < totalSetupSteps || !allSetupComplete) {
      return 'setup';
    }
  }

  // Check cycles phase
  const hasIncompleteCycle = tracker.cycles.some((c) => !c.isCompleted);
  if (hasIncompleteCycle) return 'cycles';

  // Check wrapup phase
  // We're in wrapup if: SessionPlan defines wrapupSteps AND not all have been executed
  if (tracker.sessionPlan?.wrapupSteps && tracker.wrapupSteps) {
    const totalWrapupSteps = tracker.sessionPlan.wrapupSteps.length;
    const executedWrapupSteps = tracker.wrapupSteps.length;
    const allWrapupComplete = tracker.wrapupSteps.every((s) => s.isCompleted);

    if (executedWrapupSteps < totalWrapupSteps || !allWrapupComplete) {
      return 'wrapup';
    }
  }

  return 'complete';
}

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
export function getCurrentCycle(tracker: SessionTracker): CycleTracker | null {
  return tracker.cycles.find((c) => !c.isCompleted) || null;
}

/**
 * Get the index of the current (incomplete) step within a cycle.
 * Returns -1 if all steps are complete.
 */
export function getCurrentStepIndex(cycle: CycleTracker): number {
  return cycle.cycleSteps.findIndex((s) => !s.isCompleted);
}

/**
 * Get the index of the current (incomplete) runtime step.
 * Returns -1 if all steps are complete.
 */
export function getCurrentStepTrackerIndex(steps: StepTracker[]): number {
  return steps.findIndex((s) => !s.isCompleted);
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
 * Shows progress based on current phase.
 *
 * @example
 * "Setup: Step 1/3"
 * "Cycle 3/10, Step 2/5"
 * "Wrapup: Step 2/2"
 * "Session complete"
 */
export function getProgress(tracker: SessionTracker): string {
  const section = getCurrentSection(tracker);

  switch (section) {
    case 'setup': {
      const executedSteps = tracker.setupSteps!;
      const totalSteps = tracker.sessionPlan?.setupSteps?.length || executedSteps.length;
      const currentIdx = getCurrentStepTrackerIndex(executedSteps);
      // If all executed steps are complete but more steps remain, show next step number
      const stepNum =
        currentIdx === -1 && executedSteps.length < totalSteps
          ? executedSteps.length + 1
          : currentIdx === -1
            ? executedSteps.length
            : currentIdx + 1;
      return `Setup: Step ${stepNum}/${totalSteps}`;
    }

    case 'cycles': {
      const currentCycleIdx = getCurrentCycleIndex(tracker);

      // Safety check: if all cycles complete, return complete status
      if (currentCycleIdx === -1) {
        return 'Session complete';
      }

      const totalCycles = getTotalCycles(tracker);
      const cycle = tracker.cycles[currentCycleIdx];
      const currentStepIdx = getCurrentStepIndex(cycle);
      const totalSteps = cycle.cycleSteps.length;
      const cycleNum = currentCycleIdx + 1;
      const stepNum = currentStepIdx === -1 ? totalSteps : currentStepIdx + 1;
      return `Cycle ${cycleNum}/${totalCycles}, Step ${stepNum}/${totalSteps}`;
    }

    case 'wrapup': {
      const executedSteps = tracker.wrapupSteps!;
      const totalSteps = tracker.sessionPlan?.wrapupSteps?.length || executedSteps.length;
      const currentIdx = getCurrentStepTrackerIndex(executedSteps);
      // If all executed steps are complete but more steps remain, show next step number
      const stepNum =
        currentIdx === -1 && executedSteps.length < totalSteps
          ? executedSteps.length + 1
          : currentIdx === -1
            ? executedSteps.length
            : currentIdx + 1;
      return `Wrapup: Step ${stepNum}/${totalSteps}`;
    }

    case 'complete':
      return 'Session complete';
  }
}

// =============================================================================
// Loop Statistics Helpers
// =============================================================================

/**
 * Get total iterations across all loops in a cycle.
 */
export function getTotalLoopIterations(cycle: CycleTracker): number {
  return cycle.loopStats?.reduce((sum, stat) => sum + stat.iterations, 0) || 0;
}

/**
 * Get loop statistics summary for reporting.
 */
export function getLoopStatsSummary(cycle: CycleTracker): string {
  if (!cycle.loopStats || cycle.loopStats.length === 0) {
    return 'No loops executed';
  }

  return cycle.loopStats
    .map((stat) => `${stat.loopId}: ${stat.iterations} iterations`)
    .join(', ');
}

// =============================================================================
// Drift Analysis Helpers
// =============================================================================

/**
 * Get drift summary across all cycles.
 */
export function getDriftSummary(tracker: SessionTracker): {
  totalDrifts: number;
  totalAdaptations: number;
  avgSeverity: string;
} {
  const analyses = tracker.cycles
    .map((c) => c.driftAnalysis)
    .filter((a): a is DriftAnalysis => a !== undefined);

  if (analyses.length === 0) {
    return { totalDrifts: 0, totalAdaptations: 0, avgSeverity: 'none' };
  }

  const totalDrifts = analyses.reduce((sum, a) => sum + a.totalDrifts, 0);
  const totalAdaptations = analyses.reduce((sum, a) => sum + a.successfulAdaptations, 0);

  return {
    totalDrifts,
    totalAdaptations,
    avgSeverity:
      totalDrifts === 0 ? 'none' :
      totalDrifts < 3 ? 'low' :
      totalDrifts < 10 ? 'medium' :
      'high',
  };
}
