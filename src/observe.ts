// =============================================================================
// OBSERVE MODULE
// =============================================================================
//
// This module is the agent's "eyes" - it transforms raw HTML into a format
// the AI can understand efficiently.
//
// TWO PARALLEL PIPELINES:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │                                                                 │
//   │   Raw HTML from page.content()                                  │
//   │         │                                                       │
//   │         ├─────────────────────┬─────────────────────────────┐   │
//   │         │                     │                             │   │
//   │         ▼                     ▼                             │   │
//   │   ┌───────────┐         ┌───────────┐                       │   │
//   │   │  CONTENT  │         │ ELEMENTS  │                       │   │
//   │   │  PIPELINE │         │ PIPELINE  │                       │   │
//   │   └─────┬─────┘         └─────┬─────┘                       │   │
//   │         │                     │                             │   │
//   │         ▼                     ▼                             │   │
//   │   JSDOM (copy)          page.evaluate()                     │   │
//   │         │               (live browser)                      │   │
//   │         ▼                     │                             │   │
//   │   Readability.js              ▼                             │   │
//   │   (extract main)        querySelectorAll()                  │   │
//   │         │               (find interactive)                  │   │
//   │         ▼                     │                             │   │
//   │   Turndown                    ▼                             │   │
//   │   (HTML → MD)           buildSelector()                     │   │
//   │         │               (create CSS selectors)              │   │
//   │         ▼                     │                             │   │
//   │    markdown               elements[]                        │   │
//   │         │                     │                             │   │
//   │         └──────────┬──────────┘                             │   │
//   │                    │                                        │   │
//   │                    ▼                                        │   │
//   │              PageState {                                    │   │
//   │                url, title,                                  │   │
//   │                markdown,    ← for AI to read                │   │
//   │                elements[]   ← for AI to interact            │   │
//   │              }                                              │   │
//   │                                                             │   │
//   └─────────────────────────────────────────────────────────────┘
//
// Why this matters:
// - Raw HTML for google.com is ~500KB
// - After processing, it might be ~5KB
// - That's 100x fewer tokens = faster + cheaper
//
// Why two pipelines?
// - Content pipeline: Optimizes for READING (removes noise, reduces tokens)
// - Element pipeline: Optimizes for INTERACTION (finds all clickable things)
//
// They don't interfere because:
// - JSDOM creates a separate virtual DOM (doesn't touch the real page)
// - page.evaluate() runs in the actual browser
//
// Exported Functions:
// - observe(page): Main function - returns PageState with markdown and elements
// - extractInteractiveElements(page): Find all clickable/interactive elements
// =============================================================================

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { Page } from 'playwright';
import type { PageState, ElementInfo, CaptchaInfo } from './types/index.js';
import { getPageContent } from './browser.js';

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

/** Maximum markdown content length before truncation (~2000 tokens) */
const MAX_MARKDOWN_LENGTH = 8000;

/** Minimum content length to consider Readability extraction successful */
const MIN_READABILITY_CONTENT_LENGTH = 200;

/** URL of the last page we ran the lazy-load sweep on. Skip the sweep if unchanged. */
let lastSweptUrl: string | null = null;

// -----------------------------------------------------------------------------
// TURNDOWN CONFIGURATION
// -----------------------------------------------------------------------------
// Turndown converts HTML to Markdown. We configure it once and reuse it.

const turndown = new TurndownService({
  // How to handle headings
  headingStyle: 'atx', // # Heading (vs underline style)

  // How to handle code blocks
  codeBlockStyle: 'fenced', // ```code``` (vs indented)

  // How to handle links
  linkStyle: 'inlined', // [text](url) (vs referenced)

  // How to handle emphasis
  emDelimiter: '_', // _italic_ (vs *italic*)
  strongDelimiter: '**', // **bold**
});

// Remove elements that add noise without value
// These are configured as "rules" that match elements and remove them
turndown.addRule('removeScripts', {
  filter: ['script', 'style', 'noscript', 'iframe'],
  replacement: () => '',
});

// Keep images but simplify them
turndown.addRule('simplifyImages', {
  filter: 'img',
  replacement: (_content, node) => {
    const img = node as HTMLImageElement;
    const alt = img.alt || 'image';
    return `[Image: ${alt}]`;
  },
});

// -----------------------------------------------------------------------------
// MAIN OBSERVE FUNCTION
// -----------------------------------------------------------------------------

/**
 * Observe the current page - extract content and interactive elements.
 * This is the main function called by the agent loop.
 *
 * @param page - Playwright page object
 * @returns PageState with markdown content and element list
 *
 * @example
 * const state = await observe(page)
 * console.log(state.markdown)  // Clean content
 * console.log(state.elements)  // Clickable elements
 */
