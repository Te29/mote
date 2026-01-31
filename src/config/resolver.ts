// =============================================================================
// CONFIGURATION RESOLVER
// =============================================================================
//
// Central configuration resolution logic.
// Priority: CLI/Code > Preset > ENV > Defaults
//
// =============================================================================

import type { ResolvedConfig, UserInput, ConfigurableSettings, EngagementMode, Preset, SessionPlan } from '../types/index.js';
import { VALID_ENGAGEMENT_MODES } from '../types/index.js';
import { DEFAULT_CONFIG } from './defaults.js';
import * as path from 'path';
import {
  promptForPresetSelection,
  promptForGoal,
  promptForUrl,
} from '../interaction.js';
import { loadSessionPlan, loadSystemPrompt, loadPreset, getPresetsDir } from '../utils/preset.js';

/**
 * Load preset and resolve all file references.
 * Returns config values + loaded content.
 * presetDir is internal - not exposed to caller.
 */
async function loadPresetWithFiles(
  preset: Preset | string
): Promise<{
  config: Partial<ConfigurableSettings>;
  sessionPlan?: SessionPlan;
  systemPrompt?: string;
  metadata?: { name: string; dir: string };
}> {
  let loadedPreset: Preset;
  let presetDir: string | undefined;

  // Load preset object
  if (typeof preset === 'string') {
    const p = loadPreset(preset);
    if (!p) throw new Error(`Preset not found: ${preset}`);
    loadedPreset = p;
    presetDir = path.join(getPresetsDir(), preset);
  } else {
    loadedPreset = preset;
    // Programmatic preset - can't load files without directory
  }

  // Load referenced files (only if we have presetDir)
  const sessionPlan = presetDir && loadedPreset.sessionPlanRef
    ? loadSessionPlan(presetDir, loadedPreset.sessionPlanRef) ?? undefined
    : undefined;

  const systemPrompt = presetDir && loadedPreset.systemPromptRef
    ? loadSystemPrompt(presetDir, loadedPreset.systemPromptRef) ?? undefined
    : undefined;

  // Extract config (remove metadata and references)
  const { name, description, sessionPlanRef, systemPromptRef, ...config } = loadedPreset;

  return {
    config,
    sessionPlan,
    systemPrompt,
    metadata: presetDir ? { name, dir: presetDir } : undefined,
  };
}

/**
 * Resolve complete configuration from all sources.
 *
 * Priority order (highest to lowest):
 * 1. CLI/Programmatic input
 * 2. Preset configuration
 * 3. Environment variables
 * 4. Default values
 *
 * @param userInput - User's configuration input
 * @returns Fully resolved configuration with all values defined, plus preset metadata
 */
export async function resolveConfig(
  userInput: UserInput = {}
): Promise<{ config: ResolvedConfig; presetMetadata?: { name: string; dir: string } }> {
  // 1. Load from environment
  const envConfig = loadEnvConfig();

  // 2. Load from preset if provided
  let presetConfig: Partial<ConfigurableSettings> = {};
  let loadedSessionPlan: SessionPlan | undefined;
  let loadedSystemPrompt: string | undefined;
  let presetMetadata: { name: string; dir: string } | undefined;

  if (userInput.fromPreset) {
    // Preset provided programmatically
    const loaded = await loadPresetWithFiles(userInput.fromPreset);
    presetConfig = loaded.config;
    loadedSessionPlan = loaded.sessionPlan;
    loadedSystemPrompt = loaded.systemPrompt;
    presetMetadata = loaded.metadata;
  } else if (!userInput.overrides?.goal) {
    // No preset or goal - prompt user to select preset or enter new goal
    const selected = await promptForPresetSelection();
    if (selected) {
      const loaded = await loadPresetWithFiles(selected.preset);
      presetConfig = loaded.config;
      loadedSessionPlan = loaded.sessionPlan;
      loadedSystemPrompt = loaded.systemPrompt;
      presetMetadata = { name: selected.preset.name, dir: selected.presetDir };
    } else {
      // User chose to enter a new goal
      if (!userInput.overrides) userInput.overrides = {};
      userInput.overrides.goal = await promptForGoal();
    }
  }

  // 3. Merge in priority order (right overrides left)
  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...presetConfig,
    ...userInput.overrides,
    // Content priority: direct > loaded > undefined
    sessionPlan: userInput.sessionPlan ?? loadedSessionPlan,
    systemPrompt: userInput.systemPrompt ?? loadedSystemPrompt,
  } as ResolvedConfig;

  // 4. Handle special cases

  // Profile path: convert 'none' or '' to undefined for ephemeral mode
  if (merged.profilePath === 'none' || merged.profilePath === '') {
    merged.profilePath = undefined;
  }

  // 5. Prompt for missing required values
  if (!merged.startUrl) {
    merged.startUrl = await promptForUrl();
  }

  return { config: merged, presetMetadata };
}

