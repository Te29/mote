// =============================================================================
// ACT MODULE
// =============================================================================
//
// This module is the agent's "hands" - it executes the decisions made by
// the reason module by controlling the browser via Playwright.
//
// Key responsibilities:
// 1. Translate AI decisions into Playwright commands
// 2. Handle errors gracefully (elements not found, timeouts, etc.)
// 3. Provide utility functions for common patterns (pressKey, submitForm)
//
// Exported Functions:
// - executeAction(page, action, elements) - Execute a browser action
// - pressKey(page, key) - Press a keyboard key
// - submitForm(page, selector) - Submit a form by pressing Enter
// - hover(page, selector) - Hover over an element
// - selectOption(page, selector, value) - Select dropdown option
//
// =============================================================================

import type { Page, Download, Locator } from 'playwright';
import type { Action, ElementInfo, ExecuteResult, DownloadInfo } from './types.js';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as os from 'os';

// -----------------------------------------------------------------------------
// FRAME HELPERS
// -----------------------------------------------------------------------------

/**
 * Get a locator for an element, handling iframe context.
 * If the element is inside an iframe, returns a locator within that frame.
 * This is the key to supporting elements inside iframes (Stripe, Intercom, etc.)
 */
function getElementLocator(page: Page, element: ElementInfo): Locator {
  if (element.frameSelector) {
    // Element is inside an iframe - use frameLocator to access it
    return page.frameLocator(element.frameSelector).locator(element.selector);
  }
  // Element is in main frame
  return page.locator(element.selector);
}

// -----------------------------------------------------------------------------
// HUMAN-LIKE BEHAVIOR HELPERS
// -----------------------------------------------------------------------------

/**
 * Generate a random delay within a range to simulate human timing variability.
 */
function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a random duration to appear more human-like.
 */
async function humanDelay(page: Page, min = 100, max = 300): Promise<void> {
  await page.waitForTimeout(randomDelay(min, max));
}

/**
 * Move mouse to element with human-like curve before clicking.
 * Uses small random offset to avoid clicking exact center every time.
 */
async function humanMouseMove(page: Page, selector: string): Promise<void> {
  const element = await page.$(selector);
  if (!element) return;

  const box = await element.boundingBox();
  if (!box) return;

  // Calculate a point near center with slight randomness
  const offsetX = randomDelay(-5, 5);
  const offsetY = randomDelay(-3, 3);
  const targetX = box.x + box.width / 2 + offsetX;
  const targetY = box.y + box.height / 2 + offsetY;

  // Move mouse with steps to simulate natural movement
  await page.mouse.move(targetX, targetY, { steps: randomDelay(5, 15) });

  // Brief pause after moving, like a human would
  await humanDelay(page, 50, 150);
}

/**
 * Type text character by character with variable delays like a human typist.
 */
async function humanType(page: Page, text: string): Promise<void> {
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomDelay(30, 120) });
  }
}

// -----------------------------------------------------------------------------
// ELEMENT VERIFICATION
// -----------------------------------------------------------------------------

/**
 * Result of element verification.
 */
interface VerifyResult {
  valid: boolean;
  error?: string;
  currentText?: string;
  currentTag?: string;
}

/**
 * Verify that an element still matches its expected identity.
 * Prevents clicking the wrong element if DOM has shifted since observe().
 *
 * Checks:
 * - Element still exists at selector
 * - Tag name matches (button vs a vs input)
 * - Text content is similar (allows minor whitespace differences)
 */
