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
  EngagementMode,
} from '../types/index.js';
import { createTimestamp } from '../types/index.js';
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
 * Result of bootstrap phase - all services and initial state ready for execution.
 */
export interface BootstrapResult {
  /** Service container with browser, observe, reason, LLM client */
  services: AgentServices;

  /** Session tracker with plan */
  tracker: SessionTracker;

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
}

// -----------------------------------------------------------------------------
// BOOTSTRAP FUNCTION
// -----------------------------------------------------------------------------

/**
 * Bootstrap the agent runtime from resolved configuration.
 * Sets up services, browser, LLM client, and generates initial plan.
 *
 * @param config - Fully resolved configuration
 * @returns Bootstrap result with all services and initial state
 */
export async function bootstrap(
  config: ResolvedConfig
): Promise<BootstrapResult> {
  const startTime = Date.now();

  // ---------------------------------------------------------------------------
  // Create LLM client
  // ---------------------------------------------------------------------------
  const llmClient = reasonProxy.createLLMClient({
    llmBaseUrl: config.llmBaseUrl,
    llmApiKey: config.llmApiKey,
    llmModel: config.llmModel,
  });

  // ---------------------------------------------------------------------------
  // Create or validate session tracker (plan)
  // ---------------------------------------------------------------------------
  let tracker: SessionTracker;
  let planWasRegenerated = false;

  if (config.sessionPlan) {
    // Validate existing plan from config (originally from preset)
    const validation = reasonProxy.validateSessionPlan(config.sessionPlan);
    if (!validation.valid) {
      console.warn(
        '⚠️ SessionTracker validation failed:',
        validation.errors,
      );
      console.log('   Generating new plan from goal...');
      tracker = await reasonProxy.generatePlan(
        config.goal || { name: 'Task', description: 'Complete the task' },
        llmClient,
      );
      planWasRegenerated = true;
    } else {
      // Use valid plan with fresh timestamps
      tracker = {
        ...config.sessionPlan,
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };
    }
  } else if (config.goal) {
    // Generate new plan from goal
    tracker = await reasonProxy.generatePlan(config.goal, llmClient);
  } else {
    // Fallback: create minimal plan
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
    interventionMetrics,
    session,
    activePage: session.page,
    startTime,
    startUrl: config.startUrl!,
    customSystemPrompt: config.systemPrompt,
  };
}