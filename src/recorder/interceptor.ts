// =============================================================================
// ACTION INTERCEPTOR
// =============================================================================
// Captures user actions in the browser and converts them to RecordedAction.
// Uses page.exposeFunction and addInitScript pattern from observe.ts.

import type { Page } from 'playwright';
import type { RecordedAction, RecordedElementInfo } from './types.js';
import type { WebAction } from '../types/index.js';
import { createTimestamp } from '../types/index.js';

// -----------------------------------------------------------------------------
// RAW ACTION DATA (from browser)
// -----------------------------------------------------------------------------

interface RawActionData {
  type: string;
  tag: string;
  text: string;
  selector: string;
  alternativeSelectors: string[];
  value?: string;
  attributes: Record<string, string>;
}

// -----------------------------------------------------------------------------
// ACTION INTERCEPTOR CLASS
// -----------------------------------------------------------------------------

/**
 * Intercepts user actions in the browser and converts them to RecordedAction.
 */
export class ActionInterceptor {
  private page: Page;
  private actionQueue: RecordedAction[] = [];
  private resolvers: Array<(action: RecordedAction) => void> = [];
  private attached = false;
  private lastUrl: string = '';

  constructor(page: Page) {
    this.page = page;
    this.lastUrl = page.url();
  }

  /**
   * Attach interceptor to the page.
   * Injects capture script and exposes callback function.
   */
  async attach(): Promise<void> {
    if (this.attached) return;

    // Expose callback function to browser context
    await this.page.exposeFunction('__moteRecordAction', (data: RawActionData) => {
      this.handleRawAction(data);
    });

    // Inject capture script
    await this.page.addInitScript(CAPTURE_SCRIPT);

    // Also run it immediately on current page
    await this.page.evaluate(CAPTURE_SCRIPT);

    // Listen for navigation
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) {
        const newUrl = this.page.url();
        if (newUrl !== this.lastUrl && !newUrl.startsWith('about:')) {
          // Detected navigation - record it
          this.handleNavigation(newUrl);
          this.lastUrl = newUrl;
        }
      }
    });

    this.attached = true;
  }

  /**
   * Handle raw action data from browser.
   */
  private handleRawAction(data: RawActionData): void {
    const actionType = this.mapActionType(data.type, data.tag, data.attributes);

    const action: RecordedAction = {
      type: actionType,
      selector: data.selector,
      alternativeSelectors: data.alternativeSelectors.length > 0 ? data.alternativeSelectors : undefined,
      value: data.value,
      elementInfo: {
        tag: data.tag,
        text: data.text,
        attributes: data.attributes,
      },
      timestamp: createTimestamp(),
    };

    this.dispatchAction(action);
  }

  /**
   * Handle navigation detection.
   */
  private handleNavigation(url: string): void {
    const action: RecordedAction = {
      type: 'navigate',
      selector: '',
      value: url,
      elementInfo: {
        tag: 'navigation',
        text: url,
        attributes: { href: url },
      },
      timestamp: createTimestamp(),
    };

    this.dispatchAction(action);
  }

  /**
   * Dispatch action to waiting resolvers or queue.
   */
  private dispatchAction(action: RecordedAction): void {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(action);
    } else {
      this.actionQueue.push(action);
    }
  }

  /**
   * Map raw event type to WebAction.
   */
  private mapActionType(
    eventType: string,
    tag: string,
    attributes: Record<string, string>,
  ): WebAction {
    switch (eventType) {
      case 'click':
        // Check if it's a checkbox
        if (tag === 'input' && (attributes.type === 'checkbox' || attributes.type === 'radio')) {
          return 'checkbox';
        }
        return 'click';

      case 'input':
      case 'type':
        return 'type';

      case 'change':
        if (tag === 'select') {
          return 'select';
        }
        if (tag === 'input' && (attributes.type === 'checkbox' || attributes.type === 'radio')) {
          return 'checkbox';
        }
        return 'type';

      case 'scroll':
        return 'scroll';

      case 'hover':
        return 'hover';

      case 'dragend':
        return 'drag';

      case 'navigate':
        return 'navigate';

      default:
        return 'click';
    }
  }

  /**
   * Wait for the next user action.
   * Returns a promise that resolves when an action is captured.
   */
  waitForAction(): Promise<RecordedAction> {
    // Check queue first
    if (this.actionQueue.length > 0) {
      return Promise.resolve(this.actionQueue.shift()!);
    }

    // Wait for next action
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /**
   * Check if there are pending actions in queue.
   */
  hasPendingActions(): boolean {
    return this.actionQueue.length > 0;
  }

  /**
   * Clear pending actions.
   */
  clearQueue(): void {
    this.actionQueue = [];
  }

  /**
   * Detach interceptor (cleanup).
   */
  detach(): void {
    this.resolvers = [];
    this.actionQueue = [];
    this.attached = false;
  }
}

