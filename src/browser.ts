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
 * Information about a browser dialog (alert, confirm, prompt).
 */
export interface DialogInfo {
  /** Type of dialog: 'alert', 'confirm', 'prompt', 'beforeunload' */
  type: string;
  /** Message displayed in the dialog */
  message: string;
  /** Default value for prompt dialogs */
  defaultValue?: string;
  /** When the dialog appeared */
  timestamp: string;
  /** Whether the dialog was accepted or dismissed */
  accepted: boolean;
}

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
  /** Recent dialogs that appeared (kept for agent awareness) */
  recentDialogs: DialogInfo[];
  /** Get and clear recent dialogs */
  getAndClearDialogs: () => DialogInfo[];
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
  // Store config at module level so other functions can access timeout settings
  sessionBrowserConfig = config;

  // ---------------------------------------------------------------------------
  // Stealth mode configuration
  // ---------------------------------------------------------------------------
  // When stealth is enabled, we apply patches to avoid bot detection:
  // - Browser launch args to disable automation signals
  // - Init script to hide navigator.webdriver
  const stealthArgs = config.stealth
    ? [
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        '--window-position=100,50',
      ]
    : ['--window-size=1280,800', '--window-position=100,50'];

  const stealthInitScript = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `;

  // Common context options - use null viewport for responsive behavior
  const contextOptions = {
    viewport: null as null,  // Responsive - content reflows when window resizes
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  };

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  // ---------------------------------------------------------------------------
  // Launch browser - persistent or ephemeral
  // ---------------------------------------------------------------------------
  if (config.profilePath) {
    // Persistent context: saves cookies, logins, history to disk
    // This is ideal for avoiding re-login and looking like a real user
    context = await chromium.launchPersistentContext(config.profilePath, {
      headless: config.headless,
      slowMo: config.slowMo,
      args: stealthArgs.length > 0 ? stealthArgs : undefined,
      ...contextOptions,
    });

    // For persistent context, browser() returns the browser instance
    browser = context.browser()!;

    // Use existing page or create new one
    page = context.pages()[0] || (await context.newPage());

    console.log(`🌐 Browser launched (profile: ${config.profilePath})`);
  } else {
    // Ephemeral: fresh browser each time (original behavior)
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
      args: stealthArgs.length > 0 ? stealthArgs : undefined,
    });

    context = await browser.newContext(contextOptions);
    page = await context.newPage();

    console.log('🌐 Browser launched');
  }

  // ---------------------------------------------------------------------------
  // Apply stealth patches
  // ---------------------------------------------------------------------------
  if (config.stealth) {
    await context.addInitScript(stealthInitScript);
    console.log('🥷 Stealth mode enabled');
  }

  // Set default timeout for all page operations
  page.setDefaultTimeout(config.timeout.default);

  // ---------------------------------------------------------------------------
  // Set up dialog handler
  // ---------------------------------------------------------------------------
  const recentDialogs: DialogInfo[] = [];

  page.on('dialog', async (dialog) => {
    const dialogInfo: DialogInfo = {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue() || undefined,
      timestamp: new Date().toISOString(),
      accepted: true,
    };

    recentDialogs.push(dialogInfo);
    if (recentDialogs.length > 5) {
      recentDialogs.shift();
    }

    console.log(`💬 Dialog (${dialog.type()}): "${dialog.message()}" → auto-accepted`);
    await dialog.accept();
  });

  // Helper to get and clear dialogs
  const getAndClearDialogs = (): DialogInfo[] => {
    const dialogs = [...recentDialogs];
    recentDialogs.length = 0;
    return dialogs;
  };

  return { browser, context, page, recentDialogs, getAndClearDialogs };
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
