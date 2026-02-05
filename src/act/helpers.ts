// =============================================================================
// ACT HELPERS
// =============================================================================
// Low-level utilities for frame resolution and human-like behavior.

import type { Page, Locator, Frame } from 'playwright';
import type { ElementInfo } from '../types/index.js';

// -----------------------------------------------------------------------------
// FRAME HELPERS
// -----------------------------------------------------------------------------

/**
 * Get a locator for an element, handling iframe context.
 * If the element is inside an iframe, returns a locator within that frame.
 * This is the key to supporting elements inside iframes (Stripe, Intercom, etc.)
 */
export function getElementLocator(page: Page, element: ElementInfo): Locator {
  if (element.frameSelector) {
    // Element is inside an iframe - use frameLocator to access it
    return page.frameLocator(element.frameSelector).locator(element.selector);
  }
  // Element is in main frame
  return page.locator(element.selector);
}

/**
 * Resolve the execution context (Page or Frame) for an element.
 * If the element lives inside an iframe, returns that iframe's Frame object.
 * Falls back to the page if the frame cannot be resolved.
 */
export async function getElementContext(page: Page, element: ElementInfo): Promise<Page | Frame> {
  if (element.frameSelector) {
    const frameLocator = page.frameLocator(element.frameSelector);
    // Use locator.owner() to get a FrameLocator's underlying frame reliably
    // We query any element inside the frame to obtain the Frame reference
    try {
      const handle = await frameLocator.locator(':root').elementHandle({ timeout: 2000 });
      if (handle) {
        const ownerFrame = await handle.ownerFrame();
        if (ownerFrame) return ownerFrame;
      }
    } catch {
      // Frame not available — fall back to page context
    }
  }
  return page;
}

// -----------------------------------------------------------------------------
// HUMAN-LIKE BEHAVIOR HELPERS
// -----------------------------------------------------------------------------

/**
 * Generate a random delay within a range to simulate human timing variability.
 */
export function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleep for a random duration to appear more human-like.
 */
export async function humanDelay(page: Page, min = 100, max = 300): Promise<void> {
  await page.waitForTimeout(randomDelay(min, max));
}

/**
 * Move mouse to element with human-like curve before clicking.
 * Uses small random offset to avoid clicking exact center every time.
 * Now supports iframes via Locator.boundingBox().
 */
export async function humanMouseMove(page: Page, element: ElementInfo): Promise<void> {
  const locator = getElementLocator(page, element);

  // boundingBox returns coordinates relative to the main frame viewport
  // This works correctly for page.mouse.move which also uses viewport coordinates
  const box = await locator.boundingBox();

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
export async function humanType(page: Page, text: string): Promise<void> {
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomDelay(30, 120) });
  }
}
