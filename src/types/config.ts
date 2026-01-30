// =============================================================================
// CONFIGURATION TYPES
// =============================================================================
// Configuration for goals, presets, browser, LLM, and human-in-the-loop

import type { SessionTracker } from './session.js';
import type { SessionPlan } from './actions.js';

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
// CONFIGURABLE SETTINGS
// -----------------------------------------------------------------------------

/**
 * Settings that can be configured via presets, CLI, or environment variables.
 * All fields optional - they override defaults when provided.
 */
export interface ConfigurableSettings {
  // ===== Task Definition =====
  goal?: Goal;
  startUrl?: string;

  // ===== Browser Settings =====
  headless?: boolean;
  slowMo?: number;
  profilePath?: string; // undefined = ephemeral, string = persistent
  stealth?: boolean;

  // ===== Browser Timeouts (ms) =====
  timeoutDefault?: number;
  timeoutNavigation?: number;
  timeoutElement?: number;
  postNavDelay?: number;

  // ===== Agent Control =====
  maxSteps?: number; // -1 = unlimited
  engagementMode?: EngagementMode;
  stepPause?: number;
  verbose?: boolean;

  // ===== LLM Settings =====
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmTimeout?: number; // ms, timeout for LLM API calls

  // ===== Prompt Token Limits =====
  tokenMarkdown?: number;
  tokenElements?: number;
  tokenMaxElements?: number;
  tokenHistory?: number;
}

// -----------------------------------------------------------------------------
// PRESET
// -----------------------------------------------------------------------------

/**
 * Pre-configured task template stored in presets/{name}/ directory.
 * Provides goal, settings overrides, and references to external files.
 */
export interface Preset extends ConfigurableSettings {
  // --- Preset Metadata (required) ---
  /** Unique identifier for this preset */
  name: string;

  /** Human-readable description */
  description: string;

  // --- Task Definition (required in preset) ---
  /** Goal to accomplish */
  goal: Goal;

  // --- File References (optional) ---
  /** Reference to session plan file (e.g., "./session-plan.json") */
  sessionPlanRef?: string;

  /** Reference to custom system prompt file (e.g., "./system-prompt.md") */
  systemPromptRef?: string;

  // Note: All ConfigurableSettings fields are inherited and optional
}

// -----------------------------------------------------------------------------
// RESOLVED CONFIGURATION
// -----------------------------------------------------------------------------

/**
 * Fully resolved configuration with all values defined.
 * Result of merging: Defaults → Environment → Preset → CLI/Programmatic
 *
 * All preset references (sessionPlanRef, systemPromptRef) are resolved
 * to actual content (sessionPlan, systemPrompt) by this point.
 */
export interface ResolvedConfig extends Required<Omit<ConfigurableSettings, 'goal' | 'startUrl' | 'profilePath'>> {
  // --- Task Definition (optional - can be provided later) ---
  goal?: Goal;

  // --- Start URL (optional - can be prompted for) ---
  startUrl?: string;

  // --- Profile Path (optional - undefined for ephemeral mode) ---
  profilePath?: string;

  // --- Loaded/Resolved Content ---
  /** Session plan - loaded from preset ref (human-authored blueprint) */
  sessionPlan?: SessionPlan;

  /** System prompt - loaded from preset ref OR provided directly */
  systemPrompt?: string;

  // Note: All other ConfigurableSettings fields are REQUIRED
  // (populated with defaults during resolution)
}

// -----------------------------------------------------------------------------
// USER INPUT
// -----------------------------------------------------------------------------

/**
 * User input to resolveConfig().
 * Represents what the user can provide via CLI or programmatic API.
 *
 * The user can provide:
 * 1. A preset (by name or object) to load defaults from
 * 2. Direct config overrides
 * 3. Both (overrides take precedence over preset)
 */
export interface UserInput {
  /**
   * Preset to load (by name or object).
   * If provided, preset values are loaded first, then overridden by other fields.
   */
  fromPreset?: Preset | string;

  /**
   * Direct configuration overrides.
   * These take precedence over preset values.
   */
  overrides?: Partial<ConfigurableSettings>;

  /**
   * Direct content (not from preset files).
   * Takes precedence over content loaded from preset references.
   */
  sessionPlan?: SessionPlan;
  systemPrompt?: string;
}

/**
 * @deprecated Use UserInput instead. Will be removed in next major version.
 */
export type ConfigInput = Partial<ResolvedConfig> & { preset?: Preset | string };
