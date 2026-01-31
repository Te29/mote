// =============================================================================
// BOOTSTRAP MODULE
// =============================================================================
//
// Phase 2: Setup the agent runtime environment
// - LLM client creation
// - Session plan generation/validation
// - Browser launch
// - Service container assembly
//
// =============================================================================

import * as fs from 'fs';
import type { Page } from 'playwright';
import type {
  Goal,
  SessionTracker,
  ResolvedConfig,
  StepResult,
} from '../types/index.js';
import { createTimestamp, getProgress } from '../types/index.js';
import type { InterventionMetrics } from '../prompt.js';
import type { AgentServices, BrowserSession } from '../types/services.js';
import { requestIntervention, promptForLogin } from '../interaction.js';
import { logVariable, createTraceProxy } from '../utils/debug.js';
import * as browserModule from '../browser.js';
import * as observeModule from '../observe.js';
import * as reasonModule from '../reason.js';

// Wrap modules for tracing
const browser = createTraceProxy(browserModule, 'Browser');
const observeProxy = createTraceProxy(observeModule, 'Observe');
const reasonProxy = createTraceProxy(reasonModule, 'Reason');

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/**
 * Restored runtime state from checkpoint.
 */
export interface RestoredRuntimeState {
  executionPointer: number[];
  loopStates: Record<
    string,
    {
      iteration: number;
      conditionsMet: string[];
      startedAt: string;
    }
  >;
}

/**
 * Result of bootstrap phase - all services and initial state ready for execution.
 */
export interface BootstrapResult {
  /** Service container with browser, observe, reason, LLM client */
  services: AgentServices;

  /** Session tracker with plan */
  tracker: SessionTracker;

  /** Restored history from checkpoint (if resuming) */
  history?: StepResult[];

  /** Restored runtime state from checkpoint (if resuming) */
  restoredRuntimeState?: RestoredRuntimeState;

  /** Initial intervention metrics */
  interventionMetrics: InterventionMetrics;

  /** Browser session (browser, context, page) */
  session: BrowserSession;

  /** Active page reference */
  activePage: Page;

  /** Bootstrap start time (for duration calculation) */
  startTime: number;

  /** Start URL for navigation */
  startUrl: string;

  /** Custom system prompt loaded from preset or input */
  customSystemPrompt?: string;

  /** Preset metadata for saving back modifications */
  presetMetadata?: {
    name: string;
    dir: string;
  };
}

// -----------------------------------------------------------------------------
// BOOTSTRAP FUNCTION
// -----------------------------------------------------------------------------

/**
 * Bootstrap the agent runtime from resolved configuration.
 * Sets up services, browser, LLM client, and generates initial plan.
 *
 * @param config - Fully resolved configuration
 * @param presetMetadata - Optional preset metadata for saving back modifications
 * @returns Bootstrap result with all services and initial state
 */
