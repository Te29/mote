// =============================================================================
// PAGE OBSERVER FOR RECORDER
// =============================================================================
// Captures page state using observe.ts and saves it for reference during selector editing.

import type { Page } from 'playwright';
import type { PageState } from '../types/index.js';
import { observe } from '../observe.js';
import * as fs from 'fs';
import * as path from 'path';

// -----------------------------------------------------------------------------
// PAGE STATE TRACKING
// -----------------------------------------------------------------------------

/**
 * Saved page observation with metadata.
 */
export interface SavedPageObservation {
  /** When this observation was captured */
  timestamp: string;

  /** Page URL */
  url: string;

  /** Page title */
  title: string;

  /** File path where full observation is saved */
  filePath: string;

  /** Number of elements found */
  elementCount: number;
}

/**
 * Track observed pages to avoid duplicate saves.
 */
const observedPages = new Map<string, SavedPageObservation>();

// -----------------------------------------------------------------------------
// OBSERVE AND SAVE
// -----------------------------------------------------------------------------

/**
 * Observe current page state and save it to the preset directory.
 * Returns the saved observation metadata.
 *
 * @param page - Playwright page object
 * @param presetDir - Directory where preset is being saved
 * @returns Saved observation metadata
 */
export async function observeAndSavePage(
  page: Page,
  presetDir: string,
): Promise<SavedPageObservation> {
  const url = page.url();

  // Check if we've already observed this URL
  if (observedPages.has(url)) {
    console.log(`   ℹ️  Page already observed: ${url}`);
    return observedPages.get(url)!;
  }

  console.log(`   👁️  Observing page: ${url}`);

  // Wait for page to fully load before observing
  // This prevents false positives (empty elements, captcha detection) when page hasn't loaded yet
  try {
    await page.waitForLoadState('load', { timeout: 10000 });
  } catch {
    // Timeout is okay, page might already be loaded
  }

  // Additional wait for dynamic content and scripts to execute
  await page.waitForTimeout(2000);

  // Try to wait for network to be idle (indicates AJAX/dynamic content loaded)
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // Timeout is okay, some pages have persistent connections
  }

  // Call observe() to get page state
  const pageState: PageState = await observe(page);

  // Create observations directory if it doesn't exist
  const observationsDir = path.join(presetDir, 'observations');
  if (!fs.existsSync(observationsDir)) {
    fs.mkdirSync(observationsDir, { recursive: true });
  }

  // Generate filename from URL
  const filename = generateFilenameFromUrl(url, observedPages.size + 1);
  const filePath = path.join(observationsDir, filename);

  // Save page state as JSON
  const savedData = {
    timestamp: new Date().toISOString(),
    url: pageState.url,
    title: pageState.title,
    markdown: pageState.markdown,
    elements: pageState.elements,
    captcha: pageState.captcha,
  };

  fs.writeFileSync(filePath, JSON.stringify(savedData, null, 2));

  // Create observation metadata
  const observation: SavedPageObservation = {
    timestamp: savedData.timestamp,
    url: pageState.url,
    title: pageState.title,
    filePath: path.relative(presetDir, filePath),
    elementCount: pageState.elements.length,
  };

  // Track this observation
  observedPages.set(url, observation);

  console.log(`   ✓ Saved ${pageState.elements.length} elements to ${observation.filePath}`);

  return observation;
}

/**
 * Get all observed pages in this recording session.
 */
export function getObservedPages(): SavedPageObservation[] {
  return Array.from(observedPages.values());
}

/**
 * Clear observed pages tracking (for new recording session).
 */
export function clearObservedPages(): void {
  observedPages.clear();
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

/**
 * Generate a safe filename from a URL.
 * Format: page-N-url-slug.json
 */
function generateFilenameFromUrl(url: string, index: number): string {
  try {
    const urlObj = new URL(url);
    let slug = urlObj.hostname + urlObj.pathname;

    // Clean up slug
    slug = slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50); // Max 50 chars

    return `page-${index}-${slug}.json`;
  } catch {
    // Fallback for invalid URLs
    return `page-${index}-unknown.json`;
  }
}
