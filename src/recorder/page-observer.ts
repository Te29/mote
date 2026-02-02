// =============================================================================
// PAGE OBSERVER FOR RECORDER
// =============================================================================
// Captures page state using observe.ts and saves it for reference during selector editing.

import type { Page } from 'playwright';
import type { PageState } from '../types/index.js';
import { observe } from '../observe.js';
import { getPageContent } from '../browser.js';
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

  // Call observe() to get page state (observe handles page load wait internally)
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

  // Also save raw HTML for analysis
  const htmlFilename = generateFilenameFromUrl(url, observedPages.size + 1, 'html');
  const htmlFilePath = path.join(observationsDir, htmlFilename);
  const pageContent = await getPageContent(page);
  fs.writeFileSync(htmlFilePath, pageContent.html);
  console.log(`   ✓ Saved raw HTML to ${path.relative(presetDir, htmlFilePath)}`);

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
 * Format: page-N-url-slug.{ext}
 */
function generateFilenameFromUrl(url: string, index: number, ext: string = 'json'): string {
  try {
    const urlObj = new URL(url);
    let slug = urlObj.hostname + urlObj.pathname;

    // Clean up slug
    slug = slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50); // Max 50 chars

    return `page-${index}-${slug}.${ext}`;
  } catch {
    // Fallback for invalid URLs
    return `page-${index}-unknown.${ext}`;
  }
}