export async function observe(
  page: Page,
  targetSelectors?: string[],
): Promise<PageState> {
  // Wait for page to be in a stable state before observing
  // This prevents observing half-loaded pages with missing elements
  try {
    await page.waitForLoadState('load', { timeout: 10000 });
  } catch {
    // Timeout is okay, page might already be loaded
  }

  // Additional wait for dynamic content and scripts to execute
  // Many modern web apps need time for JavaScript to render content
  // Increased to 5000ms for slower dynamic content
  await page.waitForTimeout(5000);

  // Try to wait for network to be idle (indicates AJAX/dynamic content loaded)
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {
    // Timeout is okay, some pages have persistent connections
  }

  // Scroll the page to load lazy-loaded content.
  // Only run once per URL — repeated observations of the same page gain nothing.
  const currentUrl = page.url();
  if (currentUrl !== lastSweptUrl) {
    try {
      const hasScrollSpace = await page.evaluate(() => {
        return document.documentElement.scrollHeight > window.innerHeight;
      });

      if (hasScrollSpace) {
        // Hide during sweep so the user doesn't see the scroll-down-and-back
        await page.evaluate(async () => {
          const scrollStep = 500;
          const scrollDelay = 100;

          document.documentElement.style.opacity = '0';

          const totalHeight = document.documentElement.scrollHeight;
          let currentPosition = 0;

          while (currentPosition < totalHeight) {
            window.scrollBy(0, scrollStep);
            currentPosition += scrollStep;
            await new Promise(resolve => setTimeout(resolve, scrollDelay));
          }

          // Scroll back to top and restore visibility
          window.scrollTo(0, 0);
          document.documentElement.style.opacity = '';
        });

        // Wait for any content that loaded during scrolling
        await page.waitForTimeout(1000);
      }

      lastSweptUrl = currentUrl;
    } catch (error) {
      console.warn('[DEBUG OBSERVE] Scrolling failed (non-fatal):', error);
    }
  }

  // Get page info using browser module
  const { url, title } = await getPageContent(page);

  // Find interactive elements
  // If targetSelectors is provided, we prioritize finding them
  const elements = await extractInteractiveElements(page, targetSelectors);

  console.log(`[DEBUG OBSERVE] Found ${elements.length} interactive elements`);
  if (elements.length === 0) {
    console.warn('[DEBUG OBSERVE] WARNING: No interactive elements found! URL:', url);
    console.warn('[DEBUG OBSERVE] This may indicate the page is still loading or elements are in iframes');
  } else if (elements.length < 5) {
    console.log('[DEBUG OBSERVE] Sample elements:', elements.map(e => ({ tag: e.tag, text: e.text.substring(0, 50) })));
  }

  let markdown = '';
  // Optimization: If targeted observation (targetSelectors provided) and we found them,
  // we can skip the expensive markdown generation.
  // Check primary selectors first, then fall back to alternative selectors.
  const targetsFound = targetSelectors && targetSelectors.every(selector =>
    elements.some(el =>
      el.selector === selector ||
      (el.alternativeSelectors && el.alternativeSelectors.includes(selector))
    )
  );

  if (targetSelectors && targetsFound) {
     // Skip expensive extraction
     markdown = '[Targeted Observation: Markdown generation skipped for performance]';
  } else {
     // Normal Full Observation OR Fallback (targets not found)
     // Extract and convert content using string-based script to avoid esbuild __name issues
     const cleanHtml = await page.evaluate(EXTRACT_CLEAN_HTML_SCRIPT) as string;

    markdown = extractAndConvert(cleanHtml, url);
  }

  // Check for captcha/anti-bot challenges
  const captcha = await detectCaptcha(page);

  const result: PageState = {
    url,
    title,
    markdown,
    elements,
  };

  // Only include captcha field if detected
  if (captcha.detected) {
    result.captcha = captcha;
  }

  return result;
}

// -----------------------------------------------------------------------------
// CAPTCHA DETECTION
// -----------------------------------------------------------------------------

/**
 * Detect common captcha and anti-bot challenges on the page.
 * Returns info about what was detected so the agent can request HITL.
 *
 * Detects:
 * - reCAPTCHA (Google)
 * - hCaptcha
 * - Cloudflare challenges
 * - Generic "verify you're human" patterns
 */