async function verifyElement(
  page: Page,
  element: ElementInfo,
): Promise<VerifyResult> {
  try {
    const handle = await page.$(element.selector);

    if (!handle) {
      return {
        valid: false,
        error: `Element no longer exists at selector: ${element.selector}`,
      };
    }

    // Get current element properties
    const currentProps = await handle.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().substring(0, 100),
    }));

    // Check tag matches
    if (currentProps.tag !== element.tag) {
      return {
        valid: false,
        error: `Element tag changed: expected "${element.tag}", found "${currentProps.tag}"`,
        currentTag: currentProps.tag,
        currentText: currentProps.text,
      };
    }

    // Check text similarity (normalize whitespace for comparison)
    const expectedText = element.text.trim().toLowerCase();
    const actualText = currentProps.text.toLowerCase();

    // Allow exact match or if one contains the other (handles dynamic content)
    const textMatches =
      expectedText === actualText ||
      expectedText.includes(actualText) ||
      actualText.includes(expectedText) ||
      // Empty text is okay for inputs
      element.tag === 'input' ||
      element.tag === 'textarea';

    if (!textMatches && expectedText.length > 0) {
      return {
        valid: false,
        error: `Element text changed: expected "${element.text}", found "${currentProps.text}"`,
        currentTag: currentProps.tag,
        currentText: currentProps.text,
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to verify element: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTE FUNCTION
// -----------------------------------------------------------------------------

/**
 * Execute a browser action on the page.
 * This is the main function called by the agent loop.
 *
 * Handles WebAction types: click, type, scroll, navigate, wait.
 * HITL confirmation is handled in mote.ts - this module just executes.
 *
 * @param page - Playwright page object
 * @param action - The action to execute (from reason.ts)
 * @param elements - List of interactive elements (for index lookup)
 * @returns ExecuteResult with success status and optional error
 */
export async function executeAction(
  page: Page,
  action: Action,
  elements: ElementInfo[],
): Promise<ExecuteResult> {
  const verbose = process.env.VERBOSE === 'true';

  try {
    switch (action.type) {
      case 'click':
        return await executeClick(page, action, elements, verbose);

      case 'type':
        return await executeType(page, action, elements, verbose);

      case 'scroll':
        return await executeScroll(page, action, verbose);

      case 'navigate':
        return await executeNavigate(page, action, verbose);

      case 'wait':
        return await executeWait(page, verbose);

      case 'hover':
        return await executeHover(page, action, elements, verbose);

      default:
        // TypeScript exhaustiveness check
        const _exhaustive: never = action.type;
        return {
          success: false,
          error: `Unknown action type: ${_exhaustive}`,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`❌ Action failed: ${message}`);
    return { success: false, error: message };
  }
}

// -----------------------------------------------------------------------------
// CLICK ACTION
// -----------------------------------------------------------------------------

/**
 * Click on an element.
 * The selector is an element INDEX (1, 2, 3...) that we look up in the elements list.
 */
async function executeClick(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selector) {
    return {
      success: false,
      error: 'Click action requires a selector (element index)',
    };
  }

  // Look up the element by index
  const index = parseInt(action.selector, 10);
  const element = elements.find((el) => el.index === index);

  if (!element) {
    return {
      success: false,
      error: `Element [${index}] not found. Available: 1-${elements.length}`,
    };
  }

  const isInIframe = !!element.frameSelector;
  if (verbose) {
    console.log(`🖱️  Clicking: [${index}] ${element.tag} "${element.text}"`);
    console.log(`   Selector: ${element.selector}`);
    if (isInIframe) {
      console.log(`   Frame: ${element.frameSelector}`);
    }
  }

  // Verify element identity before clicking (prevents clicking wrong element if DOM shifted)
  // Skip verification for iframe elements (verification doesn't support frames yet)
  if (!isInIframe) {
    const verification = await verifyElement(page, element);
    if (!verification.valid) {
      return {
        success: false,
        error: `Element verification failed: ${verification.error}. Page may have changed - re-observe recommended.`,
      };
    }
  }

  // Get the locator (handles iframe context automatically)
  const locator = getElementLocator(page, element);

  try {
    // Human-like click sequence:
    // 1. Move mouse to element with natural movement (main frame only)
    // 2. Brief pause before clicking (like a human aiming)
    // 3. Click with slight position randomness
    // 4. Handle new tab if target="_blank"
    // 5. Handle file downloads
    // 6. Random delay after click

    // Move mouse to element first (human-like) - only for main frame elements
    // Mouse movement across iframe boundaries is complex, skip for iframe elements
    if (!isInIframe) {
      await humanMouseMove(page, element.selector);
    }

    // Set up listener for new tabs BEFORE clicking
    const context = page.context();
    let newPage: Page | null = null;
    let download: Download | null = null;

    const newPagePromise = new Promise<Page | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 1000); // 1s timeout
      context.once('page', (page) => {
        clearTimeout(timeout);
        resolve(page);
      });
    });

    // Set up listener for downloads BEFORE clicking
    const downloadPromise = new Promise<Download | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 1000); // 1s timeout
      page.once('download', (dl) => {
        clearTimeout(timeout);
        resolve(dl);
      });
    });

    // Click using locator (works for both main frame and iframe elements)
    const offsetX = randomDelay(-3, 3);
    const offsetY = randomDelay(-2, 2);
    await locator.click({
      timeout: 5000,
      position: { x: offsetX, y: offsetY },
    });

    // Check if a new tab was opened
    newPage = await newPagePromise;

    if (newPage) {
      // Wait for new tab to load
      if (verbose) {
        console.log(`   📑 New tab opened: ${newPage.url()}`);
      }
      try {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
      } catch {
        // Timeout is okay - page might be slow
      }
      await humanDelay(newPage, 400, 800);
      return { success: true, newPage };
    }

    // Check if a download was triggered
    download = await downloadPromise;

    if (download) {
      // Save download to a temp directory
      const downloadsDir = path.join(os.tmpdir(), 'mote-downloads');
      const suggestedFilename = download.suggestedFilename();
      const savePath = path.join(downloadsDir, suggestedFilename);

      if (verbose) {
        console.log(`   📥 Download started: ${suggestedFilename}`);
      }

      try {
        await download.saveAs(savePath);
        if (verbose) {
          console.log(`   ✓ Downloaded to: ${savePath}`);
        }

        const downloadInfo: DownloadInfo = {
          suggestedFilename,
          path: savePath,
          url: download.url(),
        };

        return { success: true, download: downloadInfo };
      } catch (dlError) {
        const dlMessage =
          dlError instanceof Error ? dlError.message : 'Download failed';
        if (verbose) {
          console.log(`   ⚠️ Download failed: ${dlMessage}`);
        }
        // Still return success for the click, but note download failure
        return {
          success: true,
          error: `Click succeeded but download failed: ${dlMessage}`,
        };
      }
    }

    // Wait for any page updates after clicking (variable delay)
    await humanDelay(page, 400, 800);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Click failed';

    // Check if it's an "element is obscured" error - try JS click fallback
    const isObscured =
      message.includes('intercept') ||
      message.includes('obscured') ||
      message.includes('other element') ||
      message.includes('pointer events');

    if (isObscured) {
      if (verbose) {
        console.log(`   ⚠️ Element obscured, trying JS click fallback...`);
      }

      try {
        // Nuclear option: force click via JavaScript
        // This bypasses Playwright's visibility checks
        // Use locator.evaluate for iframe support
        await locator.evaluate((el) => {
          (el as HTMLElement).click();
        });

        // Wait for any page updates
        await humanDelay(page, 400, 800);

        if (verbose) {
          console.log(`   ✓ JS click succeeded`);
        }
        return { success: true };
      } catch (jsError) {
        const jsMessage =
          jsError instanceof Error ? jsError.message : 'JS click failed';
        return {
          success: false,
          error: `Click failed (element obscured), JS fallback also failed: ${jsMessage}`,
        };
      }
    }

    if (message.includes('Timeout')) {
      return {
        success: false,
        error: `Could not click element [${index}]: timed out waiting for element`,
      };
    }

    return { success: false, error: `Click failed: ${message}` };
  }
}

