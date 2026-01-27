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
import type { Action, ElementInfo, ExecuteResult, DownloadInfo } from './types/index.js';
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

      case 'select':
        return await executeSelect(page, action, elements, verbose);

      case 'checkbox':
        return await executeCheckbox(page, action, elements, verbose);

      case 'drag':
        return await executeDrag(page, action, elements, verbose);

      case 'multi_click':
        return await executeMultiClick(page, action, elements, verbose);

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
    
    try {
      await locator.click({
        timeout: 5000,
        position: { x: offsetX, y: offsetY },
      });
    } catch (firstError) {
      const msg = firstError instanceof Error ? firstError.message : String(firstError);
      
      // If timeout or not visible, try scrolling explicitly and retrying
      if (msg.includes('Timeout') || msg.includes('visible') || msg.includes('outside the bounds')) {
         if (verbose) console.log(`   ⚠️ Click failed (${msg}). Attempting explicit scroll & retry...`);
         
         await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
         await page.waitForTimeout(500);
         
         // Retry click (listeners are still active for ~1s? No, they might have timed out.)
         // We must depend on the original PROMISES if they are long-lived, or create new ones?
         // The original listeners had 1s timeout to resolve(null). They are likely dead.
         // We need new listeners for the retry.
         
         const retryPagePromise = new Promise<Page | null>((resolve) => {
            const t = setTimeout(() => resolve(null), 2000); 
            context.once('page', (p) => { clearTimeout(t); resolve(p); });
         });
         const retryDlPromise = new Promise<Download | null>((resolve) => {
            const t = setTimeout(() => resolve(null), 2000); 
            page.once('download', (d) => { clearTimeout(t); resolve(d); });
         });
         
         // Retry the click
         await locator.click({ timeout: 5000 });
         
         // Update the result variables to capture from retry
         newPage = await retryPagePromise;
         download = await retryDlPromise;
         
      } else {
         throw firstError; // Re-throw if not a scrollable issue (e.g. obscured)
      }
    }

    // Check if a new tab was opened (from either attempt)
    // NOTE: If first attempt failed, newPage is null. If retry succeeded, we overwrote newPage.
    if (!newPage) newPage = await newPagePromise; // Fallback to original if not set (though original likely expired)
    
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
    if (!download) download = await downloadPromise;

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
// SELECT ACTION
// -----------------------------------------------------------------------------

/**
 * Select an option from a dropdown (<select> element).
 * Uses the `text` field as the value to select.
 */
async function executeSelect(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selector) {
    return {
      success: false,
      error: 'Select action requires a selector (element index)',
    };
  }

  if (!action.text) {
    return { success: false, error: 'Select action requires a value to select (use text field)' };
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

  if (verbose) {
    console.log(`📋 Selecting: [${index}] ${element.tag} -> "${action.text}"`);
  }

  const locator = getElementLocator(page, element);

  try {
    // Human-like interaction: move to element first
    if (!element.frameSelector) {
      await humanMouseMove(page, element.selector);
    }

    await locator.selectOption(action.text);
    await humanDelay(page, 200, 400);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Select failed';
    return { success: false, error: `Select failed: ${message}` };
  }
}

// -----------------------------------------------------------------------------
// CHECKBOX ACTION
// -----------------------------------------------------------------------------

/**
 * Toggle a checkbox or switch element.
 * Uses `text` field to specify desired state: 'check', 'uncheck', or 'toggle'.
 */
async function executeCheckbox(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selector) {
    return {
      success: false,
      error: 'Checkbox action requires a selector (element index)',
    };
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

  const desiredState = action.text?.toLowerCase() || 'toggle';
  if (verbose) {
    console.log(`☑️ Checkbox: [${index}] ${element.tag} -> ${desiredState}`);
  }

  const locator = getElementLocator(page, element);

  try {
    // Human-like interaction
    if (!element.frameSelector) {
      await humanMouseMove(page, element.selector);
    }

    if (desiredState === 'check') {
      await locator.check();
    } else if (desiredState === 'uncheck') {
      await locator.uncheck();
    } else {
      // Toggle: click to toggle current state
      await locator.click();
    }

    await humanDelay(page, 150, 300);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkbox toggle failed';
    return { success: false, error: `Checkbox failed: ${message}` };
  }
}