async function detectCaptcha(page: Page): Promise<CaptchaInfo> {
  const detection = await page.evaluate(() => {
    const bodyText = document.body?.innerText?.toLowerCase() || '';

    // Check for reCAPTCHA - only detect if visible challenge is present
    // Look for actual reCAPTCHA iframe or visible challenge widget
    const hasRecaptchaIframe = !!document.querySelector('iframe[src*="recaptcha"]');
    const hasRecaptchaWidget = !!document.querySelector('.g-recaptcha');
    const hasRecaptchaChallenge = !!document.querySelector('[id*="recaptcha"]');

    // Also check if the reCAPTCHA challenge is actually visible
    let hasVisibleRecaptcha = false;
    if (hasRecaptchaIframe || hasRecaptchaWidget || hasRecaptchaChallenge) {
      const element = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [id*="recaptcha"]');
      if (element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        hasVisibleRecaptcha = rect.width > 0 && rect.height > 0 &&
                             style.display !== 'none' &&
                             style.visibility !== 'hidden' &&
                             style.opacity !== '0';
      }
    }

    if (hasVisibleRecaptcha) {
      return { detected: true, type: 'recaptcha' as const };
    }

    // Check for hCaptcha - only detect if visible challenge is present
    const hasHcaptchaIframe = !!document.querySelector('iframe[src*="hcaptcha"]');
    const hasHcaptchaWidget = !!document.querySelector('.h-captcha');

    let hasVisibleHcaptcha = false;
    if (hasHcaptchaIframe || hasHcaptchaWidget) {
      const element = document.querySelector('iframe[src*="hcaptcha"], .h-captcha');
      if (element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        hasVisibleHcaptcha = rect.width > 0 && rect.height > 0 &&
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0';
      }
    }

    if (hasVisibleHcaptcha) {
      return { detected: true, type: 'hcaptcha' as const };
    }

    // Check for Cloudflare challenge - only detect if visible
    const hasCloudflareElement = !!document.querySelector('#cf-wrapper, .cf-browser-verification');
    const hasCloudflareText = bodyText.includes('checking your browser') ||
                              bodyText.includes('ddos protection by cloudflare');

    let hasVisibleCloudflare = false;
    if (hasCloudflareElement) {
      const element = document.querySelector('#cf-wrapper, .cf-browser-verification');
      if (element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        hasVisibleCloudflare = rect.width > 0 && rect.height > 0 &&
                              style.display !== 'none' &&
                              style.visibility !== 'hidden' &&
                              style.opacity !== '0';
      }
    }

    if (hasVisibleCloudflare || hasCloudflareText) {
      return { detected: true, type: 'cloudflare' as const };
    }

    // Check for generic captcha patterns - only in visible body text
    const genericPatterns = [
      'verify you are human',
      "verify you're human",
      'prove you are human',
      "prove you're human",
      'are you a robot',
      'not a robot',
      'human verification',
      'bot detection',
      'security check',
      'captcha',
    ];

    const hasGenericCaptcha = genericPatterns.some(
      (pattern) => bodyText.includes(pattern),
    );

    if (hasGenericCaptcha) {
      return { detected: true, type: 'generic' as const };
    }

    return { detected: false, type: undefined };
  });

  // Build result with human-readable message
  if (detection.detected && detection.type) {
    const messages: Record<string, string> = {
      recaptcha: 'Google reCAPTCHA detected - human intervention required',
      hcaptcha: 'hCaptcha detected - human intervention required',
      cloudflare:
        'Cloudflare challenge detected - waiting or human intervention required',
      generic: 'Captcha or verification challenge detected - human intervention may be required',
    };

    return {
      detected: true,
      type: detection.type,
      message: messages[detection.type],
    };
  }

  return { detected: false };
}

// -----------------------------------------------------------------------------
// EXTRACT AND CONVERT CONTENT
// -----------------------------------------------------------------------------

/**
 * Extract main content from HTML and convert to Markdown.
 *
 * For web automation, we prioritize DIRECT content extraction over Readability.
 * Readability.js is designed for "reader mode" (articles, blogs) but fails on:
 * - Web applications (forms, quizzes, dashboards)
 * - Interactive UI with labels and instructions
 * - Dynamic content rendered by JavaScript
 *
 * Our strategy:
 * 1. PRIMARY: Direct extraction with noise removal (simplifyHtml)
 * 2. OPTIONAL: Use Readability only for article-like pages (lots of paragraphs)
 *
 * @param html - Raw HTML string
 * @param url - Page URL (needed by Readability)
 * @returns Clean Markdown content
 */
