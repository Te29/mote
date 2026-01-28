// =============================================================================
// ELEMENT RESOLUTION
// =============================================================================
// Logic for finding, validating, and fuzzy-matching elements on the page.

import type { Page, Frame } from 'playwright';
import type { ElementInfo } from '../types/index.js';
import { getElementLocator, getElementContext } from './helpers.js';

// -----------------------------------------------------------------------------
// ELEMENT VERIFICATION
// -----------------------------------------------------------------------------

/**
 * Result of element verification.
 */
export interface VerifyResult {
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
export async function verifyElement(
  page: Page,
  element: ElementInfo,
): Promise<VerifyResult> {
  try {
    // Use getElementLocator to handle iframes transparently
    const locator = getElementLocator(page, element);
    
    // waiting for element handle with short timeout (verification should be fast)
    const handle = await locator.elementHandle({ timeout: 2000 });

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
// VERIFY-OR-RESOLVE: Combined verification + resilient resolution
// -----------------------------------------------------------------------------

/**
 * Verify an element exists, falling back to resilient resolution if needed.
 * Returns an updated element with a working selector, or an error.
 *
 * Flow:
 * 1. verifyElement() — fast check that primary selector still works
 * 2. resolveElement() — tries alternatives then fuzzy matching
 * 3. Returns updated element with resolved selector, or error
 */
export async function verifyOrResolve(
  page: Page,
  element: ElementInfo,
): Promise<{ valid: true; element: ElementInfo } | { valid: false; error: string }> {
  // Fast path: primary selector still valid
  const verification = await verifyElement(page, element);
  if (verification.valid) {
    return { valid: true, element };
  }

  // Slow path: try alternative selectors and fuzzy matching
  console.log(`   ⚠️ Primary verification failed: ${verification.error}`);
  const resolution = await resolveElement(page, element);

  if (resolution.found && resolution.resolvedSelector) {
    // Update element's selector to the one that worked
    const resolved: ElementInfo = {
      ...element,
      selector: resolution.resolvedSelector,
    };
    // Re-verify with the resolved selector (tag + text check)
    const recheck = await verifyElement(page, resolved);
    if (recheck.valid) {
      return { valid: true, element: resolved };
    }
    // Resolved something but it didn't pass tag/text verification
    return {
      valid: false,
      error: `Resolved via ${resolution.method} but verification failed: ${recheck.error}`,
    };
  }

  return {
    valid: false,
    error: resolution.error || verification.error || 'Element not found',
  };
}

// -----------------------------------------------------------------------------
// ELEMENT RESOLUTION (Fuzzy Matching Layer)
// -----------------------------------------------------------------------------

/**
 * Result of resolving an element on the page.
 * When the primary selector fails, this tries alternative selectors and
 * attribute-based fuzzy matching before giving up.
 */
export interface ResolveResult {
  found: boolean;
  /** The selector that successfully matched (may differ from element.selector) */
  resolvedSelector?: string;
  /** How the element was found */
  method?: 'primary' | 'alternative' | 'fuzzy';
  error?: string;
}

/**
 * Try to locate an element on the page using a multi-strategy approach:
 *
 * 1. Primary selector   — exact match (fast path)
 * 2. Alternative selectors — other valid selectors from the fingerprint
 * 3. Fuzzy attribute match — find the best-matching element on the page by
 *    comparing tag, text, and attributes against all current page elements
 *
 * This layer sits between the cheap verify step and the expensive LLM drift
 * analysis, handling common cases like minor attribute renames without an
 * API call.
 */
export async function resolveElement(
  page: Page,
  element: ElementInfo,
): Promise<ResolveResult> {
  // Resolve the correct context (Page or Frame) once for all strategies
  const context = await getElementContext(page, element);

  // Strategy 1: Primary selector
  const primary = await context.$(element.selector);
  if (primary) {
    return { found: true, resolvedSelector: element.selector, method: 'primary' };
  }

  // Strategy 2: Try alternative selectors
  if (element.alternativeSelectors && element.alternativeSelectors.length > 0) {
    for (const alt of element.alternativeSelectors) {
      const handle = await context.$(alt);
      if (handle) {
        // Verify the tag matches to avoid false positives
        const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
        if (tag === element.tag) {
          console.log(`   🔄 Primary selector failed, matched via alternative: ${alt}`);
          return { found: true, resolvedSelector: alt, method: 'alternative' };
        }
      }
    }
  }

  // Strategy 3: Fuzzy attribute-based matching against current page (or frame) elements
  // Build candidate selectors from the element's attributes and try to find
  // an element that shares multiple attributes with our target.
  const fuzzyResult = await fuzzyMatchElement(context, element);
  if (fuzzyResult) {
    console.log(`   🔍 Primary & alternatives failed, fuzzy-matched via attributes (score: ${fuzzyResult.score})`);
    return { found: true, resolvedSelector: fuzzyResult.selector, method: 'fuzzy' };
  }

  return {
    found: false,
    error: `Element not found via primary, ${element.alternativeSelectors?.length || 0} alternatives, or fuzzy matching`,
  };
}

/**
 * Fuzzy-match an element against all current page elements by comparing
 * tag name, text content, and key attributes.
 *
 * Returns the selector of the best match if the score exceeds a minimum
 * confidence threshold, or null if no good match exists.
 */
export async function fuzzyMatchElement(
  context: Page | Frame,
  target: ElementInfo,
): Promise<{ selector: string; score: number } | null> {
  // Collect candidate elements of the same tag from the live page/frame
  const candidates = await context.evaluate((tag: string) => {
    const els = document.querySelectorAll(tag);
    const results: Array<{
      text: string;
      attributes: Record<string, string>;
      index: number;
    }> = [];
    const attrNames = [
      'href', 'name', 'id', 'class', 'type',
      'aria-label', 'placeholder', 'value', 'role',
      'data-testid', 'data-test-id', 'data-test',
    ];
    els.forEach((el, i) => {
      const attrs: Record<string, string> = {};
      for (const attr of attrNames) {
        const val = el.getAttribute(attr);
        if (val) attrs[attr] = val.length > 100 ? val.substring(0, 97) + '...' : val;
      }
      results.push({
        text: ((el as HTMLElement).innerText || '').trim().substring(0, 100),
        attributes: attrs,
        index: i,
      });
    });
    return results;
  }, target.tag);

  if (candidates.length === 0) return null;

  const targetTextLower = target.text.trim().toLowerCase();
  let bestScore = 0;
  let bestIndex = -1;

  for (const candidate of candidates) {
    let score = 0;

    // Text similarity (highest weight)
    const candidateTextLower = candidate.text.toLowerCase();
    if (targetTextLower && candidateTextLower) {
      if (targetTextLower === candidateTextLower) {
        score += 4;
      } else if (
        targetTextLower.includes(candidateTextLower) ||
        candidateTextLower.includes(targetTextLower)
      ) {
        score += 3;
      }
    }

    // Attribute exact matches (medium weight)
    for (const [key, val] of Object.entries(target.attributes)) {
      // Skip 'class' for exact matching (too volatile) and 'checked' (state)
      if (key === 'class' || key === 'checked') continue;
      if (candidate.attributes[key] === val) {
        score += 2;
      } else if (candidate.attributes[key] && (
        candidate.attributes[key].includes(val) || val.includes(candidate.attributes[key])
      )) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = candidate.index;
    }
  }

  // Minimum confidence threshold: need at least text match OR 2 attribute matches
  const MIN_SCORE = 3;
  if (bestScore < MIN_SCORE || bestIndex < 0) return null;

  // Build a nth-of-type selector to target the specific element
  const selector = `${target.tag}:nth-of-type(${bestIndex + 1})`;

  // Verify it actually resolves to something
  const verify = await context.$(selector);
  if (!verify) return null;

  return { selector, score: bestScore };
}