// -----------------------------------------------------------------------------
// TYPE ACTION
// -----------------------------------------------------------------------------

/**
 * Type text into an input element.
 */
async function executeType(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selector) {
    return {
      success: false,
      error: 'Type action requires a selector (element index)',
    };
  }

  if (!action.text) {
    return { success: false, error: 'Type action requires text to type' };
  }

  // Look up element
  const index = parseInt(action.selector, 10);
  const element = elements.find((el) => el.index === index);

  if (!element) {
    return {
      success: false,
      error: `Element [${index}] not found. Available: 1-${elements.length}`,
    };
  }

  const isInIframe = !!element.frameSelector;
  if (verbose) {
    console.log(`⌨️  Typing into: [${index}] ${element.tag} "${element.text}"`);
    console.log(`   Text: "${action.text}"`);
    if (isInIframe) {
      console.log(`   Frame: ${element.frameSelector}`);
    }
  }

  // Verify element identity before typing (prevents typing into wrong field if DOM shifted)
  // Skip verification for iframe elements (verification doesn't support frames yet)
  if (!isInIframe) {
    const verification = await verifyElement(page, element);
    if (!verification.valid) {
      return {
        success: false,
        error: `Element verification failed: ${verification.error}. Page may have changed - re-observe recommended.`,
      };
    }
  }

  // Get the locator (handles iframe context automatically)
  const locator = getElementLocator(page, element);

  try {
    // Human-like typing sequence:
    // 1. Move mouse to element naturally (main frame only)
    // 2. Click to focus (with slight position randomness)
    // 3. Clear existing content
    // 4. Type character by character with variable delays

    // Move mouse to input field first (main frame only)
    if (!isInIframe) {
      await humanMouseMove(page, element.selector);
    }

    // Click to focus with position randomness
    // Use try-catch to handle obscured elements (like Google's search overlay)
    const offsetX = randomDelay(-3, 3);
    const offsetY = randomDelay(-2, 2);
    try {
      await locator.click({
        position: { x: offsetX, y: offsetY },
        timeout: 5000,
      });
    } catch (clickError) {
      const clickMessage =
        clickError instanceof Error ? clickError.message : 'Click failed';

      // Check if element is obscured - try JS focus/click fallback
      const isObscured =
        clickMessage.includes('intercept') ||
        clickMessage.includes('obscured') ||
        clickMessage.includes('other element') ||
        clickMessage.includes('pointer events');

      if (isObscured) {
        if (verbose) {
          console.log(`   ⚠️ Input obscured, trying JS focus fallback...`);
        }
        // Focus the element directly via JavaScript (works with iframes via locator)
        await locator.evaluate((el) => {
          (el as HTMLElement).focus();
          (el as HTMLElement).click();
        });
      } else {
        throw clickError; // Re-throw if not an obscured element issue
      }
    }

    // Brief pause before typing (like a human preparing to type)
    await humanDelay(page, 100, 250);

    // Clear existing content with Ctrl+A then Backspace (more human than triple-click)
    await page.keyboard.press('Control+a');
    await humanDelay(page, 50, 100);
    await page.keyboard.press('Backspace');
    await humanDelay(page, 100, 200);

    // Type text character by character with human-like delays
    await humanType(page, action.text);

    // Wait for input handlers to process (variable delay)
    await humanDelay(page, 200, 500);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Type failed';
    return { success: false, error: `Type failed: ${message}` };
  }
}

