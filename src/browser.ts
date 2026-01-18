// =============================================================================
// BROWSER MODULE
// =============================================================================
//
// This module handles everything related to the browser:
// - Launching Chromium via Playwright
// - Navigating to URLs
// - Getting raw page content
// - Clean shutdown
//
// Think of this as the agent's "body" - it's how the agent interacts with
// the physical (well, virtual) world of web browsers.
//
// Exported Functions:
// - launchBrowser(config): Sets up Browser, Context, and Page.
// - navigateTo(page, url): Safe navigation with 'domcontentloaded' wait.
// - getPageContent(page): Returns URL, Title, and Raw HTML.
// - closeBrowser(browser): Ensures clean shutdown.
// - waitForElement(page, selector): Boolean check for element visibility.
// - takeScreenshot(page, path): Saves a PNG of the current view.
//
// =============================================================================

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { fileURLToPath } from 'url';
import type { BrowserConfig } from './types.js';

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/**
 * A bundle of browser resources.
 * Returns all three so the caller can control them.
 *
 * Why three objects?
 * - Browser: The main process (like Chrome.exe)
 * - Context: A session (like an incognito window) - has cookies, storage
 * - Page: A single tab where content lives
 */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

// Module-level variable to store browser config for use across functions.
// Set once during launchBrowser() and accessed by navigateTo(), waitForElement(), etc.
// This avoids passing config through every function call.
let sessionBrowserConfig: BrowserConfig;

// -----------------------------------------------------------------------------
// LAUNCH BROWSER
// -----------------------------------------------------------------------------

/**
 * Launch a new browser instance with the given configuration.
 * Stores config in sessionBrowserConfig for access by other module functions.
 *
 * @param config - Browser settings (headless, slowMo, timeout object)
 * @returns A session containing browser, context, and page
 *
 * @example
 * const session = await launchBrowser({
 *   headless: false,
 *   slowMo: 100,
 *   timeout: { default: 30000, navigation: 30000, element: 5000, postNavDelay: 500 }
 * })
 * await session.page.goto('https://google.com')
 */
export async function launchBrowser(
  config: BrowserConfig
): Promise<BrowserSession> {
  // ---------------------------------------------------------------------------
  // Launch the browser process
  // ---------------------------------------------------------------------------
  // Playwright supports three browsers: chromium, firefox, webkit
  // Why uses Chromium?
  // 1. Most websites are tested on Chrome
  // 2. It has the best DevTools
  // 3. It's what most users are familiar with

  // Store config at module level so other functions (navigateTo, waitForElement, etc.)
  // can access timeout settings without needing config passed as a parameter.
  sessionBrowserConfig = config;

  const browser = await chromium.launch({
    // headless: true  = no visible window (faster, for production)
    // headless: false = visible window (for debugging, watching agent work)
    headless: config.headless,

    // slowMo adds a delay (in ms) between every Playwright action
    // This makes it easier to see what the agent is doing
    // 0 = full speed, 50-100 = watchable, 500+ = slow motion
    slowMo: config.slowMo,
  });

  // ---------------------------------------------------------------------------
  // Create a browser context
  // ---------------------------------------------------------------------------
  // A context is like an incognito window - it has its own:
  // - Cookies (login sessions)
  // - LocalStorage
  // - Cache
  //
  // Why use a context instead of the browser directly?
  // - Isolation: Each context is independent
  // - Cleanup: Close context = clear all data
  // - Parallelism: You can run multiple contexts at once

  const context = await browser.newContext({
    // Set a reasonable viewport size
    // Mobile: 375x667, Tablet: 768x1024, Desktop: 1280x720
    viewport: { width: 1280, height: 720 },

    // Identify ourselves (some sites block headless browsers)
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // ---------------------------------------------------------------------------
  // Create a page (tab)
  // ---------------------------------------------------------------------------
  // This is where the actual web content lives
  // Most agent interactions happen through the page object

  const page = await context.newPage();

  // Set a global fallback timeout for all page operations (click, fill, wait).
  // Uses config.timeout.default - the general-purpose timeout.
  // Other specific timeouts (navigation, element, postNavDelay) are used in their
  // respective functions via sessionBrowserConfig.
  page.setDefaultTimeout(config.timeout.default);

  console.log('🌐 Browser launched');

  return { browser, context, page };
}

// -----------------------------------------------------------------------------
// NAVIGATE TO URL
// -----------------------------------------------------------------------------

/**
 * Navigate to a URL and wait for the page to be ready.
 *
 * @param page - Playwright page object
 * @param url - URL to navigate to
 *
 * @example
 * await navigateTo(page, 'https://google.com')
 */
export async function navigateTo(page: Page, url: string): Promise<void> {
  console.log(`📍 Navigating to: ${url}`);

  // ---------------------------------------------------------------------------
  // Understanding waitUntil options
  // ---------------------------------------------------------------------------
  // Playwright can wait for different "ready" states:
  //
  // 'domcontentloaded' - HTML is parsed, but images/styles may still load
  //                      Fast, but page might not be fully rendered
  //
  // 'load'             - Page fires the 'load' event
  //                      Includes images, but some JS might still run
  //
  // 'networkidle'      - No network requests for 500ms
  //                      Slowest, but most reliable for SPAs
  //
  // Use 'domcontentloaded' as a balance:
  // - Fast enough for simple pages
  // - Can add explicit waits for dynamic content

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    // Uses navigation-specific timeout from sessionBrowserConfig (set in launchBrowser)
    timeout: sessionBrowserConfig.timeout.navigation,
  });

  // Give JavaScript a moment to run after DOM is ready.
  // Many sites load content dynamically after DOMContentLoaded.
  // Uses postNavDelay from sessionBrowserConfig for configurable wait time.
  await page.waitForTimeout(sessionBrowserConfig.timeout.postNavDelay);

  console.log(`✅ Page loaded: ${page.url()}`);
}

