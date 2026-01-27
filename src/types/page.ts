// =============================================================================
// PAGE STATE TYPES
// =============================================================================
// Represents what the agent "sees" - a simplified view of the web page

// -----------------------------------------------------------------------------
// PAGE STATE
// -----------------------------------------------------------------------------
// What the agent "sees" - a simplified view of the web page.

/**
 * Information about detected captcha or anti-bot challenge.
 */
export interface CaptchaInfo {
  /** Whether a captcha was detected */
  detected: boolean;
  /** Type of captcha if detected */
  type?: 'recaptcha' | 'hcaptcha' | 'cloudflare' | 'generic' | 'unknown';
  /** Human-readable description */
  message?: string;
}

/**
 * Snapshot of the current page state.
 * Produced by observe.ts, consumed by reason.ts
 */
export interface PageState {
  /** Current page URL */
  url: string;

  /** Page title (from <title> tag) */
  title: string;

  /** Main content converted to Markdown (token-efficient for LLM) */
  markdown: string;

  /** Interactive elements the agent can interact with */
  elements: ElementInfo[];

  /** Captcha/anti-bot detection info (if any detected) */
  captcha?: CaptchaInfo;
}

/**
 * An interactive element on the page.
 *
 * Each element gets an index number for LLM reference:
 * "[1] Button: Sign In"
 * "[2] Input: Search..."
 */
export interface ElementInfo {
  /** Reference number (1, 2, 3, ...) */
  index: number;

  /** HTML tag (button, a, input, etc.) */
  tag: string;

  /** Visible text or placeholder */
  text: string;

  /** CSS selector to find this element */
  selector: string;

  /** Input type for form elements (text, password, email, etc.) */
  inputType?: string;

  /** Key HTML attributes (href, name, aria-label, etc.) */
  attributes: Record<string, string>;

  /** Selector to locate the iframe containing this element (if in iframe) */
  frameSelector?: string;

  /** Available options for select dropdowns (value: label pairs) */
  options?: Array<{ value: string; label: string }>;

  /** Whether the element is disabled */
  disabled?: boolean;

  /** Whether the element is outside the current viewport (may need scrolling) */
  offscreen?: boolean;
}

/**
 * Key contextual information from the page at the time of a step.
 * Used to provide meaningful descriptions for cycles and success states.
 */
export interface PageContext {
  /** Page title (often contains topic/course name) */
  title: string;

  /** Progress indicator if detected (e.g., "Question 3 of 5") */
  progress?: string;

  /** Main topic or subject (extracted from title or content) */
  topic?: string;
}
