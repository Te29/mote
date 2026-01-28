
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import { launchBrowser, closeBrowser } from '../../src/browser.js';
import { observe } from '../../src/observe.js';
import { executeAction } from '../../src/act.js';
import type { Action, ElementInfo } from '../../src/types/index.js';

vi.mock('../../src/reason.js', () => ({
  createLLMClient: vi.fn(),
  think: vi.fn(),
  generatePlan: vi.fn(),
}));

// Helper for structured logging
async function runStep(index: number, description: string, fn: () => Promise<void>) {
  console.log(`\n----------------------------------------`);
  console.log(`[STEP ${index}] ${description}`);
  const start = Date.now();
  try {
    await fn();
    console.log(`✓ Passed (${Date.now() - start}ms)`);
  } catch (error) {
    console.error(`✗ Failed after ${Date.now() - start}ms`);
    throw error;
  }
}

describe('Iframe Visual Integration', () => {
  let browserInstance: any;

  afterEach(async () => {
    if (browserInstance) {
      await closeBrowser(browserInstance);
    }
  });

  it('should successfully execute all iframe actions with verification', async () => {
    // Shared state across steps
    let page: any;
    let contentFrame: any;
    let observation: { elements: ElementInfo[] };

    await runStep(1, 'Launch Browser (Visual Mode)', async () => {
      const session = await launchBrowser({
        headless: false,
        slowMo: 100,
        stealth: false,
        timeoutDefault: 10000,
        timeoutNavigation: 10000,
        timeoutElement: 5000,
        postNavDelay: 500,
        profilePath: undefined
      } as any);
      browserInstance = session.browser;
      page = session.page;
    });

    await runStep(2, 'Navigate to test page', async () => {
      const parentPath = path.resolve(__dirname, '../data/parent.html');
      const url = `file://${parentPath}`;
      console.log(`Navigating to: ${url}`);
      await page.goto(url);
    });

    await runStep(3, 'Observe page elements', async () => {
      observation = await observe(page);
      const iframeElements = observation.elements.filter(e => e.frameSelector);
      console.log(`Found ${iframeElements.length} elements inside iframes`);
      expect(iframeElements.length).toBeGreaterThan(0);
    });

    await runStep(4, 'Get frame content handle', async () => {
      const frameElement = await page.$('iframe#test-frame');
      contentFrame = await frameElement?.contentFrame();
      expect(contentFrame).toBeDefined();
    });

    await runStep(5, 'ACTION: Click button inside iframe', async () => {
      const frameBtn = observation.elements.find(
        (el: any) => el.text === 'Click me' && el.tag === 'button'
      );
      if (!frameBtn) throw new Error('Frame button not found');
      
      const action: Action = {
        type: 'click',
        elementId: String(frameBtn.index),
        reason: 'Testing iframe click'
      };
      
      const result = await executeAction(page, action, observation.elements);
      expect(result.success).toBe(true);

      // Verify DOM change
      const btnText = await contentFrame?.$eval('#frame-btn', (el: any) => el.innerText);
      expect(btnText).toBe('Clicked!');
    });

    await runStep(6, 'ACTION: Type into iframe input (Human-like delay check)', async () => {
      const frameInput = observation.elements.find(
        (el: any) => el.tag === 'input' && el.frameSelector && (el.attributes?.type === 'text' || !el.attributes?.type)
      );
      if (!frameInput) throw new Error('Frame input not found');

      console.log('Typing "Human typing"...');
      const start = Date.now();
      const typeAction: Action = { 
        type: 'type', 
        elementId: String(frameInput.index), 
        text: 'Human typing',
        reason: 'Testing iframe typing'
      };
      
      const result = await executeAction(page, typeAction, observation.elements);
      const duration = Date.now() - start;
      
      expect(result.success).toBe(true);
      console.log(`Typing took ${duration}ms`);
      
      const inputValue = await contentFrame?.$eval('#frame-input', (el: any) => el.value);
      expect(inputValue).toBe('Human typing');
      expect(duration).toBeGreaterThan(400); // Verify human delay
    });

    await runStep(7, 'ACTION: Select dropdown option', async () => {
      const frameSelect = observation.elements.find(
        (el: any) => el.tag === 'select' && el.frameSelector
      );
      if (!frameSelect) throw new Error('Frame select not found');

      const selectAction: Action = {
        type: 'select',
        elementId: String(frameSelect.index),
        text: 'opt2',
        reason: 'Testing iframe select'
      };
      const res = await executeAction(page, selectAction, observation.elements);
      expect(res.success).toBe(true);
      
      const val = await contentFrame?.$eval('#frame-select', (el: any) => el.value);
      expect(val).toBe('opt2');
    });

    await runStep(8, 'ACTION: Check checkbox', async () => {
      const frameCheckbox = observation.elements.find(
        (el: any) => el.tag === 'input' && el.attributes?.type === 'checkbox' && el.frameSelector && el.attributes?.id === 'frame-checkbox'
      );
      if (!frameCheckbox) throw new Error('Frame checkbox not found');

      const checkAction: Action = {
        type: 'checkbox',
        elementId: String(frameCheckbox.index),
        text: 'check',
        reason: 'Testing iframe checkbox'
      };
      const res = await executeAction(page, checkAction, observation.elements);
      expect(res.success).toBe(true);
      
      const isChecked = await contentFrame?.$eval('#frame-checkbox', (el: any) => el.checked);
      expect(isChecked).toBe(true);
    });

    await runStep(9, 'ACTION: Multi-Click (3 checkboxes)', async () => {
      const mc1 = observation.elements.find((el: any) => el.attributes?.id === 'mc1' && el.frameSelector);
      const mc2 = observation.elements.find((el: any) => el.attributes?.id === 'mc2' && el.frameSelector);
      const mc3 = observation.elements.find((el: any) => el.attributes?.id === 'mc3' && el.frameSelector);
      
      if (!mc1 || !mc2 || !mc3) throw new Error('Multi-click checkboxes not found');
      
      const multiClickAction: Action = {
          type: 'multi_click',
          elementIds: [String(mc1.index), String(mc2.index), String(mc3.index)],
          reason: 'Testing iframe multi-click'
      };
      const res = await executeAction(page, multiClickAction, observation.elements);
      expect(res.success).toBe(true);
      
      const checkedCount = await contentFrame?.$eval('#multi-checks', (div: any) => 
          Array.from(div.querySelectorAll('input:checked')).length
      );
      expect(checkedCount).toBe(3);
    });

    await runStep(10, 'ACTION: Scroll iframe content', async () => {
      const frameInput = observation.elements.find(
        (el: any) => el.tag === 'input' && el.frameSelector
      ); 
      if (!frameInput) throw new Error('Frame input context not found for scroll');
      
      const initialScrollY = await contentFrame?.evaluate(() => window.scrollY) || 0;
      
      const scrollAction: Action = {
          type: 'scroll',
          elementId: String(frameInput.index),
          text: 'down',
          reason: 'Testing iframe scroll'
      };
      const res = await executeAction(page, scrollAction, observation.elements);
      expect(res.success).toBe(true);
      
      const newScrollY = await contentFrame?.evaluate(() => window.scrollY) || 0;
      // Depending on screen size, it might not scroll if content fits? 
      // But we added a 1000px spacer, so it should scroll.
      expect(newScrollY).toBeGreaterThan(initialScrollY);
    });

    await runStep(11, 'ACTION: Click offscreen element (Auto-scroll)', async () => {
      const bottomBtn = observation.elements.find(
        (el: any) => el.text === 'Bottom Button' && el.frameSelector
      );
      if (!bottomBtn) throw new Error('Bottom button not found');

      // Reset scroll
      await contentFrame?.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      const clickAction: Action = {
          type: 'click',
          elementId: String(bottomBtn.index),
          reason: 'Testing auto-scroll'
      };
      
      const res = await executeAction(page, clickAction, observation.elements);
      expect(res.success).toBe(true);
      
      const finalScrollY = await contentFrame?.evaluate(() => window.scrollY) || 0;
      expect(finalScrollY).toBeGreaterThan(100); 
    });

    await runStep(12, 'ACTION: Main Page Scroll (Show Finish Marker)', async () => {
      const bottomBtn = observation.elements.find(el => el.attributes?.id === 'main-bottom-btn');
      if (!bottomBtn) throw new Error('Main bottom button not found in observation');

      const scrollAction: Action = {
          type: 'scroll_to_element',
          elementId: String(bottomBtn.index),
          reason: 'Scrolling to bottom to see finish marker'
      };
      
      const result = await executeAction(page, scrollAction, observation.elements);
      expect(result.success).toBe(true);
      
      // Verify visual marker is visible
      const isVisible = await page.isVisible('#test-finish-marker');
      console.log(`Finish marker visible: ${isVisible}`);
      expect(isVisible).toBe(true);
    });

    await runStep(13, 'ACTION: Hover (inside iframe)', async () => {
      const hoverTarget = observation.elements.find(el => el.attributes?.id === 'hover-target');
      if (!hoverTarget) throw new Error('Hover target not found');

      const hoverAction: Action = {
          type: 'hover',
          elementId: String(hoverTarget.index),
          reason: 'Testing iframe hover'
      };
      const res = await executeAction(page, hoverAction, observation.elements);
      expect(res.success).toBe(true);

      const text = await contentFrame?.$eval('#hover-target', (el: any) => el.innerText);
      expect(text).toBe('Hovered!');
    });

    await runStep(14, 'ACTION: Drag and Drop (inside iframe)', async () => {
      const source = observation.elements.find(el => el.attributes?.id === 'drag-source');
      const target = observation.elements.find(el => el.attributes?.id === 'drag-target');
      if (!source || !target) throw new Error('Drag source or target not found');

      const dragAction: Action = {
          type: 'drag',
          elementId: String(source.index),
          text: String(target.index), // In our 'drag' implementation, 'text' is often reused for target elementId if not using a separate field
          reason: 'Testing iframe drag'
      };
      // Note: check current executeDrag implementation if it uses text as target elementId
      const res = await executeAction(page, dragAction, observation.elements);
      expect(res.success).toBe(true);

      await page.waitForTimeout(500); // Give it a moment to process the drop
      const text = await contentFrame?.$eval('#drag-target', (el: any) => el.innerText);
      expect(text).toBe('Dropped!');
    });

    await runStep(15, 'ACTION: Wait', async () => {
      const start = Date.now();
      const waitAction: Action = {
          type: 'wait',
          text: '500', // 500ms
          reason: 'Testing wait action'
      };
      const res = await executeAction(page, waitAction, observation.elements);
      expect(res.success).toBe(true);
      const duration = Date.now() - start;
      expect(duration).toBeGreaterThanOrEqual(500);
    });

    await runStep(16, 'ACTION: Navigate', async () => {
      const navigateAction: Action = {
          type: 'navigate',
          text: 'https://www.google.com',
          reason: 'Testing navigate action'
      };
      const res = await executeAction(page, navigateAction, observation.elements);
      expect(res.success).toBe(true);
      expect(page.url()).toContain('google.com');
    });

    // Wait several seconds to visually see the final state (as requested)
    console.log('Test finished. Waiting 5s before closing...');
    await page.waitForTimeout(5000);
  }, 60000);
});
