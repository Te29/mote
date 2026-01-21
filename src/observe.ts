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
import type { PageState, ElementInfo, CaptchaInfo } from './types.js';
import { getPageContent } from './browser.js';

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

/** Maximum markdown content length before truncation (~2000 tokens) */
const MAX_MARKDOWN_LENGTH = 8000;

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
  // Get page info using browser module
  const { url, title } = await getPageContent(page);

  // Find interactive elements
  // If targetSelectors is provided, we prioritize finding them
  const elements = await extractInteractiveElements(page, targetSelectors);

  let markdown = '';
  // Optimization: If in Execute Mode (targetSelectors provided) and we found them,
  // we can skip the expensive markdown generation.
  // We check if we found ALL target selectors (or at least the first one which is usually the action target)
  const targetsFound = targetSelectors && targetSelectors.every(selector => 
    elements.some(el => el.selector === selector)
  );

  if (targetSelectors && targetsFound) {
     // Skip expensive extraction
     markdown = '[Execute Mode: Markdown generation skipped for performance]';
  } else {
     // Normal Explore Mode OR Fallback (targets not found)
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
    const html = document.documentElement.outerHTML.toLowerCase();
    const bodyText = document.body?.innerText?.toLowerCase() || '';

    // Check for reCAPTCHA
    const hasRecaptcha =
      html.includes('recaptcha') ||
      html.includes('grecaptcha') ||
      !!document.querySelector('iframe[src*="recaptcha"]') ||
      !!document.querySelector('.g-recaptcha');

    if (hasRecaptcha) {
      return { detected: true, type: 'recaptcha' as const };
    }

    // Check for hCaptcha
    const hasHcaptcha =
      html.includes('hcaptcha') ||
      !!document.querySelector('iframe[src*="hcaptcha"]') ||
      !!document.querySelector('.h-captcha');

    if (hasHcaptcha) {
      return { detected: true, type: 'hcaptcha' as const };
    }

    // Check for Cloudflare challenge
    const hasCloudflare =
      html.includes('cloudflare') ||
      html.includes('cf-browser-verification') ||
      html.includes('cf_chl_opt') ||
      bodyText.includes('checking your browser') ||
      bodyText.includes('ddos protection by cloudflare') ||
      !!document.querySelector('#cf-wrapper') ||
      !!document.querySelector('.cf-browser-verification');

    if (hasCloudflare) {
      return { detected: true, type: 'cloudflare' as const };
    }

    // Check for generic captcha patterns
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
      (pattern) => bodyText.includes(pattern) || html.includes(pattern),
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
 * @param html - Raw HTML string
 * @param url - Page URL (needed by Readability)
 * @returns Clean Markdown content
 */
function extractAndConvert(html: string, url: string): string {
  // ---------------------------------------------------------------------------
  // Step 1: Create a DOM environment
  // ---------------------------------------------------------------------------
  // Readability needs a DOM to work with.
  // In a browser, you'd use `document`. In Node.js, we use JSDOM.
  // JSDOM creates a "fake" browser environment.

  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // ---------------------------------------------------------------------------
  // Step 2: Try Readability extraction
  // ---------------------------------------------------------------------------
  // Readability is Mozilla's algorithm for extracting the "main" content
  // from a web page. It's what powers Firefox's Reader Mode.
  //
  // It works by:
  // 1. Looking for content-heavy elements (lots of text, few links)
  // 2. Removing navigation, sidebars, ads, footers
  // 3. Returning just the "article" content
  //
  // This is AMAZING for news articles, blogs, documentation
  // But it can fail on:
  // - Search results pages (no single "article")
  // - Web apps (content is dynamic)
  // - Login pages (mostly forms)
  // When Readability fails: call simplifyHtml() which removes common
  // noise elements manually. It's not as smart as Readability but better than raw HTML.

  const reader = new Readability(document.cloneNode(true) as Document);
  const article = reader.parse();

  let cleanHtml: string;

  if (article && article.content) {
    // Readability found main content
    cleanHtml = article.content;
  } else {
    // Readability failed - fall back to body content
    // This happens on search pages, apps, etc.
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

  return clone.innerHTML;
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
      }>;

      // 3. Process and add to list
      for (const el of rawElements) {
        const selector = buildSelector(el);

        allElements.push({
          index: currentIndex++,
          tag: el.tag,
          text: el.text || `[${el.tag}]`,
          selector,
          inputType: el.inputType,
          attributes: el.attributes,
          frameSelector,
          options: el.options,
          disabled: el.disabled,
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
  function isVisible(elem) {
    var style = window.getComputedStyle(elem);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function cloneWithShadow(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode(true);
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      var el = node;
      if (!isVisible(el)) return null;

      var clone = el.cloneNode(false);

      if (el.shadowRoot) {
        var shadowContainer = document.createElement('div');
        shadowContainer.setAttribute('data-mote-shadow-root', 'true');
        Array.from(el.shadowRoot.childNodes).forEach(function(child) {
          var shadowChild = cloneWithShadow(child);
          if (shadowChild) shadowContainer.appendChild(shadowChild);
        });
        clone.appendChild(shadowContainer);
      }

      Array.from(el.childNodes).forEach(function(child) {
        var childClone = cloneWithShadow(child);
        if (childClone) clone.appendChild(childClone);
      });

      return clone;
    }

    return null;
  }

  var wrapper = document.createElement('div');
  Array.from(document.body.childNodes).forEach(function(child) {
    var cloned = cloneWithShadow(child);
    if (cloned) wrapper.appendChild(cloned);
  });

  return wrapper.innerHTML;
})()`;

/**
 * Script to extract interactive elements from the page.
 * Supports Shadow DOM traversal.
 */
const EXTRACT_INTERACTIVE_ELEMENTS_SCRIPT = `(function(targetSelectors) {
  var results = [];

  function isVisible(rect) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
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

  function walk(root) {
    var children = root instanceof HTMLIFrameElement ? [] : root.children;

    for (var i = 0; i < children.length; i++) {
      var el = children[i];

      if (isInteractive(el)) {
        var rect = el.getBoundingClientRect();

        if (isVisible(rect)) {
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

            results.push({
              tag: tag,
              text: text,
              inputType: el.type,
              attributes: attributes,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              parentSelector: parentSelector,
              options: options,
              disabled: disabled || undefined
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
 * Build a CSS selector that uniquely identifies an element.
 * Prioritizes stable selectors: ID > data-testid > name > aria-label > text.
 */
function buildSelector(el: {
  tag: string;
  text: string;
  attributes: Record<string, string>;
  parentSelector?: string;
}): string {
  const { tag, text, attributes, parentSelector } = el;

  // Priority 1: ID (most reliable)
  if (attributes.id) {
    return `[id="${escapeCssValue(attributes.id)}"]`;
  }

  // Priority 1b: Test IDs (High signal for automation)
  if (attributes['data-testid']) return `[data-testid="${escapeCssValue(attributes['data-testid'])}"]`;
  if (attributes['data-test-id']) return `[data-test-id="${escapeCssValue(attributes['data-test-id'])}"]`;
  if (attributes['data-test']) return `[data-test="${escapeCssValue(attributes['data-test'])}"]`;

  // Priority 2: Radio/Checkbox with value (must come before generic name check)
  // Radio buttons and checkboxes with the same name need value to disambiguate
  if (tag === 'input' && attributes.type) {
    if ((attributes.type === 'radio' || attributes.type === 'checkbox') && attributes.value) {
      if (attributes.name) {
         return `input[type="${attributes.type}"][name="${escapeCssValue(attributes.name)}"][value="${escapeCssValue(attributes.value)}"]`;
      }
      return `input[type="${attributes.type}"][value="${escapeCssValue(attributes.value)}"]`;
    }
  }

  // Priority 3: Name (for inputs, textarea, select)
  if (attributes.name && ['input', 'textarea', 'select'].includes(tag)) {
    return `${tag}[name="${escapeCssValue(attributes.name)}"]`;
  }

  // Priority 4: Type + placeholder
  if (tag === 'input' && attributes.type && attributes.placeholder) {
    return `input[type="${attributes.type}"][placeholder="${escapeCssValue(attributes.placeholder)}"]`;
  }

  // Priority 4: Aria-label
  if (attributes['aria-label']) {
    return `[aria-label="${escapeCssValue(attributes['aria-label'])}"]`;
  }

  // Priority 5: Type only
  if (tag === 'input' && attributes.type) {
     return `input[type="${attributes.type}"]`;
  }

  // Priority 6: Text content (Playwright's :has-text pseudo-selector)
  if ((tag === 'button' || tag === 'a') && text) {
    const textSelector = `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
    if (parentSelector) {
        return `${parentSelector} ${textSelector}`;
    }
    return textSelector;
  }

  // Priority 7: Href
  if (tag === 'a' && attributes.href) {
    const href = attributes.href;
    if (href.length > 50) {
      return `a[href*="${escapeCssValue(href.substring(0, 30))}"]`;
    }
    return `a[href="${escapeCssValue(href)}"]`;
  }

  // Fallback
  if (Object.keys(attributes).length > 0) {
    const [key, value] = Object.entries(attributes)[0];
    return `${tag}[${key}="${escapeCssValue(value)}"]`;
  }

  return tag;
}


