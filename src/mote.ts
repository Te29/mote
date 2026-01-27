// =============================================================================
// MOTE - Main Entry Point
// =============================================================================

import { config } from 'dotenv';
import type { AgentResult, SessionTracker } from './types/index.js';
import { createTimestamp } from './types/index.js';
import {
  resolveConfig,
  type ConfigInput,
  type ResolvedConfig,
} from './config/index.js';
import {
  bootstrap,
  type BootstrapResult,
  handlePlanPreview,
} from './bootstrap/index.js';
import {
  executeRuntime,
  type RuntimeSettings,
  type RuntimeResult,
  assembleResult,
} from './runtime/index.js';
import { closeReadline } from './interaction.js';
import { logVariable } from './utils/debug.js';

// Load environment variables
config();

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Extract RuntimeSettings from ResolvedConfig.
 */
function extractSettings(config: ResolvedConfig): RuntimeSettings {
  return {
    goal: config.goal,
    presetDir: config.presetDir,
    executionPath: config.executionPath,
    customSystemPrompt: config.systemPrompt,
    engagementMode: config.engagementMode,
    verbose: config.verbose,
    maxSteps: config.maxSteps,
    stepPause: config.stepPause,
  };
}

/**
 * Cleanup resources (browser, readline, listeners).
 */
async function cleanup(bootstrap: BootstrapResult): Promise<void> {
  console.log('\n🧹 Cleaning up...');
  await bootstrap.services.browser.closeBrowser(bootstrap.session.browser);
  closeReadline();
}

/**
 * Create early exit result for bootstrap failures.
 */
function createBootstrapErrorResult(
  error: any,
  startTime: number,
  config: ResolvedConfig,
): AgentResult {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  return {
    success: false,
    message: `Bootstrap failed: ${errorMessage}`,
    history: [],
    plan: {
      goalSummary: 'Bootstrap failed',
      cycleDescription: 'N/A',
      cycles: [],
      startedAt: createTimestamp(),
      lastUpdatedAt: createTimestamp(),
    },
    cyclesCompleted: 0,
    duration: Date.now() - startTime,
    finalUrl: config.startUrl || '',
  };
}

/**
 * Create early exit result for plan preview quit.
 */
function createEarlyExitResult(
  startTime: number,
  config: ResolvedConfig,
  tracker: SessionTracker,
): AgentResult {
  return {
    success: false,
    message: 'User quit at plan preview',
    history: [],
    plan: tracker,
    cyclesCompleted: 0,
    duration: Date.now() - startTime,
    finalUrl: config.startUrl || '',
  };
}

/**
 * Print startup banner.
 */
function printBanner(config: ResolvedConfig, tracker: SessionTracker): void {
  const goalName = config.goal?.name || 'Custom Goal';
  console.log('\n' + '═'.repeat(60));
  console.log('🤖 MOTE v2 - AI-Powered Browser Agent');
  console.log('═'.repeat(60));
  console.log(`📎 Goal: ${goalName}`);
  console.log(`🌐 Start URL: ${config.startUrl}`);
  console.log(`🎮 Engagement Mode: ${config.engagementMode}`);
  console.log(
    `📊 Max Steps: ${config.maxSteps === -1 ? 'Unlimited' : config.maxSteps}`,
  );
  console.log(`🔄 Cycles: ${tracker.cycles.length}`);
  console.log('═'.repeat(60) + '\n');
}

// -----------------------------------------------------------------------------
// MAIN AGENT FUNCTION
// -----------------------------------------------------------------------------

/**
 * Run the Mote agent with the given configuration.
 * This is the main entry point for programmatic use.
 *
 * Architecture: Bootstrap + Context
 * - Phase 1: Configuration Resolution
 * - Phase 2: Bootstrap (setup services, load artifacts)
 * - Phase 3: Plan Preview Intervention
 * - Phase 4: Runtime Execution (state machine)
 * - Phase 5: Result Assembly
 */
export async function runAgent(
  configInput: ConfigInput = {},
): Promise<AgentResult> {
  const startTime = Date.now();

  // ---------------------------------------------------------------------------
  // Phase 1: Configuration Resolution
  // ---------------------------------------------------------------------------
  const config = await resolveConfig(configInput);
  logVariable('RESOLVED CONFIG', config);

  // ---------------------------------------------------------------------------
  // Phase 2: Bootstrap
  // ---------------------------------------------------------------------------
  let bootstrapResult: BootstrapResult;
  try {
    bootstrapResult = await bootstrap(config);
  } catch (error) {
    return createBootstrapErrorResult(error, startTime, config);
  }

  // Print startup banner
  printBanner(config, bootstrapResult.tracker);

  // ---------------------------------------------------------------------------
  // Phase 3: Plan Preview Intervention
  // ---------------------------------------------------------------------------

  const planPreviewResult = await handlePlanPreview(
    config.engagementMode,
    config.goal,
    bootstrapResult.tracker,
    bootstrapResult.services.llmClient,
  );

  if (planPreviewResult.shouldExit) {
    await cleanup(bootstrapResult);
    return createEarlyExitResult(startTime, config, bootstrapResult.tracker);
  }

  // Update tracker if user modified the plan
  if (planPreviewResult.updatedTracker) {
    bootstrapResult.tracker = planPreviewResult.updatedTracker;
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Runtime Execution
  // ---------------------------------------------------------------------------
  let runtimeResult: RuntimeResult;
  try {
    const runtimeSettings = extractSettings(config);

    runtimeResult = await executeRuntime({
      settings: runtimeSettings,
      services: bootstrapResult.services,
      tracker: bootstrapResult.tracker,
      history: [],
      interventionMetrics: bootstrapResult.interventionMetrics,
      activePage: bootstrapResult.activePage,
      startUrl: bootstrapResult.startUrl,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(`\n💥 Unexpected error: ${errorMessage}`);
    runtimeResult = {
      success: false,
      message: `Unexpected error: ${errorMessage}`,
      tracker: bootstrapResult.tracker,
      history: [],
      finalUrl: bootstrapResult.startUrl,
      hadAdaptations: false,
    };
  } finally {
    // Cleanup
    await cleanup(bootstrapResult);
  }

  // ---------------------------------------------------------------------------
  // Phase 5: Result Assembly
  // ---------------------------------------------------------------------------
  return assembleResult({
    ...runtimeResult,
    startUrl: bootstrapResult.startUrl,
    startTime: bootstrapResult.startTime,
    executionPath: config.executionPath,
    presetDir: config.presetDir,
    customSystemPrompt: config.systemPrompt,
    engagementMode: config.engagementMode,
    goal: config.goal,
  });
}

// -----------------------------------------------------------------------------
// RE-EXPORT extractPathFromHistory
// -----------------------------------------------------------------------------
export { extractPathFromHistory } from './runtime/result.js';
