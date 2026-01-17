// =============================================================================
// MOTE TYPE DEFINITIONS
// =============================================================================
//
// This file defines the "shape" of data that flows through Mote.
//
// =============================================================================

// -----------------------------------------------------------------------------
// ACTION TYPES
// -----------------------------------------------------------------------------
// These are the primitive operations the agent can perform.
// Keep this list small! More actions = more complexity for the AI.

/**
 * The actions an agent can take on a web page.
 *
 * - click: Click on an element (button, link, etc.)
 * - type: Enter text into an input field
 * - scroll: Scroll the page up, down, or to an element
 * - navigate: Go to a new URL
 * - wait: Pause for something to load
 * - done: Task completed successfully
 * - fail: Task cannot be completed
 */
export type ActionType =
  | 'click'
  | 'type'
  | 'scroll'
  | 'navigate'
  | 'wait'
  | 'done'
  | 'fail';

// -----------------------------------------------------------------------------
// ACTION INTERFACE
// -----------------------------------------------------------------------------
// This is what the AI returns when it decides what to do.

/**
 * A decision made by the AI agent.
 *
 * @example
 * // Click on a search button
 * { type: 'click', selector: '[name="btnK"]', reason: 'Submit the search query' }
 *
 * @example
 * // Type into a search box
 * { type: 'type', selector: 'input[name="q"]', text: 'weather today', reason: 'Enter search query' }
 *
 * @example
 * // Task is complete
 * { type: 'done', reason: 'Found the weather information: 72°F and sunny' }
 */
export interface Action {
  /** What kind of action to perform */
  type: ActionType;

  /** CSS selector to target (for click, type actions) */
  selector?: string;

  /** Text to type, URL to navigate to, or scroll direction */
  text?: string;

  /** The AI's explanation for why it chose this action */
  reason: string;
}

// -----------------------------------------------------------------------------
// PAGE STATE
// -----------------------------------------------------------------------------
// This is what the agent "sees" - a simplified view of the web page.

/**
 * A snapshot of what's on the current page.
 * This is sent to the AI so it can understand the page.
 *
 * Why Markdown instead of HTML?
 * - HTML has lots of noise (styles, scripts, nested divs)
 * - Markdown is 3-5x smaller = fewer tokens = cheaper/faster
 * - Markdown is easier for AI to read and understand
 */
export interface PageState {
  /** Current page URL */
  url: string;

  /** Page title (from <title> tag) */
  title: string;

  /** Main content converted to Markdown */
  markdown: string;

  /** List of interactive elements (buttons, links, inputs) */
  elements: ElementInfo[];
}

// -----------------------------------------------------------------------------
// ELEMENT INFO
// -----------------------------------------------------------------------------
// Information about an interactive element on the page.

/**
 * An interactive element that the agent can interact with.
 *
 * We assign each element an index number so the AI can reference them:
 * "[1] Button: Sign In"
 * "[2] Link: Create Account"
 * "[3] Input: Search..."
 *
 * Then the AI can say "Click element [1]" and we know what it means.
 */
export interface ElementInfo {
  /** Reference number for this element (1, 2, 3, ...) */
  index: number;

  /** HTML tag name (button, a, input, select, etc.) */
  tag: string;

  /** Visible text content or placeholder */
  text: string;

  /** CSS selector to find this element */
  selector: string;

  /**
   * Element type for inputs (text, password, email, etc.)
   * Helps AI know what kind of data to enter
   */
  inputType?: string;

  /** Key HTML attributes (href, name, aria-label, etc.) */
  attributes: Record<string, string>;
}

// -----------------------------------------------------------------------------
// GOAL CONFIGURATION
// -----------------------------------------------------------------------------
// A Goal defines WHAT the agent should accomplish.
// Same agent loop + different goals = different behaviors

/**
 * Configuration for a task the agent should complete.
 *
 * Goals are the key to reusability:
 * - webSearch goal: Find information on Google
 * - formFill goal: Fill out a form
 * - dataExtract goal: Scrape data from a page
 *
 * Same code, different prompts!
 */
export interface Goal {
  /** Human-readable name for this goal */
  name: string;

  /** What this goal accomplishes */
  description: string;

