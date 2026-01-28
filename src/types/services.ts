// =============================================================================
// SERVICE INTERFACES
// =============================================================================
// Interface definitions for dependency injection into AgentContext.
// This enables easier mocking and testing by formalizing service contracts.

import type { Page, Browser, BrowserContext } from 'playwright';
import type { OpenAI } from 'openai';
import type {
  PageState,
  ElementInfo,
  Goal,
  Preset,
  SessionTracker,
  StepResult,
  Action,
  CycleStrategy,
  ThinkResult,
  ResolvedConfig,
  // LLMConfig removed
} from './index.js';
import type { InterventionMetrics, Intervention } from '../prompt.js';
import type { DriftAnalysisResult } from '../reason.js';

// =============================================================================
// BROWSER SERVICE
// =============================================================================

/**
 * Browser session returned from launchBrowser.
 */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Browser service interface.
 * Handles browser automation operations using Playwright.
 */
export interface BrowserService {
  /**
   * Launch a Playwright browser with given configuration.
   * @param config - Browser launch configuration
   * @returns Session containing browser, context, and initial page
   */
  launchBrowser(
    config: Pick<
      ResolvedConfig,
      | 'headless'
      | 'slowMo'
      | 'profilePath'
      | 'stealth'
      | 'timeoutDefault'
      | 'timeoutNavigation'
      | 'timeoutElement'
      | 'postNavDelay'
    >,
  ): Promise<BrowserSession>;

  /**
   * Navigate to a URL with normalization and retry logic.
   * @param page - Playwright page instance
   * @param url - URL to navigate to
   */
  navigateTo(page: Page, url: string): Promise<void>;

  /**
   * Get current page content (URL, title, HTML).
   * @param page - Playwright page instance
   * @returns Object with url, title, and html properties
   */
  getPageContent(
    page: Page,
  ): Promise<{ url: string; title: string; html: string }>;

  /**
   * Close the browser instance.
   * @param browser - Playwright browser to close
   */
  closeBrowser(browser: Browser): Promise<void>;

  /**
   * Take a screenshot of the current page.
   * @param page - Playwright page instance
   * @param path - File path to save screenshot
   */
  takeScreenshot(page: Page, path: string): Promise<void>;
}

// =============================================================================
// OBSERVE SERVICE
// =============================================================================

/**
 * Observe service interface.
 * Handles page observation and interactive element extraction.
 */
export interface ObserveService {
  /**
   * Observe the current page state and extract interactive elements.
   * Supports both full observation and targeted observation (when following an execution path).
   *
   * @param page - Playwright page instance
   * @param targetSelectors - Optional array of CSS selectors to prioritize (Execute mode)
   * @returns Complete page state with elements, markdown, etc.
   */
  observe(page: Page, targetSelectors?: string[]): Promise<PageState>;

  /**
   * Extract interactive elements from the page.
   * @param page - Playwright page instance
   * @param targetSelectors - Optional selectors to prioritize
   * @returns Array of interactive elements with metadata
   */
  extractInteractiveElements(
    page: Page,
    targetSelectors?: string[],
  ): Promise<ElementInfo[]>;
}

// =============================================================================
// REASON SERVICE
// =============================================================================

// DriftAnalysisResult is imported from reason.ts (single source of truth via Zod schema)
export type { DriftAnalysisResult };

/**
 * Validation result for session plans.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Reason service interface.
 * Handles LLM-based decision making, planning, and drift analysis.
 */
export interface ReasonService {
  /**
   * Create an OpenAI-compatible LLM client.
   * @param llmConfig - Optional LLM configuration (baseUrl, apiKey)
   * @returns OpenAI client instance
   */
  createLLMClient(
    llmConfig?: Pick<ResolvedConfig, 'llmBaseUrl' | 'llmApiKey' | 'llmModel'>,
  ): OpenAI;

  /**
   * Get the default LLM model name from environment or default.
   * @returns Model name string
   */
  getDefaultModel(): string;

  /**
   * Evaluate if drift has occurred between expected and actual page state.
   * Used during path execution to determine if we can proceed or need to terminate.
   *
   * @param expectedState - Expected page state from preset/cache
   * @param currentState - Actual current page state
   * @param plannedAction - Action we plan to execute
   * @param client - OpenAI client
   * @returns Drift analysis result with status and optional corrections
   */
  evaluateDrift(
    expectedState: PageState,
    currentState: PageState,
    plannedAction: Action,
    client: OpenAI,
  ): Promise<DriftAnalysisResult>;

  /**
   * Main reasoning function - decide what action to take next.
   * Analyzes current page state and history to determine next step.
   *
   * @param pageState - Current page state
   * @param goal - Optional goal definition
   * @param preset - Optional preset with execution path
   * @param tracker - Session tracker with plan and progress
   * @param history - History of executed steps
   * @param client - OpenAI client
   * @param metrics - Intervention metrics for decision-making
   * @param intervention - Optional user intervention context
   * @returns Think result indicating next action or terminal state
   */
  think(
    pageState: PageState,
    goal: Goal | undefined,
    preset: Preset | undefined,
    tracker: SessionTracker,
    history: StepResult[],
    client: OpenAI,
    metrics: InterventionMetrics,
    intervention?: Intervention,
    customSystemPrompt?: string,
  ): Promise<ThinkResult>;

  /**
   * Ask the LLM a question and get a text response.
   * General-purpose LLM query function.
   *
   * @param prompt - User prompt to send
   * @param client - OpenAI client
   * @param systemMessage - Optional system message
   * @returns LLM response text
   */
  askLLM(
    prompt: string,
    client: OpenAI,
    systemMessage?: string,
  ): Promise<string>;

  /**
   * Generate a session plan (SessionTracker) from a goal.
   * Creates the hierarchical cycle/step structure for execution.
   *
   * @param goal - Goal to plan for
   * @param client - OpenAI client
   * @param currentPlan - Optional current plan (for replanning)
   * @param instruction - Optional instruction for plan modification
   * @returns Generated session tracker with cycles
   */
  generatePlan(
    goal: Goal,
    client: OpenAI,
    currentPlan?: SessionTracker,
    instruction?: string,
  ): Promise<SessionTracker>;

  /**
   * Validate a session plan structure.
   * Checks if SessionTracker has valid format and required fields.
   *
   * @param tracker - Session tracker to validate
   * @returns Validation result with errors if invalid
   */
  validateSessionPlan(tracker: SessionTracker): ValidationResult;

  /**
   * Generate a strategy from first cycle history.
   * Extracts repeating pattern for compressing prompts in subsequent cycles.
   *
   * @param history - Step history from first cycle
   * @param client - OpenAI client
   * @returns Cycle strategy or undefined if extraction fails
   */
  generateStrategy(
    history: StepResult[],
    client: OpenAI,
  ): Promise<CycleStrategy | undefined>;
}

// =============================================================================
// AGENT SERVICES CONTAINER
// =============================================================================

/**
 * Service container for dependency injection into AgentContext.
 * All services are injected once at agent initialization.
 */
export interface AgentServices {
  /** Observe service for page observation and element extraction */
  observe: ObserveService;

  /** Reason service for LLM-based decision making and planning */
  reason: ReasonService;

  /** Browser service for Playwright automation */
  browser: BrowserService;

  /** OpenAI client for LLM API calls */
  llmClient: OpenAI;
}
