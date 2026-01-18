// =============================================================================
// PERCEIVE MODULE
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
// - perceive(page): Main function - returns PageState with markdown and elements
// - extractInteractiveElements(page): Find all clickable/interactive elements
// - formatElementsForAI(elements): Format element list as string for AI prompt
// =============================================================================

import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { Page } from 'playwright';
import type { PageState, ElementInfo } from './types.js';
import { getPageContent } from './browser.js';

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
// MAIN PERCEIVE FUNCTION
// -----------------------------------------------------------------------------

/**
 * Perceive the current page - extract content and interactive elements.
 * This is the main function called by the agent loop.
 *
 * @param page - Playwright page object
 * @returns PageState with markdown content and element list
 *
 * @example
 * const state = await perceive(page)
 * console.log(state.markdown)  // Clean content
 * console.log(state.elements)  // Clickable elements
 */
export async function perceive(page: Page): Promise<PageState> {
  // Get page info and HTML using browser module
  const { url, title, html } = await getPageContent(page);

  // Extract and convert content
  const markdown = extractAndConvert(html, url);

  // Find interactive elements
  const elements = await extractInteractiveElements(page);

  return {
    url,
    title,
    markdown,
    elements,
  };
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
  const maxLength = 8000; // ~2000 tokens
  if (markdown.length > maxLength) {
    markdown = markdown.substring(0, maxLength) + '\n\n[Content truncated...]';
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

// -----------------------------------------------------------------------------
// EXTRACT INTERACTIVE ELEMENTS
// -----------------------------------------------------------------------------

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
  page: Page
): Promise<ElementInfo[]> {
  // ---------------------------------------------------------------------------
  // What makes an element "interactive"?
  // ---------------------------------------------------------------------------
  // - Buttons: <button>, input[type="submit"], input[type="button"]
  // - Links: <a> with href
  // - Inputs: <input>, <textarea>, <select>
  // - Clickable: Elements with onclick or role="button"

  const elements = await page.evaluate(() => {
    const results: Array<{
      tag: string;
      text: string;
      inputType?: string;
      attributes: Record<string, string>;
      rect: { x: number; y: number; width: number; height: number };
    }> = [];

    // Selector for interactive elements
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[onclick]',
    ].join(', ');

    const elements = document.querySelectorAll(selector);

    elements.forEach((el) => {
      const htmlEl = el as HTMLElement;

      // Skip invisible elements
      // Many pages have hidden elements (menus, modals).
      // We only want elements the user can actually see and interact with.
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      // Skip elements outside viewport (likely hidden)
      if (rect.top > window.innerHeight || rect.bottom < 0) return;
      if (rect.left > window.innerWidth || rect.right < 0) return;

      // Get visible text
      //Text priority: innerText → aria-label → placeholder → title → alt → value
      // This ensures we always have something to show the AI about what the element does.
      let text =
        htmlEl.innerText?.trim() ||
        htmlEl.getAttribute('aria-label') ||
        htmlEl.getAttribute('placeholder') ||
        htmlEl.getAttribute('title') ||
        htmlEl.getAttribute('alt') ||
        htmlEl.getAttribute('value') ||
        '';

      // Truncate long text
      if (text.length > 50) {
        text = text.substring(0, 47) + '...';
      }

      // Skip elements with no identifiable text
      if (!text && el.tagName.toLowerCase() !== 'input') return;
      // Collect relevant attributes
      const attributes: Record<string, string> = {};
      const attrNames = [
        'href',
        'name',
        'id',
        'class',
        'type',
        'aria-label',
        'placeholder',
      ];

      for (const attr of attrNames) {
        const value = htmlEl.getAttribute(attr);
        if (value) {
          attributes[attr] =
            value.length > 100 ? value.substring(0, 97) + '...' : value;
        }
      }

      results.push({
        tag: el.tagName.toLowerCase(),
        text,
        inputType: (el as HTMLInputElement).type,
        attributes,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    });

    return results;
  });

  // ---------------------------------------------------------------------------
  // Build element list with selectors
  // ---------------------------------------------------------------------------
  // We need to create a unique CSS selector for each element
  // so Playwright can find it later when we want to click/type

  return elements.map((el, idx) => {
    const selector = buildSelector(el);

    return {
      index: idx + 1, // 1-indexed for human readability
      tag: el.tag,
      text: el.text || `[${el.tag}]`,
      selector,
      inputType: el.inputType,
      attributes: el.attributes,
    };
  });
}

// -----------------------------------------------------------------------------
// BUILD CSS SELECTOR
// -----------------------------------------------------------------------------

/**
 * Build a CSS selector that uniquely identifies an element.
 *
 * The priority order:
 * 1. ID (most reliable): #login-button
 * 2. Name attribute: input[name="email"]
 * 3. Unique class: .submit-btn
 * 4. Aria-label: [aria-label="Search"]
 * 5. Text content (for buttons/links): button:has-text("Submit")
 * 6. Combination: input[type="text"][placeholder="Search"]
 */
function buildSelector(el: {
  tag: string;
  text: string;
  attributes: Record<string, string>;
}): string {
  const { tag, text, attributes } = el;

  // Priority 1: ID (using attribute selector to avoid needing CSS.escape)
  if (attributes.id) {
    return `[id="${attributes.id}"]`;
  }

  // Priority 2: Name (for inputs)
  if (attributes.name && ['input', 'textarea', 'select'].includes(tag)) {
    return `${tag}[name="${attributes.name}"]`;
  }

  // Priority 3: Aria-label
  if (attributes['aria-label']) {
    return `[aria-label="${attributes['aria-label']}"]`;
  }

  // Priority 4: Type + placeholder for inputs
  if (tag === 'input' && attributes.type) {
    if (attributes.placeholder) {
      return `input[type="${attributes.type}"][placeholder="${attributes.placeholder}"]`;
    }
    return `input[type="${attributes.type}"]`;
  }

  // Priority 5: Text content for buttons and links
  if ((tag === 'button' || tag === 'a') && text) {
    // Use Playwright's text selector
    return `${tag}:has-text("${text.replace(/"/g, '\\"')}")`;
  }

  // Priority 6: Href for links
  if (tag === 'a' && attributes.href) {
    const href = attributes.href;
    // Use partial match for long URLs
    if (href.length > 50) {
      return `a[href*="${href.substring(0, 30)}"]`;
    }
    return `a[href="${href}"]`;
  }

  // Fallback: tag with any available attribute
  if (Object.keys(attributes).length > 0) {
    const [key, value] = Object.entries(attributes)[0];
    return `${tag}[${key}="${value}"]`;
  }

  // Last resort: just the tag (not unique, but better than nothing)
  return tag;
}

// -----------------------------------------------------------------------------
// FORMAT ELEMENTS FOR AI
// -----------------------------------------------------------------------------

/**
 * Format element list as a string for the AI prompt.
 *
 * @param elements - Array of ElementInfo
 * @returns Formatted string
 *
 * @example
 * // Output:
 * // [1] input (text): "Search Google or type a URL" [placeholder="Search..."]
 * // [2] button: "Google Search"
 * // [3] link: "Gmail" [href="https://mail.google.com"]
 */
export function formatElementsForAI(elements: ElementInfo[]): string {
  if (elements.length === 0) {
    return 'No interactive elements found on this page.';
  }

  return elements
    .map((el) => {
      let line = `[${el.index}] ${el.tag}`;

      // Add input type if present
      if (el.inputType && el.inputType !== 'text') {
        line += ` (${el.inputType})`;
      }

      // Add text/description
      line += `: "${el.text}"`;

      // Add key attributes
      const keyAttrs = ['href', 'placeholder', 'name'];
      for (const attr of keyAttrs) {
        if (el.attributes[attr]) {
          line += ` [${attr}="${el.attributes[attr]}"]`;
        }
      }

      return line;
    })
    .join('\n');
}

// -----------------------------------------------------------------------------
// TEST: Run this file directly to verify perceive works
// -----------------------------------------------------------------------------
// Usage: npm run test:perceive (shortcut for npx tsx src/perceive.ts)

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { launchBrowser, navigateTo, closeBrowser } = await import(
    './browser.js'
  );

  console.clear();
  console.log('='.repeat(60));
  console.log(' 👁️  MOTE PERCEPTION TEST');
  console.log('='.repeat(60));

  const session = await launchBrowser({
    headless: false,
    slowMo: 100,
    timeout: {
      default: 30000,
      navigation: 30000,
      element: 5000,
      postNavDelay: 500,
    },
  });

  try {
    const targetUrl = 'https://www.google.com';
    console.log(`\n🚀 Navigating to: ${targetUrl}...`);
    await navigateTo(session.page, targetUrl);

    // Perceive the page
    const state = await perceive(session.page);

    // 1. METADATA
    console.log(`\n📍 [METADATA]`);
    console.log(`   Title:  "${state.title}"`);
    console.log(`   URL:    ${state.url}`);

    // 2. READING MATERIAL (Markdown)
    console.log(`\n📄 [READING MATERIAL] (Markdown Content)`);
    console.log(`   Length: ${state.markdown.length} chars`);
    console.log('-'.repeat(40));
    console.log(
      state.markdown.substring(0, 300).replace(/\n/g, '\n   ') +
        '\n   ... [truncated]'
    );
    console.log('-'.repeat(40));

    // 3. CONTROL PANEL (Elements)
    console.log(`\n🕹️  [CONTROL PANEL] (Interactive Elements)`);
    console.log(`   Found: ${state.elements.length} clickable items`);
    console.log(`   Inspecting first 5 items to verify AI match:\n`);

    state.elements.slice(0, 5).forEach((el) => {
      // We print the "AI View" and the "System View" side by side
      // to ensure the selector logic matches the human description.
      console.log(`   [${el.index}] 🏷️  TYPE: <${el.tag}>`);
      console.log(`       👀 AI SEES:  ${formatElementsForAI([el])}`);
      console.log(`       🤖 SYS USES: ${el.selector}`);
      console.log('');
    });

    if (state.elements.length > 5) {
      console.log(
        `   ... and ${state.elements.length - 5} more elements hidden.`
      );
    }

    await session.page.waitForTimeout(2000);
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await closeBrowser(session.browser);
  }

  console.log('\n✅ Test execution finished.');
}
