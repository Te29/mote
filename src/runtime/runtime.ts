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
  CyclePlan,
  SessionPlan,
  SessionTracker,
  StepResult,
  AgentState,
  AgentContext,
  EngagementMode,
  DriftRecord,
} from '../types/index.js';
import { validateTransition, getCurrentCycleIndex, getCurrentSection } from '../types/index.js';
import type { InterventionMetrics } from '../prompt.js';
import type { AgentServices } from '../types/services.js';
import {
  promptForUrlError,
  startInterruptListener,
  stopInterruptListener,
} from '../interaction.js';
import {
  handleSetup,
  handleWrapup,
  handleCycleStart,
  handleCycleEnd,
  handleObserve,
  handleReason,
  handleAct,
} from '../handlers/index.js';

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
  cyclePlan?: CyclePlan;
  sessionPlan?: SessionPlan;
  customSystemPrompt?: string;
  engagementMode: EngagementMode;
  verbose: boolean;
  maxSteps: number;
  stepPause: number;
  tokenMarkdown: number;
  tokenElements: number;
  tokenMaxElements: number;
  tokenHistory: number;
  startUrl?: string;
  enableCheckpointing: boolean;
  checkpointFrequency: number;
}

/**
 * Restored runtime state from checkpoint (for mid-loop resumption).
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
  /** Drift records from the current cycle (for mid-cycle resumption) */
  currentCycleDrifts?: DriftRecord[];
  /**
   * Whether to resume mid-cycle at OBSERVE instead of CYCLE_START.
   * Only OBSERVE is supported for mid-cycle resumption since REASON/ACT
   * require pageState/action that would be stale after checkpoint restore.
   */
  resumeAtObserve?: boolean;
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

  /** Restored runtime state from checkpoint (optional) */
  restoredRuntimeState?: RestoredRuntimeState;
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
    // Use restored state from checkpoint if available, otherwise initialize fresh
    runtime: {
      activePage: activePageRef,
      lastObservedUrl: null, // Initialize as null
      lastPageState: null,   // Initialize as null
      hadAdaptations: false,
      executionPointer: config.restoredRuntimeState?.executionPointer ?? [0],
      loopStates: config.restoredRuntimeState?.loopStates ?? {},
      currentCycleDrifts: config.restoredRuntimeState?.currentCycleDrifts ?? [],
    },
  };

  // Log if resuming with restored state
  if (config.restoredRuntimeState) {
    console.log(`📍 Resumed runtime state: pointer=${JSON.stringify(ctx.runtime.executionPointer)}, loops=${Object.keys(ctx.runtime.loopStates).length}`);
  }

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
  // Determine initial state based on tracker progress (for resumption support)
  const currentSection = getCurrentSection(tracker);

  let currentState: AgentState;

  if (currentSection === 'setup') {
    currentState = { phase: 'SETUP' };
  } else if (currentSection === 'cycles') {
    // Resume from current cycle (for checkpoint resumption)
    const cycleIndex = getCurrentCycleIndex(tracker);

    // If checkpoint was mid-cycle, resume at OBSERVE to get fresh page state
    // (REASON/ACT require stale pageState/action, so we always re-observe)
    if (config.restoredRuntimeState?.resumeAtObserve) {
      currentState = { phase: 'OBSERVE', cycleIndex };
    } else {
      currentState = { phase: 'CYCLE_START', cycleIndex };
    }
  } else if (currentSection === 'wrapup') {
    currentState = { phase: 'WRAPUP' };
  } else if (currentSection === 'complete') {
    // Session already complete (shouldn't normally happen)
    return {
      success: true,
      message: 'Session already complete',
      tracker,
      history,
      finalUrl: activePage.url(),
      hadAdaptations: false,
    };
  } else {
    // Fallback to CYCLE_START at cycle 0
    currentState = { phase: 'CYCLE_START', cycleIndex: 0 };
  }

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
        case 'SETUP':
          currentState = await handleSetup(currentState, ctx);
          break;

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

        case 'WRAPUP':
          currentState = await handleWrapup(currentState, ctx);
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