// -----------------------------------------------------------------------------
// GET PAGE HTML
// -----------------------------------------------------------------------------

/**
 * Get the current page's HTML content.
 * This is the raw HTML that will be processed by observe.ts
 *
 * @param page - Playwright page object
 * @returns Object with url, title, and html
 */
export async function getPageContent(page: Page): Promise<{
  url: string;
  title: string;
  html: string;
}> {
  // Get basic page info
  const url = page.url();
  const title = await page.title();

  // Get the full HTML of the page
  // This includes everything: head, body, scripts, styles
  // The observe module will clean this up
  const html = await page.content();

  return { url, title, html };
}

// -----------------------------------------------------------------------------
// CLOSE BROWSER
// -----------------------------------------------------------------------------

/**
 * Clean up browser resources.
 * Always call this when done! Leaving browsers open wastes memory.
 *
 * @param browser - Browser instance to close
 */
export async function closeBrowser(browser: Browser): Promise<void> {
  await browser.close();
  console.log('🔒 Browser closed');
}

// -----------------------------------------------------------------------------
// UTILITY: WAIT FOR ELEMENT
// -----------------------------------------------------------------------------

/**
 * Wait for an element to appear on the page.
 * Useful before interacting with dynamic content.
 *
 * @param page - Playwright page object
 * @param selector - CSS selector to wait for
 * @param timeout - Optional override for element timeout (defaults to sessionBrowserConfig.timeout.element)
 * @returns true if found, false if timeout
 */
export async function waitForElement(
  page: Page,
  selector: string,
  timeout?: number
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, {
      state: 'visible', // Element must be visible, not just in DOM
      // Use provided timeout or fall back to element-specific timeout from sessionBrowserConfig
      timeout: timeout ?? sessionBrowserConfig.timeout.element,
    });
    return true;
  } catch {
    // Timeout - element didn't appear
    return false;
  }
}

// -----------------------------------------------------------------------------
// UTILITY: TAKE SCREENSHOT
// -----------------------------------------------------------------------------

/**
 * Take a screenshot of the current page.
 * Useful for debugging and logging.
 *
 * @param page - Playwright page object
 * @param path - Where to save the screenshot
 */
export async function takeScreenshot(page: Page, path: string): Promise<void> {
  await page.screenshot({ path, fullPage: false });
  console.log(`📸 Screenshot saved: ${path}`);
}

// -----------------------------------------------------------------------------
// TEST: Run this file directly to verify browser works
// Test config (hardcoded for standalone testing)
// -----------------------------------------------------------------------------
// Usage: npm run test:browser (shortcut for tsx src/browser.ts)

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('🧪 Testing browser module...\n');

  const config: BrowserConfig = {
    headless: false,
    slowMo: 100,
    timeout: {
      default: 30000,
      navigation: 30000,
      element: 5000,
      postNavDelay: 500,
    },
  };

  const session = await launchBrowser(config);

  try {
    await navigateTo(session.page, 'https://www.google.com');

    const content = await getPageContent(session.page);
    console.log('\n📄 Page info:');
    console.log(`   URL: ${content.url}`);
    console.log(`   Title: ${content.title}`);
    console.log(`   HTML length: ${content.html.length} characters`);

    // Wait a moment so you can see the browser
    await session.page.waitForTimeout(3000);
  } finally {
    await closeBrowser(session.browser);
  }

  console.log('\n✅ Browser test complete!');
}