  /**
   * Instructions for the AI.
   * This is the most important part - it shapes agent behavior.
   */
  systemPrompt: string;

  /** Maximum steps before giving up (safety limit) */
  maxSteps: number;

  /** How to know when the task is done (optional) */
  successCriteria?: string;

  /** Initial input data for the task (e.g., search query) */
  input?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// MOTE CONFIGURATION
// -----------------------------------------------------------------------------
// Top-level configuration for running the agent.
/**
 * Configuration for a Mote agent run.
 */
export interface MoteConfig {
  /** What the agent should accomplish */
  goal: Goal;

  /** Where to start (URL) */
  startUrl: string;

  /** Run browser without visible window? */
  headless?: boolean;

  /** Slow down actions by this many ms */
  slowMo?: number;

  /** Human-in-the-loop settings */
  humanControl?: HumanControlConfig;
}

// -----------------------------------------------------------------------------
// HUMAN-IN-THE-LOOP CONFIGURATION
// -----------------------------------------------------------------------------
// Settings for how much human oversight the agent requires.

/**
 * Confirmation modes for human oversight.
 *
 * - 'all': Confirm every action (maximum control, slow)
 * - 'destructive': Only confirm clicks and form submissions (balanced)
 * - 'none': Fully autonomous (fast, use with caution!)
 */
export type ConfirmMode = 'all' | 'destructive' | 'none';

/**
 * Human-in-the-loop configuration.
 *
 * Finding the right balance:
 * - Too much control: Tedious, defeats the purpose of automation
 * - Too little control: Agent might do unexpected things
 *
 * Start with 'destructive' mode and adjust based on trust!
 */
export interface HumanControlConfig {
  /** Which actions require confirmation */
  confirmMode: ConfirmMode;

  /** Pause between steps (ms) for observation */
  stepPause: number;

  /** Show detailed logs */
  verbose: boolean;
}

// -----------------------------------------------------------------------------
// STEP RESULT
// -----------------------------------------------------------------------------
// What happened after executing an action.

/**
 * Result of executing a single step.
 * Used for history tracking and debugging.
 */
export interface StepResult {
  /** Step number (1, 2, 3, ...) */
  step: number;

  /** What the agent decided to do */
  action: Action;

  /** Did it work? */
  success: boolean;

  /** Error message if it failed */
  error?: string;

  /** Page state after the action */
  pageStateAfter?: PageState;

  /** Timestamp */
  timestamp: Date;
}

// -----------------------------------------------------------------------------
// AGENT RESULT
// -----------------------------------------------------------------------------
// Final result after the agent finishes.

/**
 * Final result of an agent run.
 */
export interface AgentResult {
  /** Did the agent accomplish its goal? */
  success: boolean;

  /** Final message from the agent */
  message: string;

  /** Complete history of all steps */
  history: StepResult[];

  /** Total time taken (ms) */
  duration: number;

  /** Final page URL */
  finalUrl: string;
}

// -----------------------------------------------------------------------------
// LLM CONFIGURATION
// -----------------------------------------------------------------------------
// Settings for the AI model.

/**
 * LLM (Large Language Model) configuration.
 * Uses the OpenAI SDK interface, but works with any compatible API.
 */
export interface LLMConfig {
  /** Base URL of the API (e.g., http://localhost:11434/v1 for Ollama) */
  baseUrl: string;

  /** API key (use "ollama" for local Ollama) */
  apiKey: string;

  /** Model name (e.g., "llama3.2", "gpt-4o-mini") */
  model: string;
}

// -----------------------------------------------------------------------------
// BROWSER CONFIGURATION
// -----------------------------------------------------------------------------
/**
 * Browser launch configuration.
 */
export interface BrowserConfig {
  /** Run without visible window? */
  headless: boolean;

  /** Slow down actions by this many ms */
  slowMo: number;

  /** Timeout settings (ms) */
  timeout: {
    /** Playwright's default for unspecified operations */
    default: number;
    /** page.goto() */
    navigation: number;
    /** waitForSelector(), click(), type() */
    element: number;
    /** Pause after navigation for JS to render */
    postNavDelay: number;
  };
}
