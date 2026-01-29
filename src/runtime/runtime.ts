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
  ExecutionPath,
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
  executionPath?: ExecutionPath;
  customSystemPrompt?: string;
  engagementMode: EngagementMode;
  verbose: boolean;
  maxSteps: number;
  stepPause: number;
  tokenMarkdown: number;
  tokenElements: number;
  tokenMaxElements: number;
  tokenHistory: number;
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
// MAIN EXECUTION LOOP
// -----------------------------------------------------------------------------

/**
 * Execute the agent state machine.
 * Loops through states (Observing -> Reasoning -> Acting) until terminal state.
 */
export async function executeRuntime(
  config: RuntimeConfig,
): Promise<RuntimeResult> {
  const {
    settings,
    services,
    tracker,
    history,
    interventionMetrics,
    activePage,
  } = config;
  
  let { startUrl } = config;

  // Initial Context
  // Create references to mutable state that will be shared across handlers
  const activePageRef = activePage;
  const hadAdaptations = false;

  // Create Context Object
  const ctx: AgentContext = {
    // Settings (Immutable)
    ...settings,

    // Services (Immutable)
    services,

    // Tracking State (Mutable)
    tracker,
    history,
    interventionMetrics,

    // Runtime state (mutable)
    runtime: {
      activePage: activePageRef,
      lastObservedUrl: null, // Initialize as null
      lastPageState: null,   // Initialize as null
      hadAdaptations,
      executionPointer: [0], // Start at top-level unit 0
      loopStates: {},
    },
  };

  // Initial State: NAVIGATION
  // (Navigation is implicit in Phase 2 Bootstrap, but we verify here)
  if (activePage.url() === 'about:blank') {
    let navSuccess = false;
    while (!navSuccess) {
      try {
        if (settings.verbose) console.log(`\nNavigating to: ${startUrl}`);
        await services.browser.navigateTo(activePage, startUrl);
        navSuccess = true;
      } catch (error) {
        if (settings.verbose) console.error('Initial navigation failed:', error);
        
        const result = await promptForUrlError(error instanceof Error ? error.message : String(error));
        
        if (result.type === 'quit') {
          return {
            success: false,
            message: `Initial navigation failed: ${error}`,
            finalUrl: 'about:blank',
            tracker,
            history,
            hadAdaptations: false,
          };
        }
        
        if (result.type === 'new_url' || result.type === 'search') {
           startUrl = result.url || startUrl; 
        }
        // If 'retry', loop continues with same startUrl
      }
    }
  }

  // Start State Machine
  // Initial state is CYCLE_START (Cycle 0)
  let currentState: AgentState = {
    phase: 'CYCLE_START',
    cycleIndex: 0,
  };

  // Setup Interrupt Listener
  startInterruptListener();

  // ---------------------------------------------------------------------------
  // STATE MACHINE LOOP
  // ---------------------------------------------------------------------------
  while (true) {
    const previousState = currentState;
    
    // Log State Transition (Verbose)
    // if (settings.verbose) console.log(`[State] ${previousState.phase}`);

    // Execute Handler based on current phase
    try {
      switch (currentState.phase) {
        case 'CYCLE_START':
          currentState = await handleCycleStart(currentState, ctx);
          break;

        case 'OBSERVE':
          currentState = await handleObserve(currentState, ctx);
          break;

        case 'REASON':
          currentState = await handleReason(currentState, ctx);
          break;

        case 'ACT':
          currentState = await handleAct(currentState, ctx);
          break;

        case 'CYCLE_END':
          currentState = await handleCycleEnd(currentState, ctx);
          break;

        case 'TERMINATED':
          // Exit loop
          stopInterruptListener();
          return {
            success: currentState.success,
            message: currentState.message,
            finalUrl: ctx.runtime.activePage.url(),
            tracker: ctx.tracker,
            history: ctx.history,
            hadAdaptations: ctx.runtime.hadAdaptations,
          };
        
        default:
          throw new Error(`Unknown state phase: ${(currentState as any).phase}`);
      }

      // Validate Transition
      validateTransition(previousState.phase, currentState.phase);

      // Update Cycle Index logic is handled within handlers (e.g., ACT -> OBSERVE increments cycle)
      // Verify consistency?
      const expectedCycle = getCurrentCycleIndex(ctx.tracker);
      if (currentState.phase !== 'TERMINATED' && currentState.cycleIndex !== expectedCycle) {
        // Warn or correct? Handlers should manage this.
        // reason.ts handles replanning which might reset cycles, so strict check might be flaky.
      }

    } catch (error) {
      // Global Error Handler for Runtime Loop
      console.error('\n💥 Runtime Loop Error:', error);
      stopInterruptListener();
      return {
        success: false,
        message: `Runtime error: ${error instanceof Error ? error.message : String(error)}`,
        finalUrl: ctx.runtime.activePage.url(),
        tracker: ctx.tracker,
        history: ctx.history,
        hadAdaptations: ctx.runtime.hadAdaptations,
      };
    }
  }
}