// -----------------------------------------------------------------------------
// DRAG ACTION
// -----------------------------------------------------------------------------

/**
 * Drag an element to another element.
 * Uses `selector` for the source element and `text` for the target element index.
 */
async function executeDrag(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selector) {
    return {
      success: false,
      error: 'Drag action requires a source selector (element index)',
    };
  }

  if (!action.text) {
    return {
      success: false,
      error: 'Drag action requires a target (use text field for target element index)',
    };
  }

  // Look up source element
  const sourceIndex = parseInt(action.selector, 10);
  const sourceElement = elements.find((el) => el.index === sourceIndex);

  // Look up target element
  const targetIndex = parseInt(action.text, 10);
  const targetElement = elements.find((el) => el.index === targetIndex);

  if (!sourceElement) {
    return {
      success: false,
      error: `Source element [${sourceIndex}] not found. Available: 1-${elements.length}`,
    };
  }

  if (!targetElement) {
    return {
      success: false,
      error: `Target element [${targetIndex}] not found. Available: 1-${elements.length}`,
    };
  }

  if (verbose) {
    console.log(`🔀 Dragging: [${sourceIndex}] "${sourceElement.text}" -> [${targetIndex}] "${targetElement.text}"`);
  }

  try {
    const sourceLocator = getElementLocator(page, sourceElement);
    const targetLocator = getElementLocator(page, targetElement);

    // Perform drag and drop
    await sourceLocator.dragTo(targetLocator);
    await humanDelay(page, 300, 500);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Drag failed';
    return { success: false, error: `Drag failed: ${message}` };
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
// MULTI-CLICK ACTION
// -----------------------------------------------------------------------------

/**
 * Click multiple elements in sequence.
 * Used for selecting multiple checkboxes at once.
 */
async function executeMultiClick(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.selectors || action.selectors.length === 0) {
    return {
      success: false,
      error: 'multi_click action requires selectors array',
    };
  }

  if (verbose) {
    console.log(`🖱️  Multi-clicking: [${action.selectors.join(', ')}]`);
  }

  const errors: string[] = [];
  let successCount = 0;

  for (const selectorStr of action.selectors) {
    const index = parseInt(selectorStr, 10);
    const element = elements.find((el) => el.index === index);

    if (!element) {
      errors.push(`Element [${index}] not found`);
      continue;
    }

    // Skip already-checked checkboxes (unless we want to uncheck? but usually multi_click is for selecting)
    if (element.attributes['checked'] === 'true') {
      if (verbose) {
        console.log(`   ⏭️ Skipping [${index}] - already checked`);
      }
      successCount++; // Count as success since it's in the desired state
      continue;
    }

    if (verbose) {
      console.log(`   🖱️ Clicking [${index}] ${element.tag} "${element.text}"`);
    }

    const locator = getElementLocator(page, element);

    try {
      // Standard click with 5s timeout
      await locator.click({ timeout: 5000 });
      // Brief pause for state to settle
      await page.waitForTimeout(500); 
      successCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Click failed';
      if (verbose) console.log(`   ⚠️ Standard click failed for [${index}]: ${message}. Trying JS fallback...`);
      
      // Try JS click fallback as it's more reliable for obscured/moving elements
      try {
        await locator.evaluate((el) => (el as HTMLElement).click());
        await page.waitForTimeout(500);
        successCount++;
        if (verbose) {
          console.log(`   ✓ JS click succeeded for [${index}]`);
        }
      } catch (jsError) {
        const jsMsg = jsError instanceof Error ? jsError.message : 'JS click failed';
        errors.push(`[${index}]: ${jsMsg}`);
      }
    }
  }

  // Multi-click is only a success if ALL requested elements were successfully handled
  if (successCount < action.selectors.length) {
    return {
      success: false,
      error: `Multi-click partially failed (${successCount}/${action.selectors.length}): ${errors.join('; ')}`,
    };
  }

  if (verbose) {
    console.log(`   ✅ Successfully clicked all ${successCount} elements`);
  }

  return { success: true };
}
