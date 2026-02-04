
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { launchBrowser, closeBrowser } from '../../src/browser.js';
import { observe } from '../../src/observe.js';
import { executeAction } from '../../src/act/index.js';
import type { Action, ElementInfo } from '../../src/types/index.js';

vi.mock('../../src/reason.js', () => ({
  createLLMClient: vi.fn(),
  think: vi.fn(),
  generatePlan: vi.fn(),
}));

// Pause between steps so a human viewer can see each result
const OBSERVE_PAUSE = 1200;

// Helper for structured logging
async function runStep(index: number, description: string, fn: () => Promise<void>) {
  console.log(`\n========================================`);
  console.log(`  STEP ${index}: ${description}`);
  console.log(`========================================`);
  const start = Date.now();
  try {
    await fn();
    console.log(`  -> Passed (${Date.now() - start}ms)`);
  } catch (error) {
    console.error(`  -> Failed after ${Date.now() - start}ms`);
    throw error;
  }
}

describe.skip('Iframe Visual Integration', () => {
  let browserInstance: any;

  afterEach(async () => {
    if (browserInstance) {
      await closeBrowser(browserInstance);
    }
  });

  it('should successfully execute all actions with verification', async () => {
    // Shared state across steps
    let page: any;
    let contentFrame: any;
    let observation: { elements: ElementInfo[] };

    /** Tick the sidebar checklist checkbox for the given step number */
    async function tick(step: number) {
      try {
        await page.evaluate((n: number) => {
          if (typeof (window as any).tickStep === 'function') {
            (window as any).tickStep(n);
          }
        }, step);
      } catch {
        // page may have navigated away (step 16) — ignore
      }
      await page.waitForTimeout(OBSERVE_PAUSE);
    }

    // ---------------------------------------------------------------
    // SETUP (Steps 1-4)
    // ---------------------------------------------------------------

    await runStep(1, 'Launch browser', async () => {
      const session = await launchBrowser({
        headless: false,
        slowMo: 100,
        stealth: false,
        timeoutDefault: 10000,
        timeoutNavigation: 10000,
        timeoutElement: 5000,
        postNavDelay: 500,
        profilePath: undefined,
      } as any);
      browserInstance = session.browser;
      page = session.page;
    });

    await runStep(2, 'Navigate to test page', async () => {
      const parentPath = path.resolve(__dirname, '../data/parent.html');
      const url = `file://${parentPath}`;
      console.log(`  URL: ${url}`);
      await page.goto(url);
      await page.waitForTimeout(OBSERVE_PAUSE);
      // Tick steps 1 + 2 once the page is loaded and tickStep is available
      await tick(1);
      await tick(2);
    });

    await runStep(3, 'Observe page elements', async () => {
      observation = await observe(page);
      const iframeElements = observation.elements.filter((e: ElementInfo) => e.frameSelector);
      console.log(`  Total elements: ${observation.elements.length}`);
      console.log(`  Iframe elements: ${iframeElements.length}`);
      expect(iframeElements.length).toBeGreaterThan(0);
      await tick(3);
    });

    await runStep(4, 'Get iframe content handle', async () => {
      const frameElement = await page.$('iframe#test-frame');
      contentFrame = await frameElement?.contentFrame();
      expect(contentFrame).toBeDefined();
      await tick(4);
    });

    // ---------------------------------------------------------------
    // IFRAME ACTIONS (Steps 5-13)
    // ---------------------------------------------------------------

    await runStep(5, 'Click button inside iframe', async () => {
      const frameBtn = observation.elements.find(
        (el: any) => el.text === 'Click me' && el.tag === 'button',
      );
      if (!frameBtn) throw new Error('Frame button not found');

      const action: Action = {
        type: 'click',
        elementId: String(frameBtn.index),
        reason: 'Click iframe button',
      };

      const result = await executeAction(page, action, observation.elements);
      expect(result.success).toBe(true);

      const btnText = await contentFrame?.$eval('#frame-btn', (el: any) => el.innerText);
      expect(btnText).toBe('Clicked!');
      await tick(5);
    });

    await runStep(6, 'Type into iframe input', async () => {
      const frameInput = observation.elements.find(
        (el: any) =>
          el.tag === 'input' &&
          el.frameSelector &&
          (el.attributes?.type === 'text' || !el.attributes?.type),
      );
      if (!frameInput) throw new Error('Frame input not found');

      const start = Date.now();
      const typeAction: Action = {
        type: 'type',
        elementId: String(frameInput.index),
        text: 'Human typing',
        reason: 'Type into iframe input',
      };

      const result = await executeAction(page, typeAction, observation.elements);
      const duration = Date.now() - start;

      expect(result.success).toBe(true);
      console.log(`  Typing duration: ${duration}ms`);

      const inputValue = await contentFrame?.$eval('#frame-input', (el: any) => el.value);
      expect(inputValue).toBe('Human typing');
      expect(duration).toBeGreaterThan(400);
      await tick(6);
    });

    await runStep(7, 'Select dropdown option', async () => {
      const frameSelect = observation.elements.find(
        (el: any) => el.tag === 'select' && el.frameSelector,
      );
      if (!frameSelect) throw new Error('Frame select not found');

      const selectAction: Action = {
        type: 'select',
        elementId: String(frameSelect.index),
        text: 'opt2',
        reason: 'Select Option 2',
      };
      const res = await executeAction(page, selectAction, observation.elements);
      expect(res.success).toBe(true);

      const val = await contentFrame?.$eval('#frame-select', (el: any) => el.value);
      expect(val).toBe('opt2');
      await tick(7);
    });

    await runStep(8, 'Toggle checkbox', async () => {
      const frameCheckbox = observation.elements.find(
        (el: any) =>
          el.tag === 'input' &&
          el.attributes?.type === 'checkbox' &&
          el.frameSelector &&
          el.attributes?.id === 'frame-checkbox',
      );
      if (!frameCheckbox) throw new Error('Frame checkbox not found');

      const checkAction: Action = {
        type: 'checkbox',
        elementId: String(frameCheckbox.index),
        text: 'check',
        reason: 'Check the checkbox',
      };
      const res = await executeAction(page, checkAction, observation.elements);
      expect(res.success).toBe(true);

      const isChecked = await contentFrame?.$eval('#frame-checkbox', (el: any) => el.checked);
      expect(isChecked).toBe(true);
      await tick(8);
    });

    await runStep(9, 'Multi-click 3 checkboxes', async () => {
      const mc1 = observation.elements.find(
        (el: any) => el.attributes?.id === 'mc1' && el.frameSelector,
      );
      const mc2 = observation.elements.find(
        (el: any) => el.attributes?.id === 'mc2' && el.frameSelector,
      );
      const mc3 = observation.elements.find(
        (el: any) => el.attributes?.id === 'mc3' && el.frameSelector,
      );
      if (!mc1 || !mc2 || !mc3) throw new Error('Multi-click checkboxes not found');

      const multiClickAction: Action = {
        type: 'multi_click',
        elementIds: [String(mc1.index), String(mc2.index), String(mc3.index)],
        reason: 'Check all three',
      };
      const res = await executeAction(page, multiClickAction, observation.elements);
      expect(res.success).toBe(true);

      const checkedCount = await contentFrame?.$eval('#multi-checks', (div: any) =>
        Array.from(div.querySelectorAll('input:checked')).length,
      );
      expect(checkedCount).toBe(3);
      await tick(9);
    });

    await runStep(10, 'Hover over element', async () => {
      const hoverTarget = observation.elements.find(
        (el: any) => el.attributes?.id === 'hover-target',
      );
      if (!hoverTarget) throw new Error('Hover target not found');

      const hoverAction: Action = {
        type: 'hover',
        elementId: String(hoverTarget.index),
        reason: 'Hover to reveal text',
      };
      const res = await executeAction(page, hoverAction, observation.elements);
      expect(res.success).toBe(true);

      const text = await contentFrame?.$eval('#hover-target', (el: any) => el.innerText);
      expect(text).toBe('Hovered!');
      // Extra pause so the hover color change is clearly visible
      await page.waitForTimeout(600);
      await tick(10);
    });

    await runStep(11, 'Drag and drop', async () => {
      const source = observation.elements.find(
        (el: any) => el.attributes?.id === 'drag-source',
      );
      const target = observation.elements.find(
        (el: any) => el.attributes?.id === 'drag-target',
      );
      if (!source || !target) throw new Error('Drag source or target not found');

      const dragAction: Action = {
        type: 'drag',
        elementId: String(source.index),
        text: String(target.index),
        reason: 'Drag source to target',
      };
      const res = await executeAction(page, dragAction, observation.elements);
      expect(res.success).toBe(true);

      await page.waitForTimeout(600);
      
      // Verify that drag-source is now inside drag-target
      const isMoved = await contentFrame?.$eval('#drag-target', (target: any) => {
          const source = target.querySelector('#drag-source');
          return !!source && source.innerText === 'Dropped!';
      });
      expect(isMoved).toBe(true);

      // Extra pause so the green "Dropped!" state is clearly visible
      await page.waitForTimeout(600);
      await tick(11);
    });


    await runStep(12, 'Wait for counter button', async () => {
      // Find the wait button
      const waitBtn = observation.elements.find(
        (el: any) => el.attributes?.id === 'wait-btn',
      );
      if (!waitBtn) throw new Error('Wait button not found');
      
      console.log('  Waiting for button to become ready...');
      
      // Wait for it to become enabled/clickable (text becomes 'Click me!')
      // Use contentFrame.waitForFunction for robust iframe access
      await contentFrame.waitForFunction(
          () => {
              const btn = document.getElementById('wait-btn') as HTMLButtonElement;
              return btn && !btn.disabled && btn.innerText === 'Click me!';
          },
          undefined, // no args
          { timeout: 10000, polling: 500 }
      );

      // Now click it
      const clickAction: Action = {
        type: 'click',
        elementId: String(waitBtn.index),
        reason: 'Click the ready button',
      };
      
      const res = await executeAction(page, clickAction, observation.elements);
      expect(res.success).toBe(true);

      const text = await contentFrame?.$eval('#wait-btn', (el: any) => el.innerText);
      expect(text).toBe('Clicked!');
      await tick(12);
    });

    await runStep(13, 'Scroll iframe content down', async () => {
      // Re-observe to get fresh positions? simplified here.
       const frameInput = observation.elements.find(
         (el: any) => el.tag === 'input' && el.frameSelector,
       );
      
      const initialScrollY = (await contentFrame?.evaluate(() => window.scrollY)) || 0;

      const scrollAction: Action = {
        type: 'scroll',
        elementId: String(frameInput?.index), // Use any element in frame
        text: 'down',
        reason: 'Scroll iframe down',
      };
      const res = await executeAction(page, scrollAction, observation.elements);
      expect(res.success).toBe(true);

      const newScrollY = (await contentFrame?.evaluate(() => window.scrollY)) || 0;
      expect(newScrollY).toBeGreaterThan(initialScrollY);
      await tick(13);
    });

    await runStep(14, 'Click offscreen element (auto-scroll)', async () => {
      const bottomBtn = observation.elements.find(
        (el: any) => el.text === 'Bottom Button' && el.frameSelector,
      );
      if (!bottomBtn) throw new Error('Bottom button not found');

      // Reset iframe scroll to top so the button is definitely off-screen
      await contentFrame?.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      const clickAction: Action = {
        type: 'click',
        elementId: String(bottomBtn.index),
        reason: 'Click offscreen button',
      };
      const res = await executeAction(page, clickAction, observation.elements);
      expect(res.success).toBe(true);
      
      // Verify visual feedback
      const btnText = await contentFrame?.$eval('#bottom-btn', (el: any) => el.innerText);
      expect(btnText).toBe('Clicked!');

      const finalScrollY = (await contentFrame?.evaluate(() => window.scrollY)) || 0;
      expect(finalScrollY).toBeGreaterThan(100);
      await tick(14);
    });

    // ---------------------------------------------------------------
    // PAGE-LEVEL ACTIONS (Steps 15-17)
    // ---------------------------------------------------------------

    await runStep(15, 'Click element on main page (auto-scrolls)', async () => {
      const bottomBtn = observation.elements.find(
        (el: any) => el.attributes?.id === 'main-bottom-btn',
      );

      // Note: scroll_to_element was removed - click now auto-scrolls elements into view
      const clickAction: Action = {
        type: 'click',
        elementId: String(bottomBtn?.index),
        reason: 'Click bottom button (auto-scrolls into view)',
      };
      const result = await executeAction(page, clickAction, observation.elements);
      expect(result.success).toBe(true);

      const isVisible = await page.isVisible('#test-finish-marker');
      expect(isVisible).toBe(true);
      await tick(15);
    });

    await runStep(16, 'Wait for page idle', async () => {
        const start = Date.now();
        const waitAction: Action = {
          type: 'wait',
          text: '500',
          reason: 'Wait for page to settle',
        };
        const res = await executeAction(page, waitAction, observation.elements);
        expect(res.success).toBe(true);
  
        const duration = Date.now() - start;
        expect(duration).toBeGreaterThanOrEqual(500);
        await tick(16);
      });

    await runStep(17, 'Navigate to external URL', async () => {
      // Tick before navigating away (tickStep won't be available after)
      await tick(17);

      const navigateAction: Action = {
        type: 'navigate',
        text: 'https://www.google.com',
        reason: 'Navigate away from test page',
      };
      const res = await executeAction(page, navigateAction, observation.elements);
      expect(res.success).toBe(true);
      expect(page.url()).toContain('google.com');
      await page.waitForTimeout(OBSERVE_PAUSE);
    });

    // Final pause to visually confirm the end state
    console.log('\n  All 16 steps complete. Closing in 3s...');
    await page.waitForTimeout(3000);
  }, 120000);
});
