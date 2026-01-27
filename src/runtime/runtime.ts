// =============================================================================
// RUNTIME MODULE
// =============================================================================
//
// Phase 4: Runtime Execution - Pure state machine loop
//
// Executes the agent state machine with initialized context.
// No setup or cleanup - just pure execution logic.
//
// =============================================================================

import type { Page } from 'playwright';
import type {
  Goal,
  Preset,
  ExecutionStep,
  SessionTracker,
  StepResult,
  AgentState,
  AgentContext,
  EngagementMode,
  PageState,
} from '../types/index.js';
import { validateTransition, getCurrentCycleIndex } from '../types/index.js';
import type { InterventionMetrics } from '../prompt.js';
import type { AgentServices } from '../types/services.js';
import {
  promptForUrlError,
  startInterruptListener,
  stopInterruptListener,
} from '../interaction.js';
import {
  handleCycleStart,
  handleCycleEnd,
  handleObserve,
  handleReason,
  handleAct,
} from '../handlers/index.js';
import { logVariable } from '../utils/debug.js';

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/**
 * Immutable settings for runtime execution.
 */
export interface RuntimeSettings {
  goal?: Goal;
  preset?: Preset;
  presetDir?: string;
  executionPath?: ExecutionStep[];
  customSystemPrompt?: string;
  engagementMode: EngagementMode;
  verbose: boolean;
  maxSteps: number;
  stepPause: number;
}

/**
 * Configuration for runtime execution.
 */
export interface RuntimeConfig {
  /** Immutable settings */
  settings: RuntimeSettings;

  /** Service container */
  services: AgentServices;

  /** Mutable session tracker */
  tracker: SessionTracker;

  /** Mutable step history */
  history: StepResult[];

  /** Mutable intervention metrics */
  interventionMetrics: InterventionMetrics;

  /** Active page */
  activePage: Page;

  /** Start URL for initial navigation */
  startUrl: string;
}

/**
 * Result of runtime execution.
 */
export interface RuntimeResult {
  success: boolean;
  message: string;
  finalUrl: string;
  tracker: SessionTracker;
  history: StepResult[];
  hadAdaptations: boolean;
}

// -----------------------------------------------------------------------------
// RUNTIME EXECUTION FUNCTION
// -----------------------------------------------------------------------------

/**
 * Execute the agent state machine loop.
 * Pure execution - no setup or cleanup.
 *
 * @param config - Runtime configuration with services and initial state
 * @returns Runtime result with success status and updated state
 */
export async function executeRuntime(
  config: RuntimeConfig
): Promise<RuntimeResult> {
  const {
    settings,
    services,
    tracker,
    history,
    interventionMetrics,
    activePage,
    startUrl,
  } = config;

  // Mutable navigation URL (can change during retry loop)
  let currentUrl = startUrl;

  // Mutable state
  let success = false;
  let message = 'Agent stopped unexpectedly';
  let finalUrl = startUrl;
  let activePageRef = activePage;
  let lastObservedUrl = '';
  let lastPageState: PageState | null = null;
  let hadAdaptations = false;

  try {
    // -------------------------------------------------------------------------
    // Initial Navigation with Retry Loop
    // -------------------------------------------------------------------------
    let navSuccess = false;

    while (!navSuccess) {
      try {
        await services.browser.navigateTo(activePageRef, currentUrl);
        navSuccess = true;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const response = await promptForUrlError(errorMsg);

        switch (response.type) {
          case 'quit':
            return {
              success: false,
              message: 'User quit after navigation error',
              tracker,
              history,
              finalUrl: currentUrl,
              hadAdaptations,
            };
          case 'new_url':
          case 'search':
            if (response.url) {
              currentUrl = response.url;
            }
            break;
          case 'retry':
            // Continue loop with same URL
            break;
        }
        console.log('🔄 Retrying navigation...');
      }
    }

    // -------------------------------------------------------------------------
    // Start interrupt listener
    // -------------------------------------------------------------------------
    startInterruptListener();

    // =========================================================================
    // STATE MACHINE LOOP
    // =========================================================================

    // Initialize state to first cycle
    let state: AgentState = {
      phase: 'CYCLE_START',
      cycleIndex: getCurrentCycleIndex(tracker),
    };

    // Ensure we have a valid starting cycle
    if (state.cycleIndex < 0) {
      state = {
        phase: 'TERMINATED',
        success: false,
        message: 'No cycles to execute',
      };
    }

    // Agent context for handlers
    const ctx: AgentContext = {
      // Immutable settings
      ...settings,

      // Core tracking (mutable)
      tracker,
      history,
      interventionMetrics,

      // Services (immutable references)
      services,

      // Runtime state (mutable)
      runtime: {
        activePage: activePageRef,
        lastObservedUrl,
        lastPageState,
        hadAdaptations,
        currentExecutionStepIndex: 0,
      },
    };

    // Main state machine loop
    while (state.phase !== 'TERMINATED') {
      const oldPhase = state.phase;

      // Route to appropriate handler based on current state
      switch (state.phase) {
        case 'CYCLE_START':
          state = await handleCycleStart(state, ctx);
          break;

        case 'OBSERVE':
          state = await handleObserve(state, ctx);
          break;

        case 'REASON':
          state = await handleReason(state, ctx);
          break;

        case 'ACT':
          state = await handleAct(state, ctx);
          break;

        case 'CYCLE_END':
          state = await handleCycleEnd(state, ctx);
          break;

        default:
          // TypeScript exhaustiveness check
          const _: never = state;
          state = {
            phase: 'TERMINATED',
            success: false,
            message: `Unknown state phase: ${JSON.stringify(state)}`,
          };
          break;
      }

      // Runtime validation: catch invalid state transitions early
      validateTransition(oldPhase, state.phase);

      // Log state transitions for debugging
      if (settings.verbose && state.phase !== 'TERMINATED') {
        logVariable('STATE TRANSITION', {
          phase: state.phase,
          cycleIndex: 'cycleIndex' in state ? state.cycleIndex : null,
        });
      }
    }

    // Extract final result from terminal state
    if (state.phase === 'TERMINATED') {
      success = state.success;
      message = state.message;
    }

    // Update final URL and hadAdaptations from context
    finalUrl = ctx.runtime.activePage.url();
    hadAdaptations = ctx.runtime.hadAdaptations;

    // Stop interrupt listener
    stopInterruptListener();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    console.error(`\n💥 Unexpected error: ${errorMessage}`);
    message = `Unexpected error: ${errorMessage}`;
    success = false;

    // Ensure interrupt listener is stopped
    stopInterruptListener();
  }

  return {
    success,
    message,
    finalUrl,
    tracker,
    history,
    hadAdaptations,
  };
}