function extractAndConvert(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // ---------------------------------------------------------------------------
  // Detect page type: Is this an article or a web app?
  // ---------------------------------------------------------------------------
  const paragraphCount = document.querySelectorAll('p').length;
  const formElementCount = document.querySelectorAll('input, select, textarea, button, [role="checkbox"], [role="radio"]').length;
  const isLikelyArticle = paragraphCount > 5 && formElementCount < 3;

  let cleanHtml: string;

  if (isLikelyArticle) {
    // Article-like page: Try Readability first
    const reader = new Readability(document.cloneNode(true) as Document);
    const article = reader.parse();

    if (article && article.content) {
      const tempMarkdown = turndown.turndown(article.content);
      const textOnly = tempMarkdown.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();

      if (textOnly.length >= MIN_READABILITY_CONTENT_LENGTH) {
        cleanHtml = article.content;
      } else {
        // Readability extracted too little - fall back
        cleanHtml = simplifyHtml(document);
      }
    } else {
      cleanHtml = simplifyHtml(document);
    }
  } else {
    // Web app / interactive page: Use direct extraction (skip Readability)
    // This is the PRIMARY path for automation tasks
    cleanHtml = simplifyHtml(document);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Convert to Markdown
  // ---------------------------------------------------------------------------
  // Turndown converts HTML to Markdown.
  // Markdown is much more token-efficient for LLMs.

  let markdown = turndown.turndown(cleanHtml);

  // Clean up excessive whitespace
  markdown = markdown
    .replace(/\n{3,}/g, '\n\n') // Max 2 newlines in a row
    .replace(/^\s+|\s+$/g, '') // Trim start/end
    .trim();

  // Truncate if too long (LLMs have context limits)
  if (markdown.length > MAX_MARKDOWN_LENGTH) {
    markdown = markdown.substring(0, MAX_MARKDOWN_LENGTH) + '\n\n[Content truncated...]';
  }

  return markdown;
}

// -----------------------------------------------------------------------------
// SIMPLIFY HTML (FALLBACK)
// -----------------------------------------------------------------------------

/**
 * Simplify HTML when Readability fails.
 * Removes obvious noise while keeping structure.
 *
 * @param document - DOM document
 * @returns Simplified HTML string
 */
function simplifyHtml(document: Document): string {
  // Clone to avoid modifying original
  const clone = document.body.cloneNode(true) as HTMLElement;

  // Remove elements that are definitely noise
  const removeSelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'nav',
    'footer',
    'header',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '.ad',
    '.advertisement',
    '.sidebar',
    '.cookie-banner',
    '#cookie-consent',
    '.popup',
    '.modal',
  ];

  for (const selector of removeSelectors) {
    clone.querySelectorAll(selector).forEach((el) => el.remove());
  }

  // Also extract visible text from form-related elements that might not be in innerHTML
  // This helps capture quiz questions and answer labels
  const formContent = extractFormContext(document);
  if (formContent) {
    // Prepend form content as it's likely the main focus
    return `<div class="form-context">${formContent}</div>\n${clone.innerHTML}`;
  }

  return clone.innerHTML;
}

/**
 * Extract text content from form-related elements.
 * This captures quiz questions, labels, and answer options that might be
 * missed by standard HTML extraction (e.g., in aria-labels or custom elements).
 */
function extractFormContext(document: Document): string {
  const parts: string[] = [];

  // Look for question text in common patterns
  const questionSelectors = [
    '[class*="question" i]',
    '[class*="Question"]',
    '[class*="prompt" i]',
    '[role="heading"]',
    'fieldset > legend',
    '[aria-describedby]',
    'main h1, main h2, main h3',
    '[id*="question" i] h1, [id*="question" i] h2, [id*="question" i] h3',
    '[class*="assessment" i] h1, [class*="assessment" i] h2',
  ];

  for (const selector of questionSelectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 10 && text.length < 500) {
          parts.push(`<h2>${text}</h2>`);
        }
      });
    } catch {
      // Selector might be invalid, continue
    }
  }

  // Extract labels for form inputs (especially checkboxes/radios)
  const labels: string[] = [];
  document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach((input) => {
    const inputEl = input as HTMLInputElement;

    // Try multiple ways to get the label text
    let labelText = '';

    // 1. Check aria-label
    labelText = inputEl.getAttribute('aria-label') || '';

    // 2. Check associated label element
    if (!labelText && inputEl.id) {
      const label = document.querySelector(`label[for="${inputEl.id}"]`);
      if (label) {
        labelText = (label as HTMLElement).innerText?.trim() || '';
      }
    }

    // 3. Check parent label
    if (!labelText) {
      const parentLabel = inputEl.closest('label');
      if (parentLabel) {
        labelText = (parentLabel as HTMLElement).innerText?.trim() || '';
      }
    }

    // 4. Check sibling text
    if (!labelText && inputEl.parentElement) {
      const siblings = inputEl.parentElement.childNodes;
      for (const sibling of Array.from(siblings)) {
        if (sibling.nodeType === 3 && sibling.textContent?.trim()) { // Text node
          labelText = sibling.textContent.trim();
          break;
        }
      }
    }

    if (labelText && labelText.length > 3) {
      const inputType = inputEl.type;
      const checked = inputEl.checked ? '☑' : '☐';
      labels.push(`<li>${checked} ${labelText}</li>`);
    }
  });

  if (labels.length > 0) {
    parts.push(`<ul>${labels.join('\n')}</ul>`);
  }

  return parts.join('\n');
}

