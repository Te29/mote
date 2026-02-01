// =============================================================================
// RECORDER TYPES
// =============================================================================
// Type definitions for the preset recording module.
// Mirrors patterns from src/types/ for consistency.

import type { Page } from 'playwright';
import type OpenAI from 'openai';
import type {
  Preset,
  SessionPlan,
  Goal,
  WebAction,
} from '../types/index.js';

// -----------------------------------------------------------------------------
// RECORDING STATE MACHINE
// -----------------------------------------------------------------------------

/**
 * Recording state machine phases.
 */
export type RecordingPhase = 'INIT' | 'RECORDING' | 'FINALIZE' | 'DONE';

/**
 * Recording section within RECORDING phase.
 */
export type RecordingSection = 'setup' | 'cycle' | 'wrapup';

/**
 * Recorder state - discriminated union (mirrors AgentState pattern).
 */
export type RecorderState =
  | { phase: 'INIT' }
  | { phase: 'RECORDING'; section: RecordingSection; loopId?: string }
  | { phase: 'FINALIZE' }
  | { phase: 'DONE'; presetDir: string };

// -----------------------------------------------------------------------------
// RECORDED ACTION
// -----------------------------------------------------------------------------

/**
 * Element information captured from browser.
 */
export interface RecordedElementInfo {
  tag: string;
  text: string;
  attributes: Record<string, string>;
}

/**
 * Action captured from user interaction in browser.
 * Uses WebAction type from existing codebase for consistency.
 */
export interface RecordedAction {
  /** Action type (reuses WebAction) */
  type: WebAction;

  /** Primary CSS selector for the target element */
  selector: string;

  /** Alternative selectors for resilience */
  alternativeSelectors?: string[];

  /** Value for type/select actions */
  value?: string;

  /** Element information */
  elementInfo: RecordedElementInfo;

  /** When the action was recorded */
  timestamp: string;
}

// -----------------------------------------------------------------------------
// RECORDER CONTEXT
// -----------------------------------------------------------------------------

/**
 * Recorder context - passed through all handlers (mirrors AgentContext pattern).
 */
export interface RecorderContext {
  // --- Preset being built ---
  /** Preset configuration */
  preset: Preset;

  /** Session plan being constructed */
  sessionPlan: SessionPlan;

  /** Directory where preset is saved */
  presetDir: string;

  // --- Current state ---
  /** Current recording section */
  currentSection: RecordingSection;

  /** Active loop ID (null if not in a loop) */
  activeLoopId: string | null;

  /** Step counter for generating unique IDs */
  stepCounter: number;

  // --- Browser ---
  /** Playwright page instance */
  page: Page;

  // --- Services ---
  /** LLM client for prompt/script generation */
  llmClient: OpenAI;

  // --- Checkpoint ---
  /** Path to checkpoint file */
  checkpointPath: string;
}

// -----------------------------------------------------------------------------
// USER DECISIONS
// -----------------------------------------------------------------------------

/**
 * User's decision after reviewing a recorded action.
 */
export type ActionDecision =
  | {
      action: 'keep';
      description: string;
      generatePrompt: boolean;
      generateVerification: boolean;
    }
  | { action: 'discard' }
  | { action: 'edit'; newSelector: string }
  | { action: 'menu' };

/**
 * Phase control action from user.
 */
export type PhaseControlAction =
  | 'continue'       // Keep recording actions
  | 'start-loop'     // Begin a loop
  | 'end-loop'       // End current loop
  | 'verification'   // Add verification script
  | 'next-section'   // Move to next section
  | 'done';          // Finish recording

// -----------------------------------------------------------------------------
// LOOP CONFIGURATION
// -----------------------------------------------------------------------------

/**
 * Loop configuration from user input.
 */
export interface LoopConfig {
  /** Number of iterations (for fixed loops) */
  iterations?: number;

  /** Condition description (for conditional loops) */
  conditionDescription?: string;
}

// -----------------------------------------------------------------------------
// RECORDER RESULT
// -----------------------------------------------------------------------------

/**
 * Result of recorder execution.
 */
export interface RecorderResult {
  /** Whether recording completed successfully */
  success: boolean;

  /** Path to created preset directory */
  presetDir: string;

  /** Result message */
  message: string;
}

// -----------------------------------------------------------------------------
// BOOTSTRAP RESULT
// -----------------------------------------------------------------------------

/**
 * Result of recorder bootstrap.
 */
export interface RecorderBootstrapResult {
  /** Initialized recorder context */
  context: RecorderContext;

  /** Path to preset directory */
  presetDir: string;
}

// -----------------------------------------------------------------------------
// CHECKPOINT
// -----------------------------------------------------------------------------

/**
 * Checkpoint data for crash recovery.
 */
export interface RecorderCheckpoint {
  /** Current recording section */
  currentSection: RecordingSection;

  /** Active loop ID */
  activeLoopId: string | null;

  /** Step counter */
  stepCounter: number;

  /** Session plan state */
  sessionPlan: SessionPlan;

  /** Preset configuration */
  preset: Preset;

  /** When checkpoint was saved */
  timestamp: string;
}

// -----------------------------------------------------------------------------
// INIT RESULT
// -----------------------------------------------------------------------------

/**
 * Result of init prompts.
 */
export interface RecordingInitResult {
  /** Preset name */
  name: string;

  /** Goal configuration */
  goal: Goal;

  /** Start URL */
  startUrl: string;
}