// -----------------------------------------------------------------------------
// SCROLL ACTION
// -----------------------------------------------------------------------------

/**
 * Scroll the page up or down.
 */
async function executeScroll(
  page: Page,
  action: Action,
  verbose: boolean,
): Promise<ExecuteResult> {
  const direction = action.text?.toLowerCase() || 'down';

  if (verbose) {
    console.log(`📜 Scrolling: ${direction}`);
  }

  // Human-like scroll: variable amount and smooth behavior
  const baseAmount = direction === 'up' ? -400 : 400;
  const scrollAmount = baseAmount + randomDelay(-100, 100); // Add variability

  // Use smooth scrolling to appear more natural
  await page.evaluate((amount) => {
    window.scrollBy({
      top: amount,
      behavior: 'smooth',
    });
  }, scrollAmount);

  // Wait for smooth scroll animation and any lazy-loaded content
  await humanDelay(page, 400, 700);

  return { success: true };
}

// -----------------------------------------------------------------------------
// NAVIGATE ACTION
// -----------------------------------------------------------------------------

/**
 * Navigate to a new URL.
 */
async function executeNavigate(
  page: Page,
  action: Action,
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.text) {
    return { success: false, error: 'Navigate action requires a URL' };
  }

  let url = action.text;

  // Add https:// if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  if (verbose) {
    console.log(`🌐 Navigating to: ${url}`);
  }

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for page to settle
    await page.waitForTimeout(1000);

    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Navigation failed';
    return { success: false, error: `Navigation failed: ${message}` };
  }
}

// -----------------------------------------------------------------------------
// WAIT ACTION
// -----------------------------------------------------------------------------

/**
 * Wait for the page to update.
 * Useful when expecting dynamic content to load.
 */
async function executeWait(
  page: Page,
  verbose: boolean,
): Promise<ExecuteResult> {
  if (verbose) {
    console.log(`⏳ Waiting for page to update...`);
  }

  // Wait up to 5s for network to be idle (no requests for 500ms)
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // Timeout is okay - maybe there's no network activity
  }

  // Additional wait for dynamic content
  await page.waitForTimeout(1000);

  return { success: true };
}

// -----------------------------------------------------------------------------
// HOVER ACTION
// -----------------------------------------------------------------------------

/**
 * Hover over an element to trigger dropdowns, tooltips, or reveal hidden content.
 */
async function executeHover(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selector) {
    return {
      success: false,
      error: 'Hover action requires a selector (element index)',
    };
  }

  // Look up the element by index
  const index = parseInt(action.selector, 10);
  const element = elements.find((el) => el.index === index);

  if (!element) {
    return {
      success: false,
      error: `Element [${index}] not found. Available: 1-${elements.length}`,
    };
  }

  if (verbose) {
    console.log(`🎯 Hovering: [${index}] ${element.tag} "${element.text}"`);
    console.log(`   Selector: ${element.selector}`);
  }

  // Verify element identity before hovering (prevents hovering wrong element if DOM shifted)
  const verification = await verifyElement(page, element);
  if (!verification.valid) {
    return {
      success: false,
      error: `Element verification failed: ${verification.error}. Page may have changed - re-observe recommended.`,
    };
  }

  try {
    // Human-like hover sequence:
    // 1. Move mouse naturally to element
    // 2. Pause to let dropdown/tooltip appear

    await humanMouseMove(page, element.selector);
    await page.hover(element.selector);

    // Wait for any hover-triggered content to appear
    await humanDelay(page, 300, 600);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Hover failed';
    return { success: false, error: `Hover failed: ${message}` };
  }
}

