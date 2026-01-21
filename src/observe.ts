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
     // Extract and convert content
     const cleanHtml = await page.evaluate(() => {
    // Helper to check if element is visible
    function isVisible(elem: Element): boolean {
      const style = window.getComputedStyle(elem);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    /**
     * Recursive function to clone a node AND its Shadow DOM.
     * Returns a standard HTMLElement that represents the original node + shadow content.
     */
    function cloneWithShadow(node: Node): Node | null {
      // 1. Text nodes: just clone
      if (node.nodeType === Node.TEXT_NODE) {
        return node.cloneNode(true);
      }

      // 2. Elements: deeply clone, then process Shadow DOM
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        
        // Skip hidden elements
        if (!isVisible(el)) return null;

        // Clone the element (shallow clone first to manage children manually)
        const clone = el.cloneNode(false) as HTMLElement; // shallow clone

        // Handle Shadow Root
        if (el.shadowRoot) {
          // Create a container for shadow content to make it "visible" to Readability/Turndown
          // We use a custom attribute to debug if needed, but semantically a DIV is fine.
          const shadowContainer = document.createElement('div');
          shadowContainer.setAttribute('data-mote-shadow-root', 'true');
          
          // Recurse into shadow root children
          Array.from(el.shadowRoot.childNodes).forEach(child => {
            const shadowChild = cloneWithShadow(child);
            if (shadowChild) shadowContainer.appendChild(shadowChild);
          });
          
          clone.appendChild(shadowContainer);
        }

        // Handle generic Slot elements (where light DOM children are projected)
        if (el.tagName.toLowerCase() === 'slot') {
            // In a flattened view, slots are just placeholders. 
            // The actual content is in the light DOM children of the host.
            // But since we are flattening the *view*, we might want to just render the children here?
            // Simpler approach: Just allow normal child processing to handle light DOM.
        }

        // Recurse into normal children (Light DOM)
        // Note: In a real Shadow DOM render, light DOM children only show up if projected into slots.
        // For our purpose (content extraction), reading everything is safer than missing things.
        Array.from(el.childNodes).forEach(child => {
             const childClone = cloneWithShadow(child);
             if (childClone) clone.appendChild(childClone);
        });

        return clone;
      }

      // Default: ignore comments etc.
      return null;
    }

    // Start cloning from body
    // We create a wrapper to hold the result
    const wrapper = document.createElement('div');
    Array.from(document.body.childNodes).forEach(child => {
        const cloned = cloneWithShadow(child);
        if (cloned) wrapper.appendChild(cloned);
    });

    return wrapper.innerHTML;
  });

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

      // 2. Extract elements from this frame
      const rawElements = await frame.evaluate(extractInteractiveElementsInContext, targetSelectors);

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

/**
 * This function runs INSIDE the browser (in every frame).
 * It finds interactive elements and returns their raw data.
 * NOW SUPPORTS SHADOW DOM TRAVERSAL.
 */