/**
 * Find all interactive elements on the page.
 * These are elements the agent can click, type into, etc.
 *
 * Assign each element an index number so the AI can reference them:
 *   [1] Button: "Search"
 *   [2] Input: "Enter your query..."
 *   [3] Link: "About Us"
 *
 * @param page - Playwright page object
 * @returns Array of ElementInfo objects
 */
export async function extractInteractiveElements(
  page: Page,
  targetSelectors?: string[],
): Promise<ElementInfo[]> {
  const allElements: ElementInfo[] = [];
  const frames = page.frames();

  // We'll use a sequential index across all frames so the AI has unique IDs
  let currentIndex = 1;

  for (const frame of frames) {
    try {
      // 1. Get the frame selector (if it's not the main frame)
      let frameSelector: string | undefined;
      
      if (frame !== page.mainFrame()) {
        const frameElement = await frame.frameElement();
        
        // Extract attributes to build a selector for this iframe
        const frameAttrs = await frameElement.evaluate((el) => {
          const htmlEl = el as HTMLElement;
          const attributes: Record<string, string> = {};
          const attrNames = ['name', 'id', 'title', 'class', 'src'];
          
          for (const attr of attrNames) {
             const val = htmlEl.getAttribute(attr);
             if (val) attributes[attr] = val;
          }
          return { tag: 'iframe', text: '', attributes };
        });

        // Use our existing builder logic
        frameSelector = buildSelector(frameAttrs);
      }

      // 2. Extract elements from this frame using string-based script to avoid esbuild __name issues
      const rawElements = await frame.evaluate(
        `${EXTRACT_INTERACTIVE_ELEMENTS_SCRIPT}(${JSON.stringify(targetSelectors)})`
      ) as Array<{
        tag: string;
        text: string;
        inputType?: string;
        attributes: Record<string, string>;
        rect: { x: number; y: number; width: number; height: number };
        parentSelector?: string;
        options?: Array<{ value: string; label: string }>;
        disabled?: boolean;
        offscreen?: boolean;
      }>;

      // 3. Process and add to list
      for (const el of rawElements) {
        const fingerprint = buildSelectorFingerprint(el);

        allElements.push({
          index: currentIndex++,
          tag: el.tag,
          text: el.text || `[${el.tag}]`,
          selector: fingerprint.primary,
          alternativeSelectors: fingerprint.alternatives.length > 0 ? fingerprint.alternatives : undefined,
          inputType: el.inputType,
          attributes: el.attributes,
          frameSelector,
          options: el.options,
          disabled: el.disabled,
          offscreen: el.offscreen,
        });
      }

    } catch (error) {
      // Log warning for debugging cross-origin or detached frame issues
      console.warn(`[Observe] Failed to extract elements from frame ${frame.url()}:`, error);
    }
  }

  return allElements;
}

// =============================================================================
// BROWSER-CONTEXT SCRIPTS (as string literals to avoid esbuild transformation)
// =============================================================================
// These scripts run inside the browser via page.evaluate(). They MUST be defined
// as string literals, not TypeScript functions, because esbuild adds __name helper
// calls to function declarations that don't exist in the browser context.

/**
 * Script to extract clean HTML content from the page.
 * Clones the DOM while flattening Shadow DOM for Readability/Turndown processing.
 */