export async function bootstrap(
  config: ResolvedConfig,
  presetMetadata?: { name: string; dir: string }
): Promise<BootstrapResult> {
  const startTime = Date.now();

  // ---------------------------------------------------------------------------
  // Create LLM client
  // ---------------------------------------------------------------------------
  const llmClient = reasonProxy.createLLMClient({
    llmBaseUrl: config.llmBaseUrl,
    llmApiKey: config.llmApiKey,
    llmModel: config.llmModel,
    llmTimeout: config.llmTimeout,
  });

  // ---------------------------------------------------------------------------
  // Create session tracker from plan or goal (or checkpoint)
  // ---------------------------------------------------------------------------
  let tracker: SessionTracker;
  let planWasRegenerated = false;

  // Variables for checkpoint restoration
  let restoredHistory: StepResult[] | undefined;
  let restoredRuntimeState: RestoredRuntimeState | undefined;

  // Check for checkpoint resumption
  if (config.resumeCheckpoint) {
    console.log(`📂 Resuming from checkpoint: ${config.resumeCheckpoint}`);

    const { loadCheckpoint } = await import('../utils/checkpoint.js');
    const checkpoint = loadCheckpoint(config.resumeCheckpoint);

    if (!checkpoint) {
      throw new Error(`Failed to load checkpoint: ${config.resumeCheckpoint}`);
    }

    console.log(`   Session: ${checkpoint.sessionId}`);
    console.log(`   Saved: ${checkpoint.timestamp}`);
    console.log(`   Progress: ${getProgress(checkpoint.tracker)}`);

    // Use checkpoint tracker (skip normal tracker creation)
    tracker = checkpoint.tracker;
    planWasRegenerated = false;

    // Restore history from checkpoint
    restoredHistory = checkpoint.history;
    console.log(`   History: ${restoredHistory.length} steps`);

    // Restore runtime state if available (for mid-loop resumption)
    if (checkpoint.runtimeState) {
      restoredRuntimeState = checkpoint.runtimeState;
      console.log(`   Runtime: pointer=${JSON.stringify(restoredRuntimeState.executionPointer)}, loops=${Object.keys(restoredRuntimeState.loopStates).length}`);
    }

    console.log('✓ Checkpoint restored. Continuing bootstrap...');
  } else if (config.sessionPlan) {
    // SessionPlan provided from preset - validate and convert to tracker
    const validation = reasonProxy.validateSessionPlan(config.sessionPlan);

    if (!validation.valid) {
      console.warn('⚠️ SessionPlan validation failed:', validation.errors);
      console.log('   Falling back to goal-based planning...');

      if (config.goal) {
        tracker = await reasonProxy.generatePlan(config.goal, llmClient);
        planWasRegenerated = true;
      } else {
        throw new Error('Invalid SessionPlan and no goal provided');
      }
    } else {
      // Convert SessionPlan → SessionTracker
      tracker = reasonProxy.initializeTrackerFromPlan(config.sessionPlan);
    }
  } else if (config.goal) {
    // No SessionPlan - generate tracker from goal
    tracker = await reasonProxy.generatePlan(config.goal, llmClient);
  } else {
    // Fallback: minimal tracker
    tracker = {
      goalSummary: 'Complete the task',
      cycleDescription: 'Complete one iteration',
      cycles: [{ isCompleted: false, cycleSteps: [] }],
      startedAt: createTimestamp(),
      lastUpdatedAt: createTimestamp(),
    };
  }

  logVariable('SESSION PLAN', tracker);

  // ---------------------------------------------------------------------------
  // Regenerated Plan Review (if validation failed)
  // ---------------------------------------------------------------------------
  if (planWasRegenerated) {
    console.log('\n⚠️  Plan was regenerated due to validation errors.');
    console.log('Please review the new plan below:\n');

    const response = await requestIntervention('PLAN_PREVIEW', { plan: tracker });

    if (response.type === 'modify' && config.goal) {
      console.log('🔄 Regenerating plan based on user instruction...');
      const modifiedGoal: Goal = {
        ...config.goal,
        description: `${config.goal.description}\n\nUser instruction: ${response.instruction}`,
      };
      tracker = await reasonProxy.generatePlan(modifiedGoal, llmClient);
      logVariable('SESSION PLAN (MODIFIED)', tracker);
    }

    if (response.type === 'quit') {
      throw new Error('User quit after reviewing regenerated plan');
    }
  }

  // ---------------------------------------------------------------------------
  // Initialize intervention metrics
  // ---------------------------------------------------------------------------
  const interventionMetrics: InterventionMetrics = {
    consecutiveFailures: 0,
    replanCount: 0,
    reobserveCount: 0,
    llmParseFailures: 0,
  };

  // ---------------------------------------------------------------------------
  // Launch browser
  // ---------------------------------------------------------------------------
  const profileDir = config.profilePath;
  const isNewProfile = profileDir && !fs.existsSync(profileDir);

  logVariable('BROWSER CONFIG', {
    headless: config.headless,
    slowMo: config.slowMo,
    profilePath: config.profilePath,
    stealth: config.stealth,
    timeoutDefault: config.timeoutDefault,
    timeoutNavigation: config.timeoutNavigation,
    timeoutElement: config.timeoutElement,
    postNavDelay: config.postNavDelay,
  });

  const session = await browser.launchBrowser(config);

  // If this is a new profile, prompt user to log in before continuing
  if (isNewProfile) {
    await promptForLogin();
  }

  // ---------------------------------------------------------------------------
  // Assemble service container
  // ---------------------------------------------------------------------------
  const services: AgentServices = {
    observe: observeProxy,
    reason: reasonProxy,
    browser,
    llmClient,
  };

  // ---------------------------------------------------------------------------
  // Return bootstrap result
  // ---------------------------------------------------------------------------
  return {
    services,
    tracker,
    history: restoredHistory,
    restoredRuntimeState,
    interventionMetrics,
    session,
    activePage: session.page,
    startTime,
    startUrl: config.startUrl!,
    customSystemPrompt: config.systemPrompt,
    presetMetadata,
  };
}