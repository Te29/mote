// =============================================================================
// AGENT CONTEXT TYPES
// =============================================================================
// Context object passed to all state machine handlers

import type { Page } from 'playwright';
import type {
  Goal,
  Preset,
  SessionTracker,
  StepResult,
  PageState,
  EngagementMode,
  ExecutionStep,
  ExecutionPath,
} from './index.js';
import type { InterventionMetrics } from '../prompt.js';
import type { AgentServices } from './services.js';

// =============================================================================
// INTERMEDIATE TYPES (for better organization)
// =============================================================================

/**
 * Immutable agent settings used in context.
 * These are a subset of ResolvedConfig, containing only the settings
 * needed by handlers during execution.
 * Set once in mote.ts and never changed during execution.
 */
export interface AgentSettings {
  /**
   * High-level goal for the agent session.
   * IMMUTABLE - set once, never modified.
   */
  goal?: Goal;

  /**
   * Optional preset with configuration.
   * IMMUTABLE - set once, never modified (refs only, not data).
   */
  preset?: Preset;

  /**
   * Preset directory path (for loading referenced files).
   * IMMUTABLE - set once when preset is selected.
   */
  presetDir?: string;

  /**
   * Loaded execution path from preset (if exists).
   * Used to guide execution.
   * Can be updated during adaptive execution.
   */
  executionPath?: ExecutionPath;

  /**
   * Custom system prompt loaded from preset (if exists).
   * IMMUTABLE - set once at startup.
   */
  customSystemPrompt?: string;

  /**
   * Engagement mode controlling intervention frequency.
   * IMMUTABLE - set once, never modified.
   */
  engagementMode: EngagementMode;

  /**
   * Whether to output verbose logging.
   * IMMUTABLE - set once, never modified.
   */
  verbose: boolean;

  /**
   * Maximum number of steps before termination (-1 for unlimited).
   * IMMUTABLE - set once, never modified.
   */
  maxSteps: number;

  /**
   * Milliseconds to pause between steps.
   * IMMUTABLE - set once, never modified.
   */
  stepPause: number;

  /**
   * Max tokens for markdown content in prompts.
   */
  tokenMarkdown: number;

  /**
   * Max tokens for element list in prompts.
   */
  tokenElements: number;

  /**
   * Max number of elements to include in prompts.
   */
  tokenMaxElements: number;

  /**
   * Max tokens for history steps in prompts.
   */
  tokenHistory: number;
}

/**
 * Mutable state tracking agent progress throughout execution.
 * These values are frequently modified by handlers to track session progress.
 */
export interface AgentTrackingState {
  /**
   * Session progress tracker with hierarchical cycle/step structure.
   * MUTATIONS:
   * - cycle.ts: Updates cycle completion status (line 230), timestamps (line 231)
   * - reason.ts: Regenerates entire tracker on REPLAN (lines 184, 231)
   * - act.ts: Appends cycle steps as actions execute (lines 152-158), updates timestamps (lines 158, 204)
   */
  tracker: SessionTracker;

  /**
   * Append-only history of executed steps with results.
   * MUTATIONS:
   * - act.ts: Pushes new StepResult after each action (line 198)
   */
  history: StepResult[];

  /**
   * Metrics for intervention decision-making.
   * MUTATIONS:
   * - cycle.ts: Resets per-cycle counters at cycle start (lines 45-46)
   * - reason.ts: Increments replan/reobserve counts (lines 187, 233, 302)
   * - act.ts: Updates consecutive failures (lines 209, 212)
   */
  interventionMetrics: InterventionMetrics;
}

/**
 * Mutable runtime state specific to current execution context.
 * These values track the current state of the browser and observation.
 */
export interface AgentRuntimeState {
  /**
   * Currently active Playwright page.
   * MUTATIONS:
   * - act.ts: Updates when actions open new tabs (line 168)
   */
  activePage: Page;

  /**
   * URL of the last observed page (for optimization).
   * MUTATIONS:
   * - observe.ts: Updates after each observation (line 186)
   */
  lastObservedUrl: string | null;

  /**
   * Last observed page state (cached for reasoning).
   * MUTATIONS:
   * - observe.ts: Updates after each observation (line 187)
   */
  lastPageState: PageState | null;

  /**
   * Whether any ExecutionSteps were adapted during this session.
   * Used for self-healing - prompts user to update preset if true.
   * MUTATIONS:
   * - observe.ts: Sets to true when adaptation occurs
   */
  hadAdaptations: boolean;

  /**
   * Current pointer in the execution path.
   * [unitIndex, stepIndex?]
   * - [0] = 1st ExecutionUnit (Step or Loop)
   * - [1, 2] = 2nd ExecutionUnit (Loop), 3rd step inside it
   */
  executionPointer: number[];
  
  /**
   * Runtime state for active loops.
   * Key: loopId, Value: { iteration: number }
   */
  loopStates: Record<string, { iteration: number }>;

  /**
   * Pending instruction from user intervention.
   * If set, REASON handler will prioritize this over cached execution path (treating it as an adaptation).
   * MUTATIONS:
   * - observe.ts: Sets when user interrupts with 'modify'
   * - reason.ts: Consumes (clears) after acting on it
   */
  pendingUserInstruction?: string;
}

// =============================================================================
// AGENT CONTEXT (combines all sections)
// =============================================================================

/**
 * Context object passed to all state machine handlers.
 * Contains configuration, services, and runtime state.
 *
 * This interface combines AgentSettings, AgentTrackingState, and AgentRuntimeState
 * into a single flat structure. Use the intermediate
 * types when you need to work with specific sections.
 *
 * LIFECYCLE:
 * 1. Created once in mote.ts (lines 451-478)
 * 2. Passed to handlers: handleCycleStart, handleCycleEnd, handleObserve, handleReason, handleAct
 * 3. Handlers mutate specific properties based on ownership rules (see property docs)
 * 4. Final state used to construct AgentResult
 *
 * MUTATION OWNERSHIP:
 * - tracker: Mutated by cycle.ts (completion status), reason.ts (replanning), act.ts (steps)
 * - history: Mutated by act.ts only (append-only)
 * - interventionMetrics: Mutated by cycle.ts, reason.ts, act.ts
 * - preset: Mutated by observe.ts (drift correction updates)
 * - runtime.*: Each property has specific handler ownership (see property docs)
 *
 * @see AgentSettings for immutable configuration properties
 * @see AgentTrackingState for mutable tracking state
 * @see AgentRuntimeState for mutable runtime state
 * @see AgentServices for service interfaces
 */
export interface AgentContext extends AgentSettings, AgentTrackingState {
  /**
   * Service dependencies injected at agent initialization.
   * All services are immutable references (the modules themselves don't change).
   * Services implement formal interfaces for better testability and mocking.
   * @see AgentServices for interface definitions
   */
  services: AgentServices;

  /**
   * Runtime state container for execution-specific mutable values.
   * Each property within has specific mutation ownership.
   * @see AgentRuntimeState for property details
   */
  runtime: AgentRuntimeState;
}