const EXTRACT_CLEAN_HTML_SCRIPT = `(function() {
  // Check if element is effectively visible
  // More lenient than before - allows opacity:0 if element has rect size
  // (common in React apps for accessible but visually hidden inputs)
  function isEffectivelyVisible(elem) {
    var style = window.getComputedStyle(elem);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;

    // Allow opacity:0 if the element has size (accessibility pattern)
    var rect = elem.getBoundingClientRect();
    if (style.opacity === '0' && rect.width === 0 && rect.height === 0) return false;

    return true;
  }

  // Check if element is form/question related (always include these)
  function isFormRelated(elem) {
    var tag = elem.tagName.toLowerCase();
    if (['form', 'fieldset', 'legend', 'label'].includes(tag)) return true;
    if (elem.getAttribute('role') === 'form') return true;
    if (elem.getAttribute('role') === 'group') return true;

    // Handle className - can be string or SVGAnimatedString (for SVG elements)
    var className = '';
    if (typeof elem.className === 'string') {
      className = elem.className.toLowerCase();
    } else if (elem.className && elem.className.baseVal) {
      className = elem.className.baseVal.toLowerCase();
    }
    if (className.includes('question') || className.includes('answer') ||
        className.includes('quiz') || className.includes('assessment') ||
        className.includes('option') || className.includes('choice')) return true;

    var id = (elem.id || '').toLowerCase();
    if (id.includes('question') || id.includes('quiz')) return true;

    return false;
  }

  function cloneWithShadow(node, depth) {
    depth = depth || 0;

    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode(true);
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      var el = node;

      // Form-related elements are always included
      var forceInclude = isFormRelated(el);

      // Skip only truly hidden elements (unless form-related)
      if (!forceInclude && !isEffectivelyVisible(el)) {
        return null;
      }

      var clone = el.cloneNode(false);

      if (el.shadowRoot) {
        var shadowContainer = document.createElement('div');
        shadowContainer.setAttribute('data-mote-shadow-root', 'true');
        Array.from(el.shadowRoot.childNodes).forEach(function(child) {
          var shadowChild = cloneWithShadow(child, depth + 1);
          if (shadowChild) shadowContainer.appendChild(shadowChild);
        });
        clone.appendChild(shadowContainer);
      }

      Array.from(el.childNodes).forEach(function(child) {
        var childClone = cloneWithShadow(child, depth + 1);
        if (childClone) clone.appendChild(childClone);
      });

      return clone;
    }

    return null;
  }

  // Also extract question text directly (in case it's in unusual containers)
  function extractQuestionContext() {
    var parts = [];

    // Look for headings in main content
    var mainEl = document.querySelector('main, [role="main"], #main, #content, .main-content');
    var searchRoot = mainEl || document.body;

    // Find question/prompt text
    var headings = searchRoot.querySelectorAll('h1, h2, h3, [class*="question" i], [class*="prompt" i]');
    headings.forEach(function(h) {
      var text = h.innerText ? h.innerText.trim() : '';
      if (text && text.length > 10 && text.length < 1000 && !text.includes('©')) {
        parts.push('<h2>' + text + '</h2>');
      }
    });

    // Find labels for checkboxes/radios
    var inputs = searchRoot.querySelectorAll('input[type="checkbox"], input[type="radio"]');
    if (inputs.length > 0) {
      parts.push('<ul class="answer-options">');
      inputs.forEach(function(input) {
        var labelText = input.getAttribute('aria-label') || '';
        if (!labelText && input.id) {
          var label = document.querySelector('label[for="' + input.id + '"]');
          if (label) labelText = label.innerText ? label.innerText.trim() : '';
        }
        if (!labelText && input.parentElement) {
          var parent = input.parentElement;
          if (parent.tagName.toLowerCase() === 'label') {
            labelText = parent.innerText ? parent.innerText.trim() : '';
          }
        }
        if (labelText && labelText.length > 3) {
          var checked = input.checked ? '☑' : '☐';
          parts.push('<li>' + checked + ' ' + labelText + '</li>');
        }
      });
      parts.push('</ul>');
    }

    return parts.join('\\n');
  }

  var wrapper = document.createElement('div');
  Array.from(document.body.childNodes).forEach(function(child) {
    var cloned = cloneWithShadow(child, 0);
    if (cloned) wrapper.appendChild(cloned);
  });

  // Prepend extracted question context for quiz pages
  var questionContext = extractQuestionContext();
  if (questionContext && questionContext.length > 50) {
    return '<div class="extracted-question-context">' + questionContext + '</div>\\n' + wrapper.innerHTML;
  }

  return wrapper.innerHTML;
})()`;

/**
 * Script to extract interactive elements from the page.
 * Supports Shadow DOM traversal.
 */
