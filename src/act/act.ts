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

import type { Page, Download, Frame, Locator } from 'playwright';
import type { Action, ElementInfo, ExecuteResult, DownloadInfo } from '../types/index.js';
import * as path from 'path';
import * as os from 'os';
import { getElementLocator, getElementContext, randomDelay, humanDelay, humanMouseMove, humanType } from './helpers.js';
import { verifyOrResolve } from './element-resolution.js';

// -----------------------------------------------------------------------------
// AUTO-SCROLL HELPER
// -----------------------------------------------------------------------------

/**
 * Proactively scroll an element into view before performing actions.
 * This prevents the LLM from needing to decide between scroll vs click,
 * eliminating the "scroll-then-click" pattern that breaks tracker sync.
 *
 * @param locator - Playwright locator for the element
 * @param verbose - Whether to log the scroll action
 * @returns true if scroll was performed, false if element was already visible
 */
async function ensureElementVisible(locator: Locator, verbose: boolean): Promise<boolean> {
  try {
    // Check if element is already in viewport
    const isVisible = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const viewHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewWidth = window.innerWidth || document.documentElement.clientWidth;

      // Element is considered visible if at least partially in viewport
      return (
        rect.top < viewHeight &&
        rect.bottom > 0 &&
        rect.left < viewWidth &&
        rect.right > 0
      );
    }).catch(() => false);

    if (!isVisible) {
      if (verbose) {
        console.log(`   📜 Auto-scrolling element into view...`);
      }
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      // Brief settle time after scroll
      await new Promise(resolve => setTimeout(resolve, 150));
      return true;
    }

    return false;
  } catch {
    // If check fails, try to scroll anyway (element might still be valid)
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      return true;
    } catch {
      return false;
    }
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
        return await executeScroll(page, action, elements, verbose);

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
  if (!action.elementId) {
    return {
      success: false,
      error: 'Click action requires an elementId (element index)',
    };
  }

  // Look up the element by index
  const index = parseInt(action.elementId, 10);
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
  // Now supports iframes via frame-aware verifyElement
  let resolvedElement = element;
  
  const result = await verifyOrResolve(page, element);
  if (!result.valid) {
    return {
      success: false,
      error: `Element verification failed: ${result.error}. Page may have changed - re-observe recommended.`,
    };
  }
  resolvedElement = result.element;

  // Get the locator (handles iframe context automatically)
  const locator = getElementLocator(page, resolvedElement);

  try {
    // Human-like click sequence:
    // 1. Auto-scroll element into view (prevents scroll-then-click pattern)
    // 2. Move mouse to element with natural movement
    // 3. Brief pause before clicking (like a human aiming)
    // 4. Click with slight position randomness
    // 5. Handle new tabs/downloads

    // Proactively scroll element into view
    await ensureElementVisible(locator, verbose);

    // Move mouse to element first (human-like)
    await humanMouseMove(page, resolvedElement);

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
         
         // Retry click with new listeners if needed (omitted for brevity, relying on standard retry)
         await locator.click({ timeout: 5000 });
      } else {
         throw firstError; // Re-throw if not a scrollable issue (e.g. obscured)
      }
    }

    // Check if a new tab was opened
    if (!newPage) newPage = await newPagePromise;
    
    if (newPage) {
      if (verbose) {
        console.log(`   📑 New tab opened: ${newPage.url()}`);
      }
      try {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
      } catch {
        // Timeout is okay
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
        await locator.evaluate((el) => {
          (el as HTMLElement).click();
        });

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
  if (!action.elementId) {
    return {
      success: false,
      error: 'Type action requires an elementId (element index)',
    };
  }

  if (!action.text) {
    return { success: false, error: 'Type action requires text to type' };
  }

  // Look up element
  const index = parseInt(action.elementId, 10);
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

  // Verify element identity
  let resolvedElement = element;

  const result = await verifyOrResolve(page, element);
  if (!result.valid) {
    return {
      success: false,
      error: `Element verification failed: ${result.error}. Page may have changed - re-observe recommended.`,
    };
  }
  resolvedElement = result.element;

  // Get the locator
  const locator = getElementLocator(page, resolvedElement);

  try {
    // Proactively scroll element into view
    await ensureElementVisible(locator, verbose);

    // Human-like typing sequence
    await humanMouseMove(page, resolvedElement);

    // Click to focus with position randomness
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
        // Focus the element directly via JavaScript
        await locator.evaluate((el) => {
          (el as HTMLElement).focus();
          (el as HTMLElement).click();
        });
      } else {
        throw clickError; // Re-throw
      }
    }

    // Brief pause before typing
    await humanDelay(page, 100, 250);

    // Clear existing content
    await page.keyboard.press('Control+a');
    await humanDelay(page, 50, 100);
    await page.keyboard.press('Backspace');
    await humanDelay(page, 100, 200);

    // Type text character by character
    await humanType(page, action.text);

    // Wait for input handlers to process
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
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  const direction = action.text?.toLowerCase() || 'down';

  if (verbose) {
    console.log(`📜 Scrolling: ${direction}`);
  }

  // Human-like scroll: variable amount and smooth behavior
  const baseAmount = direction === 'up' ? -400 : 400;
  const scrollAmount = baseAmount + randomDelay(-100, 100);

  // Determine context: Main Page or Iframe?
  let context: Page | Frame = page;

  // If action targets an element, use its frame
  if (action.elementId) {
    const index = parseInt(action.elementId, 10);
    const element = elements.find((el) => el.index === index);
    if (element) {
      context = await getElementContext(page, element);
      if (verbose && context !== page) {
        console.log(`   📜 Scrolling inside iframe containing: [${index}] ${element.tag}`);
      }
    }
  }

  // Detect scrollable container
  let scrolledContainer = false;

  if (action.elementId) {
    const index = parseInt(action.elementId, 10);
    const element = elements.find((el) => el.index === index);
    if (element) {
      const locator = getElementLocator(page, element);
      try {
        scrolledContainer = await locator.evaluate((el, amt) => {
          // Walk up to find the nearest scrollable ancestor
          let parent = el.parentElement;
          while (parent && parent !== document.body && parent !== document.documentElement) {
            const style = window.getComputedStyle(parent);
            const overflowY = style.overflowY;
            if (
              (overflowY === 'auto' || overflowY === 'scroll') &&
              parent.scrollHeight > parent.clientHeight
            ) {
              parent.scrollBy({ top: amt, behavior: 'smooth' });
              return true;
            }
            parent = parent.parentElement;
          }
          return false;
        }, scrollAmount);
      } catch {
        // Element not found or evaluate failed
      }
    }
  }

  if (!scrolledContainer) {
    // Default: scroll the window (or frame document)
    await context.evaluate((amount) => {
      window.scrollBy({
        top: amount,
        behavior: 'smooth',
      });
    }, scrollAmount);
  }

  // Wait for smooth scroll animation
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
 */
async function executeWait(
  page: Page,
  verbose: boolean,
): Promise<ExecuteResult> {
  if (verbose) {
    console.log(`⏳ Waiting for page to update...`);
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // Timeout is okay
  }

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
  if (!action.elementId) {
    return {
      success: false,
      error: 'Hover action requires an elementId (element index)',
    };
  }

  const index = parseInt(action.elementId, 10);
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

  let resolvedElement = element;
  const result = await verifyOrResolve(page, element);
  if (!result.valid) {
    return {
      success: false,
      error: `Element verification failed: ${result.error}. Page may have changed - re-observe recommended.`,
    };
  }
  resolvedElement = result.element;

  try {
    const locator = getElementLocator(page, resolvedElement);

    // Ensure element is scrolled into view before hovering.
    // locator.hover() auto-scrolls within its own frame, but when the element
    // is inside an iframe that is itself off-screen in the main page, the outer
    // scroll doesn't happen automatically.
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

    await humanMouseMove(page, resolvedElement);
    await locator.hover({ timeout: 5000 });

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
 */
async function executeSelect(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.elementId) {
    return {
      success: false,
      error: 'Select action requires an elementId (element index)',
    };
  }

  if (!action.text) {
    return { success: false, error: 'Select action requires a value to select (use text field)' };
  }

  const index = parseInt(action.elementId, 10);
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
    // Proactively scroll element into view
    await ensureElementVisible(locator, verbose);

    await humanMouseMove(page, element);

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
 */
async function executeCheckbox(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.elementId) {
    return {
      success: false,
      error: 'Checkbox action requires an elementId (element index)',
    };
  }

  const index = parseInt(action.elementId, 10);
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
    // Proactively scroll element into view
    await ensureElementVisible(locator, verbose);

    await humanMouseMove(page, element);

    if (desiredState === 'check') {
      await locator.check();
    } else if (desiredState === 'uncheck') {
      await locator.uncheck();
    } else {
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
 */
async function executeDrag(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.elementId) {
    return {
      success: false,
      error: 'Drag action requires a source elementId (element index)',
    };
  }

  if (!action.text) {
    return {
      success: false,
      error: 'Drag action requires a target (use text field for target element index)',
    };
  }

  const sourceIndex = parseInt(action.elementId, 10);
  const sourceElement = elements.find((el) => el.index === sourceIndex);

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

  // Verify both elements still exist
  const sourceResult = await verifyOrResolve(page, sourceElement);
  if (!sourceResult.valid) {
    return {
      success: false,
      error: `Source element verification failed: ${sourceResult.error}. Page may have changed - re-observe recommended.`,
    };
  }
  const resolvedSource = sourceResult.element;

  const targetResult = await verifyOrResolve(page, targetElement);
  if (!targetResult.valid) {
    return {
      success: false,
      error: `Target element verification failed: ${targetResult.error}. Page may have changed - re-observe recommended.`,
    };
  }
  const resolvedTarget = targetResult.element;

  try {
    const sourceLocator = getElementLocator(page, resolvedSource);
    const targetLocator = getElementLocator(page, resolvedTarget);

    // Ensure source element is visible
    await sourceLocator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

    // Check if source uses HTML5 draggable attribute — if so, Playwright's
    // mouse-based dragTo() won't fire the required dragstart/dragover/drop
    // events. Dispatch them manually via JavaScript instead.
    const isDraggable = await sourceLocator.evaluate(
      (el) => el.getAttribute('draggable') === 'true',
    );

    if (isDraggable) {
      if (verbose) {
        console.log(`   📦 Source has draggable="true", using HTML5 drag events`);
      }

      await sourceLocator.evaluate((src, targetSel) => {
        const target = document.querySelector(targetSel);
        if (!target) throw new Error('Drag target not found');

        const dataTransfer = new DataTransfer();

        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      }, resolvedTarget.selector);
    } else {
      // Non-HTML5 drag: use Playwright's mouse-based dragTo
      await sourceLocator.dragTo(targetLocator);
    }

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
 */
export async function pressKey(page: Page, key: string): Promise<void> {
  await humanDelay(page, 50, 150);
  await page.keyboard.press(key);
  await humanDelay(page, 100, 200);
}

// -----------------------------------------------------------------------------
// UTILITY: SUBMIT FORM
// -----------------------------------------------------------------------------

/**
 * Submit a form by pressing Enter in the focused element.
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
 */
export async function hover(page: Page, element: ElementInfo): Promise<void> {
  await humanMouseMove(page, element);
  
  const locator = getElementLocator(page, element);
  await locator.hover();
  
  await humanDelay(page, 200, 400);
}

// -----------------------------------------------------------------------------
// UTILITY: SELECT OPTION
// -----------------------------------------------------------------------------

/**
 * Select an option from a <select> dropdown.
 */
export async function selectOption(
  page: Page,
  element: ElementInfo,
  value: string,
): Promise<void> {
  await humanMouseMove(page, element);
  await humanDelay(page, 50, 150);
  
  const locator = getElementLocator(page, element);
  await locator.selectOption(value);
  
  await humanDelay(page, 200, 400);
}

// -----------------------------------------------------------------------------
// MULTI-CLICK ACTION
// -----------------------------------------------------------------------------

/**
 * Click multiple elements in sequence.
 */
async function executeMultiClick(
  page: Page,
  action: Action,
  elements: ElementInfo[],
  verbose: boolean,
): Promise<ExecuteResult> {
  if (!action.elementIds || action.elementIds.length === 0) {
    return {
      success: false,
      error: 'multi_click action requires elementIds array',
    };
  }

  if (verbose) {
    console.log(`🖱️  Multi-clicking: [${action.elementIds.join(', ')}]`);
  }

  const errors: string[] = [];
  let successCount = 0;

  for (const selectorStr of action.elementIds) {
    const index = parseInt(selectorStr, 10);
    const element = elements.find((el) => el.index === index);

    if (!element) {
      errors.push(`Element [${index}] not found`);
      continue;
    }

    if (element.attributes['checked'] === 'true') {
      if (verbose) {
        console.log(`   ⏭️ Skipping [${index}] - already checked`);
      }
      successCount++;
      continue;
    }

    if (verbose) {
      console.log(`   🖱️ Clicking [${index}] ${element.tag} "${element.text}"`);
    }

    let resolvedElement = element;
    const result = await verifyOrResolve(page, element);
    if (!result.valid) {
      if (verbose) console.log(`   ⚠️ Verification failed for [${index}]: ${result.error}`);
      errors.push(`[${index}]: Verification failed`);
      continue;
    }
    resolvedElement = result.element;

    const locator = getElementLocator(page, resolvedElement);

    try {
      // Proactively scroll element into view
      await ensureElementVisible(locator, verbose);

      await humanMouseMove(page, resolvedElement);

      await locator.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      successCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Click failed';
      if (verbose) console.log(`   ⚠️ Standard click failed for [${index}]: ${message}. Trying JS fallback...`);
      
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

  if (successCount < action.elementIds.length) {
    return {
      success: false,
      error: `Multi-click partially failed (${successCount}/${action.elementIds.length}): ${errors.join('; ')}`,
    };
  }

  if (verbose) {
    console.log(`   ✅ Successfully clicked all ${successCount} elements`);
  }

  return { success: true };
}