// -----------------------------------------------------------------------------
// BROWSER CAPTURE SCRIPT
// -----------------------------------------------------------------------------
// This script runs in the browser context via page.addInitScript().
// It must be a string literal (not TypeScript function) to avoid esbuild issues.

const CAPTURE_SCRIPT = `
(function() {
  // Prevent double-initialization
  if (window.__moteRecorderInitialized) return;
  window.__moteRecorderInitialized = true;

  // ==========================================================================
  // SELECTOR BUILDING (mirrors observe.ts buildSelectorFingerprint)
  // ==========================================================================

  function escapeCssValue(value) {
    return value
      .replace(/\\\\/g, '\\\\\\\\')
      .replace(/"/g, '\\\\"')
      .replace(/\\[/g, '\\\\[')
      .replace(/\\]/g, '\\\\]');
  }

  function buildSelectorFingerprint(el) {
    var tag = el.tagName.toLowerCase();
    var text = (el.innerText || '').trim().slice(0, 50);
    var attributes = {};

    // Extract relevant attributes
    var attrNames = ['id', 'name', 'class', 'type', 'placeholder', 'aria-label',
                     'href', 'data-testid', 'data-test-id', 'data-test', 'value', 'role'];
    for (var i = 0; i < attrNames.length; i++) {
      var attr = attrNames[i];
      var val = el.getAttribute(attr);
      if (val) attributes[attr] = val;
    }

    var candidates = [];

    // Priority 1: ID
    if (attributes.id) {
      candidates.push('[id="' + escapeCssValue(attributes.id) + '"]');
    }

    // Priority 1b: Test IDs
    if (attributes['data-testid']) {
      candidates.push('[data-testid="' + escapeCssValue(attributes['data-testid']) + '"]');
    }
    if (attributes['data-test-id']) {
      candidates.push('[data-test-id="' + escapeCssValue(attributes['data-test-id']) + '"]');
    }
    if (attributes['data-test']) {
      candidates.push('[data-test="' + escapeCssValue(attributes['data-test']) + '"]');
    }

    // Priority 2: Radio/Checkbox with value
    if (tag === 'input' && attributes.type) {
      if ((attributes.type === 'radio' || attributes.type === 'checkbox') && attributes.value) {
        if (attributes.name) {
          candidates.push('input[type="' + attributes.type + '"][name="' + escapeCssValue(attributes.name) + '"][value="' + escapeCssValue(attributes.value) + '"]');
        }
        candidates.push('input[type="' + attributes.type + '"][value="' + escapeCssValue(attributes.value) + '"]');
      }
    }

    // Priority 3: Name (for form elements)
    if (attributes.name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      candidates.push(tag + '[name="' + escapeCssValue(attributes.name) + '"]');
    }

    // Priority 4: Type + placeholder
    if (tag === 'input' && attributes.type && attributes.placeholder) {
      candidates.push('input[type="' + attributes.type + '"][placeholder="' + escapeCssValue(attributes.placeholder) + '"]');
    }

    // Priority 4b: Aria-label
    if (attributes['aria-label']) {
      candidates.push('[aria-label="' + escapeCssValue(attributes['aria-label']) + '"]');
    }

    // Priority 5: Type only
    if (tag === 'input' && attributes.type) {
      candidates.push('input[type="' + attributes.type + '"]');
    }

    // Priority 6: Text content (for buttons/links)
    if ((tag === 'button' || tag === 'a') && text) {
      candidates.push(tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")');
    }

    // Priority 7: Href
    if (tag === 'a' && attributes.href) {
      var href = attributes.href;
      if (href.length > 50) {
        candidates.push('a[href*="' + escapeCssValue(href.substring(0, 30)) + '"]');
      } else {
        candidates.push('a[href="' + escapeCssValue(href) + '"]');
      }
    }

    // Fallback: first attribute
    if (candidates.length === 0) {
      var keys = Object.keys(attributes);
      if (keys.length > 0) {
        var key = keys[0];
        candidates.push(tag + '[' + key + '="' + escapeCssValue(attributes[key]) + '"]');
      }
    }

    // Last resort: bare tag
    if (candidates.length === 0) {
      candidates.push(tag);
    }

    return {
      primary: candidates[0],
      alternatives: candidates.slice(1),
      tag: tag,
      text: text,
      attributes: attributes
    };
  }

  // ==========================================================================
  // EVENT HANDLERS
  // ==========================================================================

  var typeDebounceTimer = null;
  var scrollDebounceTimer = null;
  var lastTypedElement = null;
  var lastTypedValue = '';

  // Click handler
  document.addEventListener('click', function(e) {
    var target = e.target;
    if (!target || target.nodeType !== 1) return;

    // Skip if it's just focusing an input
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return; // Will capture via input event instead
    }

    var fingerprint = buildSelectorFingerprint(target);

    if (typeof window.__moteRecordAction === 'function') {
      window.__moteRecordAction({
        type: 'click',
        tag: fingerprint.tag,
        text: fingerprint.text,
        selector: fingerprint.primary,
        alternativeSelectors: fingerprint.alternatives,
        attributes: fingerprint.attributes
      });
    }
  }, true);

  // Input handler (debounced)
  document.addEventListener('input', function(e) {
    var target = e.target;
    if (!target || target.nodeType !== 1) return;

    lastTypedElement = target;
    lastTypedValue = target.value || '';

    clearTimeout(typeDebounceTimer);
    typeDebounceTimer = setTimeout(function() {
      if (!lastTypedElement) return;

      var fingerprint = buildSelectorFingerprint(lastTypedElement);

      if (typeof window.__moteRecordAction === 'function') {
        window.__moteRecordAction({
          type: 'type',
          tag: fingerprint.tag,
          text: fingerprint.text,
          selector: fingerprint.primary,
          alternativeSelectors: fingerprint.alternatives,
          value: lastTypedValue,
          attributes: fingerprint.attributes
        });
      }

      lastTypedElement = null;
      lastTypedValue = '';
    }, 800); // 800ms debounce for typing
  }, true);

  // Change handler (for select elements)
  document.addEventListener('change', function(e) {
    var target = e.target;
    if (!target || target.nodeType !== 1) return;

    // Only handle select elements (inputs are handled via input event)
    if (target.tagName !== 'SELECT') return;

    var fingerprint = buildSelectorFingerprint(target);
    var selectedOption = target.options[target.selectedIndex];
    var selectedText = selectedOption ? selectedOption.text : '';

    if (typeof window.__moteRecordAction === 'function') {
      window.__moteRecordAction({
        type: 'change',
        tag: fingerprint.tag,
        text: selectedText,
        selector: fingerprint.primary,
        alternativeSelectors: fingerprint.alternatives,
        value: target.value,
        attributes: fingerprint.attributes
      });
    }
  }, true);

  // Scroll handler (debounced)
  var lastScrollY = window.scrollY;
  window.addEventListener('scroll', function() {
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = setTimeout(function() {
      var direction = window.scrollY > lastScrollY ? 'down' : 'up';
      lastScrollY = window.scrollY;

      if (typeof window.__moteRecordAction === 'function') {
        window.__moteRecordAction({
          type: 'scroll',
          tag: 'window',
          text: direction,
          selector: 'window',
          alternativeSelectors: [],
          value: direction,
          attributes: { direction: direction, scrollY: String(window.scrollY) }
        });
      }
    }, 500); // 500ms debounce for scroll
  }, { passive: true });

  console.log('[Mote Recorder] Action capture initialized');
})();
`;

// -----------------------------------------------------------------------------
// EXPORTED CAPTURE SCRIPT (for direct evaluation)
// -----------------------------------------------------------------------------

export { CAPTURE_SCRIPT };