function extractInteractiveElementsInContext(targetSelectors?: string[]) {
    const results: Array<{
      tag: string;
      text: string;
      inputType?: string;
      attributes: Record<string, string>;
      rect: { x: number; y: number; width: number; height: number };
      parentSelector?: string;
      options?: Array<{ value: string; label: string }>;
      disabled?: boolean;
    }> = [];

    // Helper to check visibility
    function isVisible(rect: DOMRect) {
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0
      );
    }

    // Interactive element definitions
    const interactiveTags = new Set(['button', 'a', 'input', 'textarea', 'select', 'details', 'summary']);
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'menuitem',
      'tab', 'option', 'slider', 'spinbutton', 'combobox', 'searchbox', 'listbox',
      'menu', 'menuitemcheckbox', 'menuitemradio', 'treeitem'
    ]);

    function isInteractive(el: HTMLElement) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const hasClick = el.hasAttribute('onclick'); // Crude check, real listeners harder to find
        const isContentEditable = el.isContentEditable && el.contentEditable === 'true';

        // Basic checks
        if (interactiveTags.has(tag)) {
            if (tag === 'input' && el.getAttribute('type') === 'hidden') return false;
            return true;
        }
        if (role && interactiveRoles.has(role)) return true;
        if (hasClick) return true;
        if (isContentEditable) return true;

        return false;
    }

    // Check if element is disabled
    function isDisabled(el: HTMLElement): boolean {
        if ((el as HTMLButtonElement | HTMLInputElement).disabled) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        return false;
    }

    // Extract options from select element
    function getSelectOptions(el: HTMLSelectElement): Array<{ value: string; label: string }> {
        const options: Array<{ value: string; label: string }> = [];
        for (const opt of Array.from(el.options)) {
            if (!opt.disabled) {
                options.push({
                    value: opt.value,
                    label: opt.text.trim() || opt.value
                });
            }
        }
        // Limit to first 20 options to avoid bloat
        return options.slice(0, 20);
    }

    // Recursive Shadow DOM walker
    function walk(root: Document | ShadowRoot | Element) {
        const children = root instanceof HTMLIFrameElement ? [] : root.children; // Don't walk into iframes here, Playwright handles frames

        for (let i = 0; i < children.length; i++) {
            const el = children[i] as HTMLElement;

            // Check if interactive
            // Filter by targetSelectors if provided (Execute Mode)
            // Note: We can't perfectly check selectors on raw elements easily without building them,
            // but we can check if it MATCHES the selector.
            let isTarget = true;
            if (targetSelectors && targetSelectors.length > 0) {
                 // Fast check: does this element match any of our targets?
                 isTarget = targetSelectors.some(s => {
                     try { return el.matches(s); } catch { return false; }
                 });
                 // If not a match, and we have targets, we might want to skip?
                 // CAUTION: 'el.matches' works on simple selectors. 
                 // If our selectors are complex (like :has-text), this check fails in JS.
                 // Strategy: We'll collect ALL candidates as before, then filter in Node.js
                 // where we have the `buildSelector` logic?
                 // OR: We trust `el.matches` for ID/Classes?
                 // BETTER: Just collect everything (it's fast) and filter in extractInteractiveElements (Node side)
                 // to ensure we use the canonical `buildSelector` output for comparison.
                 // So we ignore targetSelectors inside this tight loop for now to be safe.
            }

            if (isInteractive(el)) {
                const rect = el.getBoundingClientRect();

                if (isVisible(rect)) {
                    const tag = el.tagName.toLowerCase();
                    const disabled = isDisabled(el);

                    // Get visible text
                    let text =
                        el.innerText?.trim() ||
                        el.getAttribute('aria-label') ||
                        el.getAttribute('placeholder') ||
                        el.getAttribute('title') ||
                        el.getAttribute('alt') ||
                        el.getAttribute('value') ||
                        '';

                    // Truncate
                    if (text.length > 50) text = text.substring(0, 47) + '...';

                    // Filter out empty non-inputs (but keep disabled elements for awareness)
                    if (text || tag === 'input' || tag === 'select') {
                        // Collect attributes
                        const attributes: Record<string, string> = {};
                        const attrNames = [
                            'href', 'name', 'id', 'class', 'type',
                            'aria-label', 'placeholder', 'value', 'role',
                            'data-testid', 'data-test-id', 'data-test' // Vital for automation
                        ];

                        for (const attr of attrNames) {
                            const val = el.getAttribute(attr);
                            if (val) attributes[attr] = val.length > 100 ? val.substring(0, 97) + '...' : val;
                        }

                        // Context (parent ID)
                        let parent = el.parentElement;
                        let parentSelector: string | undefined;
                        while(parent && parent !== document.body) {
                             if(parent.id) {
                                 parentSelector = `[id="${parent.id}"]`;
                                 break;
                             }
                             parent = parent.parentElement;
                        }

                        // Extract options for select elements
                        let options: Array<{ value: string; label: string }> | undefined;
                        if (tag === 'select') {
                            options = getSelectOptions(el as HTMLSelectElement);
                        }

                        results.push({
                            tag,
                            text,
                            inputType: (el as HTMLInputElement).type,
                            attributes,
                            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                            parentSelector,
                            options,
                            disabled: disabled || undefined, // Only include if true
                        });
                    }
                }
            }

            // Recurse into Shadow DOM
            if (el.shadowRoot) {
                walk(el.shadowRoot);
            }

            // Recurse into children
            if (el.childElementCount > 0 && el.tagName.toLowerCase() !== 'iframe') {
                walk(el);
            }
        }
    }

    walk(document.body);
    return results;
}

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

  // Priority 2: Name (for inputs)
  if (attributes.name && ['input', 'textarea', 'select'].includes(tag)) {
    return `${tag}[name="${escapeCssValue(attributes.name)}"]`;
  }

  // Priority 3: Type + placeholder/value
  if (tag === 'input' && attributes.type) {
    if ((attributes.type === 'radio' || attributes.type === 'checkbox') && attributes.value) {
      if (attributes.name) {
         return `input[type="${attributes.type}"][name="${escapeCssValue(attributes.name)}"][value="${escapeCssValue(attributes.value)}"]`;
      }
      return `input[type="${attributes.type}"][value="${escapeCssValue(attributes.value)}"]`;
    }

    if (attributes.placeholder) {
      return `input[type="${attributes.type}"][placeholder="${escapeCssValue(attributes.placeholder)}"]`;
    }
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


