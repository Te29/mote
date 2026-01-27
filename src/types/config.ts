// =============================================================================
// CONFIGURATION TYPES
// =============================================================================
// Configuration for goals, presets, browser, LLM, and human-in-the-loop

import type { SessionTracker } from './session.js';
import type { ExecutionStep } from './actions.js';

// -----------------------------------------------------------------------------
// GOAL
// -----------------------------------------------------------------------------

/**
 * User's goal definition.
 *
 * @example
 * {
 *   name: 'Web Search',
 *   description: 'Search for TypeScript tutorials',
 *   context: { query: 'typescript tutorial 2024' }
 * }
 */
export interface Goal {
  /** Short name for this goal */
  name: string;

  /** What the user wants to accomplish */
  description: string;

  /** Runtime context data (e.g., search query, username) */
  context?: Record<string, string>;

  /** How to determine if the goal is achieved */
  successCriteria?: string;
}

// -----------------------------------------------------------------------------
// INTERVENTION / HUMAN-IN-THE-LOOP
// -----------------------------------------------------------------------------

/**
 * Points where the agent can pause for human approval/input.
 */
export type InterventionPoint =
  | 'PLAN_PREVIEW'      // Before execution starts
  | 'CYCLE_START'       // Before each cycle
  | 'ACTION'            // Before each action
  | 'TERMINAL'          // Before goal success/fail
  | 'REPLAN'            // Before regenerating plan
  | 'REPERCEIVE'        // Before re-observing page
  | 'CYCLE_END'         // After each cycle
  | 'ERROR'             // When action fails
  | 'INTERRUPT';        // User pressed interrupt key

/**
 * Valid engagement modes for runtime validation.
 */
export const VALID_ENGAGEMENT_MODES = [
  'autonomous',
  'minimal',
  'standard',
  'supervised',
  'full',
] as const;

/**
 * Engagement modes define how much human oversight is required.
 */
export type EngagementMode = typeof VALID_ENGAGEMENT_MODES[number];

/**
 * User response to an intervention.
 */
export type InterventionResponse =
  | { type: 'approve' }
  | { type: 'reject'; reason?: string }
  | { type: 'modify'; instruction: string }
  | { type: 'skip' }
  | { type: 'force_success'; message?: string }
  | { type: 'force_fail'; message?: string }
  | { type: 'pause' }
  | { type: 'quit' };

// -----------------------------------------------------------------------------
// RESOLVED CONFIGURATION
// -----------------------------------------------------------------------------

/**
 * Complete resolved configuration - all options in one flat structure.
 * All fields have defined values after resolution from all sources:
 * CLI/Programmatic → Preset → Environment → Defaults
 */
export interface ResolvedConfig {
  // ===== Task Definition =====
  goal?: Goal;
  sessionPlan?: SessionTracker;
  executionPath?: ExecutionStep[];
  startUrl?: string;

  // ===== Browser Settings =====
  headless: boolean;
  slowMo: number;
  profilePath?: string; // undefined = ephemeral, string = persistent
  stealth: boolean;

  // ===== Context / Metadata =====
  presetDir?: string;
  systemPrompt?: string;

  // ===== Browser Timeouts (ms) =====
  timeoutDefault: number;
  timeoutNavigation: number;
  timeoutElement: number;
  postNavDelay: number;

  // ===== Agent Control =====
  maxSteps: number; // -1 = unlimited
  engagementMode: EngagementMode;
  stepPause: number;
  verbose: boolean;

  // ===== LLM Settings =====
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeout: number; // ms, timeout for LLM API calls

  // ===== Prompt Token Limits =====
  tokenMarkdown: number;
  tokenElements: number;
  tokenMaxElements: number;
  tokenHistory: number;
}

// -----------------------------------------------------------------------------
// PRESET
// -----------------------------------------------------------------------------

/**
 * Pre-configured task template (guidebook) with goal, settings, and file references.
 * Stored as preset.json in presets/{preset-name}/ directory.
 *
 * Presets can override ANY configuration setting for maximum flexibility.
 */
export interface Preset extends Omit<Partial<ResolvedConfig>, 'goal' | 'executionPath'> {
  /** Unique identifier for this preset */
  name: string;

  /** Human-readable description */
  description: string;

  /** Goal to accomplish (required override) */
  goal: Goal;

  /** Reference to execution path file (e.g., "./execution-path.json") */
  executionPathRef?: string;

  /** Reference to custom system prompt file (e.g., "./system-prompt.md") */
  systemPromptRef?: string;

}

/**
 * Partial config for user input (all optional).
 * Used for CLI arguments, programmatic calls, presets, and env vars.
 */
export type ConfigInput = Partial<ResolvedConfig> & { preset?: Preset | string };
