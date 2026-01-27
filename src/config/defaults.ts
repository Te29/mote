// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================
// Fallback values for all configuration options.
// Used when no other source (CLI, Preset, Env) provides a value.

import type { ResolvedConfig } from '../types/index.js';

/**
 * Default configuration values.
 * Implements ResolvedConfig to ensure complete coverage.
 */
export const DEFAULT_CONFIG: ResolvedConfig = {
  // ===== Task Definition =====
  goal: undefined,
  sessionPlan: undefined,
  executionPath: undefined,
  startUrl: undefined,

  // ===== Browser Settings =====
  headless: false,
  slowMo: 100,
  profilePath: './mote-profile',
  stealth: true,

  // ===== Context / Metadata =====
  presetDir: undefined,
  systemPrompt: undefined,

  // ===== Browser Timeouts (ms) =====
  timeoutDefault: 30000,
  timeoutNavigation: 30000,
  timeoutElement: 5000,
  postNavDelay: 500,

  // ===== Agent Control =====
  maxSteps: 50,
  engagementMode: 'standard',
  stepPause: 500,
  verbose: true,

  // ===== LLM Settings =====
  llmBaseUrl: 'http://localhost:11434/v1',
  llmApiKey: 'ollama',
  llmModel: 'llama3.2',
  llmTimeout: 60000, // 60 seconds

  // ===== Prompt Token Limits =====
  tokenMarkdown: 1500,
  tokenElements: 2000,
  tokenMaxElements: 50,
  tokenHistory: 1000,
};