/**
 * Load configuration from environment variables.
 * Returns partial config with only values that are set in env.
 */
function loadEnvConfig(): Partial<ConfigurableSettings> {
  const config: Partial<ConfigurableSettings> = {};

  // Browser settings
  if (process.env.HEADLESS === 'true') {
    config.headless = true;
  }
  if (process.env.SLOW_MO) {
    const parsed = parseInt(process.env.SLOW_MO, 10);
    if (!isNaN(parsed)) config.slowMo = parsed;
  }
  if (process.env.PROFILE_PATH !== undefined) {
    config.profilePath = process.env.PROFILE_PATH;
  }
  if (process.env.STEALTH === 'false') {
    config.stealth = false;
  }

  // Browser timeouts
  if (process.env.TIMEOUT_DEFAULT) {
    const parsed = parseInt(process.env.TIMEOUT_DEFAULT, 10);
    if (!isNaN(parsed)) config.timeoutDefault = parsed;
  }
  if (process.env.TIMEOUT_NAVIGATION) {
    const parsed = parseInt(process.env.TIMEOUT_NAVIGATION, 10);
    if (!isNaN(parsed)) config.timeoutNavigation = parsed;
  }
  if (process.env.TIMEOUT_ELEMENT) {
    const parsed = parseInt(process.env.TIMEOUT_ELEMENT, 10);
    if (!isNaN(parsed)) config.timeoutElement = parsed;
  }
  if (process.env.POST_NAV_DELAY) {
    const parsed = parseInt(process.env.POST_NAV_DELAY, 10);
    if (!isNaN(parsed)) config.postNavDelay = parsed;
  }

  // Agent control
  if (process.env.MAX_STEPS) {
    const maxStepsEnv = process.env.MAX_STEPS;
    if (maxStepsEnv === '-1' || maxStepsEnv === 'unlimited') {
      config.maxSteps = -1;
    } else {
      const parsed = parseInt(maxStepsEnv, 10);
      if (!isNaN(parsed)) config.maxSteps = parsed;
    }
  }
  if (process.env.ENGAGEMENT_MODE) {
    const mode = parseEngagementMode(process.env.ENGAGEMENT_MODE);
    if (mode) config.engagementMode = mode;
  }
  if (process.env.STEP_PAUSE) {
    const parsed = parseInt(process.env.STEP_PAUSE, 10);
    if (!isNaN(parsed)) config.stepPause = parsed;
  }
  if (process.env.VERBOSE === 'false') {
    config.verbose = false;
  }

  // LLM settings
  if (process.env.LLM_BASE_URL) {
    config.llmBaseUrl = process.env.LLM_BASE_URL;
  }
  if (process.env.LLM_API_KEY) {
    config.llmApiKey = process.env.LLM_API_KEY;
  }
  if (process.env.LLM_MODEL) {
    config.llmModel = process.env.LLM_MODEL;
  }
  if (process.env.LLM_TIMEOUT) {
    const parsed = parseInt(process.env.LLM_TIMEOUT, 10);
    if (!isNaN(parsed)) config.llmTimeout = parsed;
  }

  // Prompt token limits
  if (process.env.LLM_PROMPT_MARKDOWN_TOKENS) {
    const parsed = parseInt(process.env.LLM_PROMPT_MARKDOWN_TOKENS, 10);
    if (!isNaN(parsed)) config.tokenMarkdown = parsed;
  }
  if (process.env.LLM_PROMPT_ELEMENTS_TOKENS) {
    const parsed = parseInt(process.env.LLM_PROMPT_ELEMENTS_TOKENS, 10);
    if (!isNaN(parsed)) config.tokenElements = parsed;
  }
  if (process.env.LLM_PROMPT_MAX_ELEMENTS) {
    const parsed = parseInt(process.env.LLM_PROMPT_MAX_ELEMENTS, 10);
    if (!isNaN(parsed)) config.tokenMaxElements = parsed;
  }
  if (process.env.LLM_PROMPT_HISTORY_TOKENS) {
    const parsed = parseInt(process.env.LLM_PROMPT_HISTORY_TOKENS, 10);
    if (!isNaN(parsed)) config.tokenHistory = parsed;
  }

  return config;
}


/**
 * Parse engagement mode from string with validation.
 */
function parseEngagementMode(value: string): EngagementMode | undefined {
  return VALID_ENGAGEMENT_MODES.includes(value as EngagementMode)
    ? (value as EngagementMode)
    : undefined;
}
