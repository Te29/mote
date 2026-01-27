// =============================================================================
// CONFIGURATION RESOLVER
// =============================================================================
//
// Central configuration resolution logic.
// Priority: CLI/Code > Preset > ENV > Defaults
//
// =============================================================================

import type { ResolvedConfig, ConfigInput, EngagementMode, Preset } from '../types/index.js';
import { VALID_ENGAGEMENT_MODES } from '../types/index.js';
import { DEFAULT_CONFIG } from './defaults.js';
import * as path from 'path';
import {
  promptForPresetSelection,
  promptForGoal,
  promptForUrl,
} from '../interaction.js';
import { loadExecutionPath, loadSystemPrompt, loadPreset, getPresetsDir } from '../utils/preset.js';

/**
 * Resolve complete configuration from all sources.
 *
 * Priority order (highest to lowest):
 * 1. CLI/Programmatic input
 * 2. Preset configuration
 * 3. Environment variables
 * 4. Default values
 *
 * @param cliInput - Configuration from runAgent() call
 * @returns Fully resolved configuration with all values defined
 */
export async function resolveConfig(
  cliInput: ConfigInput = {}
): Promise<ResolvedConfig> {
  // 1. Load from environment
  const envConfig = loadEnvConfig();

  // 2. Handle preset selection
  let presetConfig: ConfigInput = {};
  let presetDir: string | undefined;

  if (cliInput.preset) {
    // Preset provided programmatically
    // Resolve preset object (either passed directly or loaded by name)
    let loadedPreset: Preset;
    if (typeof cliInput.preset === 'string') {
      const name = cliInput.preset;
      const p = loadPreset(name);
      if (!p) throw new Error(`Preset not found: ${name}`);
      loadedPreset = p;
      presetDir = path.join(getPresetsDir(), name);
    } else {
      loadedPreset = cliInput.preset;
      // Note: If passed as object, presetDir might be unknown unless provided in cliInput
    }
    presetConfig = loadPresetConfig(loadedPreset);

    // Load referenced files for programmatic presets
    if (presetDir) {
      if (!cliInput.executionPath && loadedPreset.executionPathRef) {
        cliInput.executionPath = loadExecutionPath(presetDir, loadedPreset.executionPathRef) ?? undefined;
      }
      if (!cliInput.systemPrompt && loadedPreset.systemPromptRef) {
        cliInput.systemPrompt = loadSystemPrompt(presetDir, loadedPreset.systemPromptRef) ?? undefined;
        cliInput.presetDir = presetDir;
      }
    }
  } else if (!cliInput.goal) {
    // No goal or preset - prompt user to select preset or enter new goal
    const selected = await promptForPresetSelection();
    if (selected) {
      presetConfig = loadPresetConfig(selected.preset);
      presetDir = selected.presetDir;

      // Load referenced files from preset directory
      if (!cliInput.executionPath && selected.preset.executionPathRef) {
        cliInput.executionPath = loadExecutionPath(
          presetDir,
          selected.preset.executionPathRef
        ) ?? undefined;
      }
      if (selected.preset.systemPromptRef) {
        cliInput.systemPrompt = loadSystemPrompt(
          presetDir,
          selected.preset.systemPromptRef
        ) ?? undefined;
        cliInput.presetDir = presetDir;
      }
    } else {
      // User chose to enter a new goal
      cliInput.goal = await promptForGoal();
    }
  }

  // 3. Merge in priority order (right overrides left)
  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...presetConfig,
    ...cliInput,
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

  return merged;
}

/**
 * Load configuration from environment variables.
 * Returns partial config with only values that are set in env.
 */
function loadEnvConfig(): ConfigInput {
  const config: ConfigInput = {};

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
 * Load configuration from preset.
 * Presets can override any setting.
 */
function loadPresetConfig(preset: Preset): ConfigInput {
  const config: ConfigInput = {
    goal: preset.goal,
    startUrl: preset.startUrl,
    sessionPlan: preset.sessionPlan,
    systemPrompt: (preset as any).systemPrompt, // If already resolved
  };

  // If we have a ref but not the resolved text, we'll mark it for resolution
  // and carry it over if the resolver knows how to handle it, 
  // but for now we'll just handle it in the main loop or here if we have dir context.
  (config as any).systemPromptRef = preset.systemPromptRef;



  // Map flat preset properties to internal config structure
  if (preset.maxSteps !== undefined) config.maxSteps = preset.maxSteps;
  if (preset.engagementMode !== undefined) config.engagementMode = preset.engagementMode;
  if (preset.stepPause !== undefined) config.stepPause = preset.stepPause;
  if (preset.verbose !== undefined) config.verbose = preset.verbose;

  // Browser settings
  if (preset.headless !== undefined) config.headless = preset.headless;
  if (preset.slowMo !== undefined) config.slowMo = preset.slowMo;
  if (preset.profilePath !== undefined) config.profilePath = preset.profilePath;
  if (preset.stealth !== undefined) config.stealth = preset.stealth;

  // Timeouts
  if (preset.timeoutDefault !== undefined) config.timeoutDefault = preset.timeoutDefault;
  if (preset.timeoutNavigation !== undefined) config.timeoutNavigation = preset.timeoutNavigation;
  if (preset.timeoutElement !== undefined) config.timeoutElement = preset.timeoutElement;
  if (preset.postNavDelay !== undefined) config.postNavDelay = preset.postNavDelay;

  // LLM settings
  if (preset.llmBaseUrl !== undefined) config.llmBaseUrl = preset.llmBaseUrl;
  if (preset.llmApiKey !== undefined) config.llmApiKey = preset.llmApiKey;
  if (preset.llmModel !== undefined) config.llmModel = preset.llmModel;

  // Token limits
  if (preset.tokenMarkdown !== undefined) config.tokenMarkdown = preset.tokenMarkdown;
  if (preset.tokenElements !== undefined) config.tokenElements = preset.tokenElements;
  if (preset.tokenMaxElements !== undefined) config.tokenMaxElements = preset.tokenMaxElements;
  if (preset.tokenHistory !== undefined) config.tokenHistory = preset.tokenHistory;

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