// -----------------------------------------------------------------------------
// UTILITY: PRESS KEY
// -----------------------------------------------------------------------------

/**
 * Press a keyboard key (Enter, Escape, Tab, etc.)
 * Used after typing in search boxes to submit.
 * Includes human-like delay before and after keypress.
 */
export async function pressKey(page: Page, key: string): Promise<void> {
  // Brief pause before pressing (like a human thinking)
  await humanDelay(page, 50, 150);
  await page.keyboard.press(key);
  // Brief pause after pressing
  await humanDelay(page, 100, 200);
}

// -----------------------------------------------------------------------------
// UTILITY: SUBMIT FORM
// -----------------------------------------------------------------------------

/**
 * Submit a form by pressing Enter in the focused element.
 * Common pattern for search boxes.
 * Includes human-like delays.
 */
export async function submitForm(page: Page, selector: string): Promise<void> {
  await page.focus(selector);
  await humanDelay(page, 100, 300);
  await page.keyboard.press('Enter');
  await humanDelay(page, 800, 1200);
}

// -----------------------------------------------------------------------------
// UTILITY: HOVER
// -----------------------------------------------------------------------------

/**
 * Hover over an element.
 * Useful for triggering dropdown menus or tooltips.
 * Uses human-like mouse movement.
 */
export async function hover(page: Page, selector: string): Promise<void> {
  await humanMouseMove(page, selector);
  await page.hover(selector);
  await humanDelay(page, 200, 400);
}

// -----------------------------------------------------------------------------
// UTILITY: SELECT OPTION
// -----------------------------------------------------------------------------

/**
 * Select an option from a <select> dropdown.
 * Includes human-like interaction pattern.
 */
export async function selectOption(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  // Move to dropdown first
  await humanMouseMove(page, selector);
  await humanDelay(page, 50, 150);
  await page.selectOption(selector, value);
  await humanDelay(page, 200, 400);
}

// -----------------------------------------------------------------------------
// TEST: Run this file directly
// -----------------------------------------------------------------------------
// Usage: npm run test:act (shortcut for npx tsx src/act.ts)

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('🧪 Testing act module...\n');

  // Import browser module for testing
  const { launchBrowser, navigateTo, closeBrowser } =
    await import('./browser.js');
  const { observe } = await import('./observe.js');

  const session = await launchBrowser({
    headless: false,
    slowMo: 100,
    stealth: true,
    profilePath: './mote-profile',
    timeout: {
      default: 10000,
      navigation: 10000,
      element: 5000,
      postNavDelay: 500,
    },
  });

  try {
    await navigateTo(session.page, 'https://www.google.com');

    // Observe to get elements
    const state = await observe(session.page);
    console.log(`\n🎯 Found ${state.elements.length} interactive elements`);

    // Find the search input
    const searchInput = state.elements.find(
      (el) =>
        el.tag === 'textarea' ||
        (el.tag === 'input' && el.attributes.name === 'q'),
    );

    if (searchInput) {
      console.log(
        `\n🔍 Found search input: [${searchInput.index}] "${searchInput.text}"`,
      );

      // Test type action
      const typeAction: Action = {
        type: 'type',
        selector: searchInput.index.toString(),
        text: 'Thanks for using Mote! Please star the repo if you find it useful. 🌟 https://github.com/Te29/mote',
        reason: 'Test typing into search box',
      };

      // Execute directly (no confirmation in act.ts anymore)
      const result = await executeAction(
        session.page,
        typeAction,
        state.elements,
      );

      console.log(`\n📋 Result: ${result.success ? 'Success' : 'Failed'}`);
      if (result.error) console.log(`   Error: ${result.error}`);

      // Test press Enter
      if (result.success) {
        console.log('\n⏎ Pressing Enter...');
        await pressKey(session.page, 'Enter');
        await session.page.waitForTimeout(10000);
        console.log(`   New URL: ${session.page.url()}`);
      }
    } else {
      console.log('❌ Could not find search input');
    }
  } finally {
    await closeBrowser(session.browser);
  }

  console.log('\n✅ Act test complete!');
}
