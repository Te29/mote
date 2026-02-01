// =============================================================================
// RECORDER BOOTSTRAP
// =============================================================================
// Initialize recording session: prompts, files, browser, LLM client.
// Mirrors pattern from src/bootstrap/bootstrap.ts.

import * as fs from 'fs';
import * as path from 'path';
import type { ResolvedConfig, Preset, SessionPlan } from '../types/index.js';
import type { RecorderContext, RecorderBootstrapResult, RecorderCheckpoint } from './types.js';
import { promptRecordingInit, promptResumeCheckpoint } from './prompts.js';
import { loadCheckpoint, getCheckpointPath } from './checkpoint.js';
import { getPresetsDir } from '../utils/preset.js';
import { launchBrowser, navigateTo } from '../browser.js';
import { createLLMClient } from '../reason.js';

// -----------------------------------------------------------------------------
// BOOTSTRAP CONFIGURATION
// -----------------------------------------------------------------------------

export interface RecorderBootstrapConfig {
  /** LLM configuration */
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmTimeout?: number;

  /** Browser configuration */
  headless?: boolean;
  slowMo?: number;
  profilePath?: string;
  stealth?: boolean;

  /** Optional preset directory to resume */
  resumePresetDir?: string;
}

// -----------------------------------------------------------------------------
// BOOTSTRAP FUNCTION
// -----------------------------------------------------------------------------

/**
 * Bootstrap the recorder session.
 * Sets up preset files, browser, and LLM client.
 */
export async function bootstrapRecorder(
  config: RecorderBootstrapConfig = {},
): Promise<RecorderBootstrapResult> {
  // Check for resume from existing preset
  if (config.resumePresetDir) {
    const checkpointPath = getCheckpointPath(config.resumePresetDir);
    const checkpoint = loadCheckpoint(checkpointPath);

    if (checkpoint) {
      const shouldResume = await promptResumeCheckpoint(config.resumePresetDir);
      if (shouldResume) {
        return resumeFromCheckpoint(config, checkpoint, config.resumePresetDir);
      }
    }
  }

  // Fresh recording session
  return startFreshRecording(config);
}

// -----------------------------------------------------------------------------
// FRESH RECORDING
// -----------------------------------------------------------------------------

async function startFreshRecording(
  config: RecorderBootstrapConfig,
): Promise<RecorderBootstrapResult> {
  // 1. Prompt user for initial info
  const { name, goal, startUrl } = await promptRecordingInit();

  // 2. Create preset directory
  const presetsDir = getPresetsDir();
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const presetDir = path.join(presetsDir, safeName);

  if (!fs.existsSync(presetDir)) {
    fs.mkdirSync(presetDir, { recursive: true });
  }

  // Create prompts subdirectory
  const promptsDir = path.join(presetDir, 'prompts');
  if (!fs.existsSync(promptsDir)) {
    fs.mkdirSync(promptsDir, { recursive: true });
  }

  // 3. Create initial preset configuration
  const preset: Preset = {
    name,
    description: goal.description,
    goal,
    startUrl,
    sessionPlanRef: './session-plan.json',
  };

  // 4. Create initial session plan (empty structure)
  const sessionPlan: SessionPlan = {
    goalSummary: goal.description,
    cycleDescription: 'One iteration of the main workflow',
    numberOfCycles: 1,
    setupSteps: [],
    cyclePlan: { units: [] },
    wrapupSteps: [],
  };

  // 5. Save initial files
  fs.writeFileSync(
    path.join(presetDir, 'preset.json'),
    JSON.stringify(preset, null, 2),
  );
  fs.writeFileSync(
    path.join(presetDir, 'session-plan.json'),
    JSON.stringify(sessionPlan, null, 2),
  );

  console.log(`\n📁 Created preset directory: ${presetDir}`);

  // 6. Launch browser
  console.log('\n🌐 Launching browser...');
  const browserConfig: Partial<ResolvedConfig> = {
    headless: config.headless ?? false,
    slowMo: config.slowMo ?? 0,
    profilePath: config.profilePath ?? './mote-recorder-profile',
    stealth: config.stealth ?? true,
    timeoutDefault: 30000,
    timeoutNavigation: 60000,
    timeoutElement: 10000,
    postNavDelay: 500,
  };

  const session = await launchBrowser(browserConfig as ResolvedConfig);

  // Navigate to start URL
  console.log(`   Navigating to: ${startUrl}`);
  await navigateTo(session.page, startUrl);

  // 7. Create LLM client
  const llmClient = createLLMClient(
    config.llmBaseUrl || config.llmApiKey || config.llmModel
      ? {
          llmBaseUrl: config.llmBaseUrl ?? '',
          llmApiKey: config.llmApiKey ?? '',
          llmModel: config.llmModel ?? '',
          llmTimeout: config.llmTimeout ?? 60000,
        }
      : undefined,
  );

  // 8. Build context
  const context: RecorderContext = {
    preset,
    sessionPlan,
    presetDir,
    currentSection: 'setup',
    activeLoopId: null,
    stepCounter: 0,
    page: session.page,
    llmClient,
    checkpointPath: getCheckpointPath(presetDir),
  };

  console.log('\n✅ Recording session initialized');
  console.log('   Perform actions in the browser. Press Ctrl+C for options.\n');

  return { context, presetDir };
}

// -----------------------------------------------------------------------------
// RESUME FROM CHECKPOINT
// -----------------------------------------------------------------------------

async function resumeFromCheckpoint(
  config: RecorderBootstrapConfig,
  checkpoint: RecorderCheckpoint,
  presetDir: string,
): Promise<RecorderBootstrapResult> {
  console.log(`\n📂 Resuming recording session...`);
  console.log(`   Section: ${checkpoint.currentSection}`);
  console.log(`   Steps recorded: ${checkpoint.stepCounter}`);
  console.log(`   Last saved: ${checkpoint.timestamp}`);

  // Launch browser
  console.log('\n🌐 Launching browser...');
  const browserConfig: Partial<ResolvedConfig> = {
    headless: config.headless ?? false,
    slowMo: config.slowMo ?? 0,
    profilePath: config.profilePath ?? './mote-recorder-profile',
    stealth: config.stealth ?? true,
    timeoutDefault: 30000,
    timeoutNavigation: 60000,
    timeoutElement: 10000,
    postNavDelay: 500,
  };

  const session = await launchBrowser(browserConfig as ResolvedConfig);

  // Navigate to start URL
  const startUrl = checkpoint.preset.startUrl || 'https://www.google.com';
  console.log(`   Navigating to: ${startUrl}`);
  await navigateTo(session.page, startUrl);

  // Create LLM client
  const llmClient = createLLMClient(
    config.llmBaseUrl || config.llmApiKey || config.llmModel
      ? {
          llmBaseUrl: config.llmBaseUrl ?? '',
          llmApiKey: config.llmApiKey ?? '',
          llmModel: config.llmModel ?? '',
          llmTimeout: config.llmTimeout ?? 60000,
        }
      : undefined,
  );

  // Build context from checkpoint
  const context: RecorderContext = {
    preset: checkpoint.preset,
    sessionPlan: checkpoint.sessionPlan,
    presetDir,
    currentSection: checkpoint.currentSection,
    activeLoopId: checkpoint.activeLoopId,
    stepCounter: checkpoint.stepCounter,
    page: session.page,
    llmClient,
    checkpointPath: getCheckpointPath(presetDir),
  };

  console.log('\n✅ Recording session resumed');
  console.log('   Perform actions in the browser. Press Ctrl+C for options.\n');

  return { context, presetDir };
}
