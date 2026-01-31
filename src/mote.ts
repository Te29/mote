// =============================================================================
// MOTE - Main Entry Point
// =============================================================================

import { config } from 'dotenv';
import type { AgentResult, SessionTracker } from './types/index.js';
import { createTimestamp } from './types/index.js';
import {
  resolveConfig,
  type UserInput,
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
function extractSettings(
  config: ResolvedConfig,
  presetMetadata?: { name: string; dir: string }
): RuntimeSettings {
  return {
    goal: config.goal,
    cyclePlan: config.sessionPlan?.cyclePlan,
    sessionPlan: config.sessionPlan,
    customSystemPrompt: config.systemPrompt,
    presetDir: presetMetadata?.dir,
    engagementMode: config.engagementMode,
    verbose: config.verbose,
    maxSteps: config.maxSteps,
    stepPause: config.stepPause,
    tokenMarkdown: config.tokenMarkdown,
    tokenElements: config.tokenElements,
    tokenMaxElements: config.tokenMaxElements,
    tokenHistory: config.tokenHistory,
    startUrl: config.startUrl,
    enableCheckpointing: config.enableCheckpointing,
    checkpointFrequency: config.checkpointFrequency,
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
    sessionTracker: {
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
    sessionTracker: tracker,
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
  console.log('🤖 MOTE - AI-Powered Browser Agent');
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
  userInput: UserInput = {},
): Promise<AgentResult> {
  const startTime = Date.now();

  // ---------------------------------------------------------------------------
  // Phase 1: Configuration Resolution
  // ---------------------------------------------------------------------------
  const { config, presetMetadata } = await resolveConfig(userInput);
  logVariable('RESOLVED CONFIG', config);

  // ---------------------------------------------------------------------------
  // Phase 2: Bootstrap
  // ---------------------------------------------------------------------------
  let bootstrapResult: BootstrapResult;
  try {
    bootstrapResult = await bootstrap(config, presetMetadata);
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
    const runtimeSettings = extractSettings(config, presetMetadata);

    runtimeResult = await executeRuntime({
      settings: runtimeSettings,
      services: bootstrapResult.services,
      tracker: bootstrapResult.tracker,
      history: bootstrapResult.history ?? [],
      interventionMetrics: bootstrapResult.interventionMetrics,
      activePage: bootstrapResult.activePage,
      startUrl: bootstrapResult.startUrl,
      restoredRuntimeState: bootstrapResult.restoredRuntimeState,
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
    customSystemPrompt: config.systemPrompt,
    engagementMode: config.engagementMode,
    goal: config.goal,
  });
}

// -----------------------------------------------------------------------------
// RE-EXPORT extractPathFromHistory
// -----------------------------------------------------------------------------
export { extractPathFromHistory } from './runtime/result.js';

// -----------------------------------------------------------------------------
// CLI EXECUTION
// -----------------------------------------------------------------------------

/**
 * Check if the current file is the main entry point.
 * Equivalent to `if (require.main === module)` in CommonJS.
 */
import { pathToFileURL } from 'url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgent().then((result) => {
    if (!result.success) {
      process.exit(1);
    }
  });
}