const EXTRACT_INTERACTIVE_ELEMENTS_SCRIPT = `(function(targetSelectors) {
  var results = [];

  // Check if element has non-zero size (exists in DOM layout)
  // NOTE: We intentionally do NOT filter by viewport position.
  // The LLM needs to know about ALL interactive elements, including those
  // below the fold. It can then decide to scroll if needed.
  function hasSize(rect) {
    return rect.width > 0 && rect.height > 0;
  }

  // Check if element is within the current viewport (for prioritization)
  function isInViewport(rect) {
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }

  var interactiveTags = new Set(['button', 'a', 'input', 'textarea', 'select', 'details', 'summary']);
  var interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'menuitem',
    'tab', 'option', 'slider', 'spinbutton', 'combobox', 'searchbox', 'listbox',
    'menu', 'menuitemcheckbox', 'menuitemradio', 'treeitem'
  ]);

  function isInteractive(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    var hasClick = el.hasAttribute('onclick');
    var isContentEditable = el.isContentEditable && el.contentEditable === 'true';

    if (interactiveTags.has(tag)) {
      if (tag === 'input' && el.getAttribute('type') === 'hidden') return false;
      return true;
    }
    if (role && interactiveRoles.has(role)) return true;
    if (hasClick) return true;
    if (isContentEditable) return true;

    return false;
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function getSelectOptions(el) {
    var options = [];
    for (var i = 0; i < el.options.length && options.length < 20; i++) {
      var opt = el.options[i];
      if (!opt.disabled) {
        options.push({
          value: opt.value,
          label: opt.text.trim() || opt.value
        });
      }
    }
    return options;
  }

  // Helper to check if an invisible input has a visible label
  function hasVisibleLabel(el) {
      if (el.tagName.toLowerCase() !== 'input') return false;
      
      // Check for explicit label tag with 'for'
      if (el.id) {
          var label = document.querySelector('label[for="' + el.id + '"]');
          if (label && label.offsetParent !== null) return true;
      }
      
      // Check for parent label
      var parent = el.parentElement;
      while(parent && parent !== document.body) {
          if (parent.tagName.toLowerCase() === 'label' && parent.offsetParent !== null) return true;
          // Heuristic: Check for custom container wrappers often used in modern frameworks 
          // e.g. .RadioButton---label
          if (parent.className && typeof parent.className === 'string' && 
             (parent.className.includes('Radio') || parent.className.includes('Checkbox') || 
              parent.className.includes('Switch') || parent.className.includes('Control'))) {
              if (parent.offsetParent !== null) return true;
          }
          if (parent.childElementCount > 3) break; // Don't go too high up
          parent = parent.parentElement;
      }
      return false;
  }

  function walk(root) {
    var children = root instanceof HTMLIFrameElement ? [] : root.children;

    for (var i = 0; i < children.length; i++) {
      var el = children[i];

      // Special check for invisible inputs (common in custom UI libraries like Percipio)
      // If it's a hidden radio/checkbox but has a visible label/container, we treat it as interactive.
      var isSpecialHiddenInput = false;
      if (el.tagName.toLowerCase() === 'input' && 
         (el.type === 'radio' || el.type === 'checkbox') &&
         (el.style.opacity === '0' || el.style.visibility === 'hidden' || el.style.display === 'none' || el.getAttribute('hidden') !== null || el.offsetWidth === 0)) {
           // It's invisible. Does it have a visible partner?
           if (hasVisibleLabel(el)) {
               isSpecialHiddenInput = true;
           }
      }

      var isInt = isInteractive(el);

      if (isInt || isSpecialHiddenInput) {
        var rect = el.getBoundingClientRect();
        
        // For special hidden inputs, if the element itself has no rect, 
        // try to use the parent/label rect for visibility determination
        // but keep the element itself for interaction (Playwright can force click)
        if (isSpecialHiddenInput && !hasSize(rect)) {
             var parentForRect = el.parentElement;
             if (parentForRect) rect = parentForRect.getBoundingClientRect();
        }

        // Include element if it has size (even if outside viewport)
        // This ensures buttons below the fold are captured
        if (hasSize(rect)) {
          var tag = el.tagName.toLowerCase();
          var disabled = isDisabled(el);

          var text =
            (el.innerText && el.innerText.trim()) ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('title') ||
            el.getAttribute('alt') ||
            el.getAttribute('value') ||
            '';

          if (text.length > 50) text = text.substring(0, 47) + '...';

          if (text || tag === 'input' || tag === 'select') {
            var attributes = {};
            var attrNames = [
              'href', 'name', 'id', 'class', 'type',
              'aria-label', 'placeholder', 'value', 'role',
              'data-testid', 'data-test-id', 'data-test'
            ];

            for (var j = 0; j < attrNames.length; j++) {
              var attr = attrNames[j];
              var val = el.getAttribute(attr);
              if (val) attributes[attr] = val.length > 100 ? val.substring(0, 97) + '...' : val;
            }

            // Special handling for checkbox/radio checked state
            if (el.type === 'checkbox' || el.type === 'radio') {
              attributes['checked'] = el.checked ? 'true' : 'false';
            }

            var parent = el.parentElement;
            var parentSelector;
            while (parent && parent !== document.body) {
              if (parent.id) {
                parentSelector = '[id="' + parent.id + '"]';
                break;
              }
              parent = parent.parentElement;
            }

            var options;
            if (tag === 'select') {
              options = getSelectOptions(el);
            }

            // Mark if element is outside viewport (might need scrolling)
            var inViewport = isInViewport(rect);

            results.push({
              tag: tag,
              text: text,
              inputType: el.type,
              attributes: attributes,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              parentSelector: parentSelector,
              options: options,
              disabled: disabled || undefined,
              offscreen: !inViewport || undefined
            });
          }
        }
      }

      if (el.shadowRoot) {
        walk(el.shadowRoot);
      }

      if (el.childElementCount > 0 && el.tagName.toLowerCase() !== 'iframe') {
        walk(el);
      }
    }
  }

  walk(document.body);
  return results;
})`;

