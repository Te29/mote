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
// - takeScreenshot(page, path): Saves a PNG of the current view.
//
// =============================================================================

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type { ResolvedConfig } from './types/index.js';

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

/**
 * Configuration subset needed for the browser module.
 * Extracted from the main ResolvedConfig to maintain loose coupling while ensuring type safety.
 */
export type BrowserOptions = Pick<
  ResolvedConfig,
  | 'headless'
  | 'slowMo'
  | 'profilePath'
  | 'stealth'
  | 'timeoutDefault'
  | 'timeoutNavigation'
  | 'timeoutElement'
  | 'postNavDelay'
>;

// Module-level variable to store browser config for use across functions.
// Set once during launchBrowser() and accessed by navigateTo(), waitForElement(), etc.
// This avoids passing config through every function call.
let sessionBrowserConfig: BrowserOptions;

// -----------------------------------------------------------------------------
// LAUNCH BROWSER
// -----------------------------------------------------------------------------

/**
 * Launch a new browser instance with the given configuration.
 * Stores config in sessionBrowserConfig for access by other module functions.
 *
 * @param config - Browser settings (headless, slowMo, timeouts)
 * @returns A session containing browser, context, and page
 *
 * @example
 * const session = await launchBrowser({
 *   headless: false,
 *   slowMo: 100,
 *   timeoutDefault: 30000,
 *   // ... other options
 * })
 * await session.page.goto('https://google.com')
 */
export async function launchBrowser(
  config: BrowserOptions,
): Promise<BrowserSession> {
  // Store config at module level so other functions can access timeout settings
  sessionBrowserConfig = config;

  // ---------------------------------------------------------------------------
  // Launch arguments
  // ---------------------------------------------------------------------------
  const launchArgs: string[] = [];

  // Stealth: Disable automation indicators
  if (config.stealth) {
    launchArgs.push('--disable-blink-features=AutomationControlled');
  }

  // Window size: Fixed for headless, maximized for visible
  // Tip: Use Win+Left or Win+Right to snap browser to half-screen
  if (config.headless) {
    launchArgs.push('--window-size=1920,1080');
  } else {
    launchArgs.push('--start-maximized');
  }

  const stealthInitScript = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `;

  // Common context options - use null viewport for responsive behavior
  const contextOptions = {
    viewport: null as null, // Responsive - content reflows when window resizes
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
      args: launchArgs,
      ...contextOptions,
    });

    // For persistent context, browser() returns the browser instance
    browser = context.browser()!;

    // Use existing page or create new one
    page = context.pages()[0] || (await context.newPage());

    console.log(`🌐 Browser launched (profile: ${config.profilePath})`);
  } else {
    // Ephemeral: fresh browser each time
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
      args: launchArgs,
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
  page.setDefaultTimeout(config.timeoutDefault);

  // ---------------------------------------------------------------------------
  // Set up dialog handler
  // ---------------------------------------------------------------------------
  // Automatically accept all dialogs (alerts, confirms, prompts)
  // This prevents the browser from blocking indefinitely
  page.on('dialog', async (dialog) => {
    console.log(
      `💬 Dialog (${dialog.type()}): "${dialog.message()}" → auto-accepted`,
    );
    await dialog.accept();
  });

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
  // Normalize URL logic
  let targetUrl = url.trim();

  // If no protocol is provided, default to https://
  // Allow: http://, https://, file://, about:
  if (!/^(https?|file):\/\//i.test(targetUrl) && !targetUrl.startsWith('about:')) {
    targetUrl = `https://${targetUrl}`;
  }

  console.log(`📍 Navigating to: ${targetUrl}`);

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
  //
  // 'commit'           - Wait until the response is committed (headers received)
  //                      Useful if we just want to start executing fast

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    // Uses navigation-specific timeout from sessionBrowserConfig (set in launchBrowser)
    timeout: sessionBrowserConfig.timeoutNavigation,
  });

  // Give JavaScript a moment to run after DOM is ready.
  // Many sites load content dynamically after DOMContentLoaded.
  // Uses postNavDelay from sessionBrowserConfig for configurable wait time.
  await page.waitForTimeout(sessionBrowserConfig.postNavDelay);

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
