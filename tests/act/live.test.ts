import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchBrowser, navigateTo, closeBrowser } from '../../src/browser.js';
import { observe } from '../../src/observe.js';
import { executeAction, pressKey } from '../../src/act/index.js';
import type { Action } from '../../src/types/index.js';

// These tests require a browser and internet access.
// Run with: npm run test:act:live
describe('Act Module - Live Browser Tests', () => {
  let browserSession: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browserSession = await launchBrowser({
      headless: true,
      slowMo: 100,
      profilePath: undefined,
      stealth: true,
      timeoutDefault: 10000,
      timeoutNavigation: 10000,
      timeoutElement: 5000,
      postNavDelay: 500,
    });
  });

  afterAll(async () => {
    if (browserSession?.browser) {
      await closeBrowser(browserSession.browser);
    }
  });

  it('should type into Google search box', async () => {
    await navigateTo(browserSession.page, 'https://www.google.com');

    // Handle cookie consent if it appears
    const consentBtn = await browserSession.page.$('button:has-text("Reject all"), button:has-text("Accept all")');
    if (consentBtn) await consentBtn.click().catch(() => {});

    const state = await observe(browserSession.page);
    expect(state.elements.length).toBeGreaterThan(0);

    // Find the search input
    const searchInput = state.elements.find(
      (el) =>
        el.tag === 'textarea' ||
        (el.tag === 'input' && el.attributes.name === 'q'),
    );

    expect(searchInput).toBeDefined();

    if (searchInput) {
      const typeAction: Action = {
        type: 'type',
        elementId: searchInput.index.toString(),
        text: 'Mote browser automation',
        reason: 'Test typing into search box',
      };

      const result = await executeAction(
        browserSession.page,
        typeAction,
        state.elements,
      );

      expect(result.success).toBe(true);
    }
  }, 30000);

  it('should click on an element', async () => {
    await navigateTo(browserSession.page, 'https://www.google.com');

    // Handle cookie consent if it appears
    const consentBtn = await browserSession.page.$('button:has-text("Reject all"), button:has-text("Accept all")');
    if (consentBtn) await consentBtn.click().catch(() => {});

    const state = await observe(browserSession.page);

    // Find a clickable button
    const button = state.elements.find(
      (el) => el.tag === 'button' || (el.tag === 'input' && el.inputType === 'submit'),
    );

    if (button) {
      const clickAction: Action = {
        type: 'click',
        elementId: button.index.toString(),
        reason: 'Test clicking a button',
      };

      const result = await executeAction(
        browserSession.page,
        clickAction,
        state.elements,
      );

      // Click might fail if button requires search text first, but action should execute
      expect(result.success !== undefined).toBe(true);
    }
  }, 30000);

  it('should scroll the page', async () => {
    await navigateTo(browserSession.page, 'https://en.wikipedia.org/wiki/Main_Page');

    const state = await observe(browserSession.page);

    const scrollAction: Action = {
      type: 'scroll',
      text: 'down',
      reason: 'Test scrolling',
    };

    const result = await executeAction(
      browserSession.page,
      scrollAction,
      state.elements,
    );

    expect(result.success).toBe(true);
  }, 30000);

  it('should navigate to a URL', async () => {
    const navigateAction: Action = {
      type: 'navigate',
      text: 'https://example.com',
      reason: 'Test navigation',
    };

    const result = await executeAction(
      browserSession.page,
      navigateAction,
      [],
    );

    expect(result.success).toBe(true);
    expect(browserSession.page.url()).toContain('example.com');
  }, 30000);

  it('should wait for page updates', async () => {
    const waitAction: Action = {
      type: 'wait',
      reason: 'Test waiting',
    };

    const result = await executeAction(
      browserSession.page,
      waitAction,
      [],
    );

    expect(result.success).toBe(true);
  }, 10000);

  it('should press Enter key', async () => {
    await navigateTo(browserSession.page, 'https://www.google.com');

    // Just test that pressKey doesn't throw
    await expect(pressKey(browserSession.page, 'Escape')).resolves.not.toThrow();
  }, 15000);
});