// -----------------------------------------------------------------------------
// BUILD CSS SELECTOR
// -----------------------------------------------------------------------------

/**
 * Escape special CSS selector characters in attribute values.
 * Characters that need escaping: " \ [ ]
 */
function escapeCssValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Result of building selectors for an element.
 * Contains a primary (highest-priority) selector and alternatives for resilient matching.
 */
interface SelectorFingerprint {
  primary: string;
  alternatives: string[];
}

/**
 * Build CSS selectors that uniquely identify an element.
 * Returns a primary selector (highest priority) and alternative selectors
 * for resilient matching when the primary selector breaks.
 *
 * Priority: ID > data-testid > name > aria-label > text > href > fallback.
 */
function buildSelectorFingerprint(el: {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  parentSelector?: string;
}): SelectorFingerprint {
  const { tag, text, attributes, parentSelector } = el;
  const candidates: string[] = [];

  // Priority 1: ID (most reliable)
  if (attributes.id) {
    candidates.push(`[id="${escapeCssValue(attributes.id)}"]`);
  }

  // Priority 1b: Test IDs (High signal for automation)
  if (attributes['data-testid']) candidates.push(`[data-testid="${escapeCssValue(attributes['data-testid'])}"]`);
  if (attributes['data-test-id']) candidates.push(`[data-test-id="${escapeCssValue(attributes['data-test-id'])}"]`);
  if (attributes['data-test']) candidates.push(`[data-test="${escapeCssValue(attributes['data-test'])}"]`);

  // Priority 2: Radio/Checkbox with value
  if (tag === 'input' && attributes.type) {
    if ((attributes.type === 'radio' || attributes.type === 'checkbox') && attributes.value) {
      if (attributes.name) {
         candidates.push(`input[type="${attributes.type}"][name="${escapeCssValue(attributes.name)}"][value="${escapeCssValue(attributes.value)}"]`);
      }
      candidates.push(`input[type="${attributes.type}"][value="${escapeCssValue(attributes.value)}"]`);
    }
  }

  // Priority 3: Name (for inputs, textarea, select)
  if (attributes.name && ['input', 'textarea', 'select'].includes(tag)) {
    candidates.push(`${tag}[name="${escapeCssValue(attributes.name)}"]`);
  }

  // Priority 4: Type + placeholder
  if (tag === 'input' && attributes.type && attributes.placeholder) {
    candidates.push(`input[type="${attributes.type}"][placeholder="${escapeCssValue(attributes.placeholder)}"]`);
  }

  // Priority 4b: Aria-label
  if (attributes['aria-label']) {
    candidates.push(`[aria-label="${escapeCssValue(attributes['aria-label'])}"]`);
  }

  // Priority 5: Type only
  if (tag === 'input' && attributes.type) {
     candidates.push(`input[type="${attributes.type}"]`);
  }

  // Priority 6: Text content (Playwright's :has-text pseudo-selector)
  if ((tag === 'button' || tag === 'a') && text) {
    const textSelector = `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
    if (parentSelector) {
        candidates.push(`${parentSelector} ${textSelector}`);
    } else {
        candidates.push(textSelector);
    }
  }

  // Priority 7: Href
  if (tag === 'a' && attributes.href) {
    const href = attributes.href;
    if (href.length > 50) {
      candidates.push(`a[href*="${escapeCssValue(href.substring(0, 30))}"]`);
    } else {
      candidates.push(`a[href="${escapeCssValue(href)}"]`);
    }
  }

  // Fallback: first available attribute
  if (candidates.length === 0 && Object.keys(attributes).length > 0) {
    const [key, value] = Object.entries(attributes)[0];
    candidates.push(`${tag}[${key}="${escapeCssValue(value)}"]`);
  }

  // Priority 8: Text content for all other elements (before bare tag fallback)
  // Use text content as a selector if the element has meaningful text
  if (candidates.length === 0 && text && text.length > 0 && text.length < 100) {
    const textSelector = `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
    if (parentSelector) {
      candidates.push(`${parentSelector} ${textSelector}`);
    } else {
      candidates.push(textSelector);
    }
  }

  // Bare tag as last resort
  if (candidates.length === 0) {
    candidates.push(tag);
  }

  return {
    primary: candidates[0],
    alternatives: candidates.slice(1),
  };
}

/**
 * Build a single CSS selector (convenience wrapper for backward compatibility).
 * Used by frame selector building where alternatives aren't needed.
 */
function buildSelector(el: {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  parentSelector?: string;
}): string {
  return buildSelectorFingerprint(el).primary;
}


