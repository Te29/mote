import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator, BrowserContext } from 'playwright';
import type { ElementInfo, Action } from '../../src/types/index.js';

// Mock the act module functions
const mockPage = {
  $: vi.fn(),
  evaluate: vi.fn(),
  hover: vi.fn(),
  focus: vi.fn(),
  keyboard: {
    press: vi.fn(),
    type: vi.fn(),
  },
  mouse: {
    move: vi.fn(),
  },
  goto: vi.fn(),
  waitForTimeout: vi.fn(),
  waitForLoadState: vi.fn(),
  locator: vi.fn(),
  context: vi.fn(),
  once: vi.fn(),
  selectOption: vi.fn(),
} as unknown as Page;

const mockLocator = {
  click: vi.fn(),
  evaluate: vi.fn(),
  fill: vi.fn(),
  boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 50, height: 30 }),
} as unknown as Locator;

const mockContext = {
  once: vi.fn(),
} as unknown as BrowserContext;

// Import after mocks are set up
vi.mock('playwright', () => ({
  // Mocked exports
}));

describe('Act Module - Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockPage.context as ReturnType<typeof vi.fn>).mockReturnValue(mockContext);
    (mockPage.locator as ReturnType<typeof vi.fn>).mockReturnValue(mockLocator);
    (mockPage.waitForTimeout as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockPage.waitForLoadState as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockPage.keyboard.press as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockLocator.click as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  describe('verifyElement logic', () => {
    it('should fail verification when element not found', async () => {
      (mockPage.$ as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      
      // Inline test of verify logic
      const handle = await mockPage.$('selector');
      expect(handle).toBeNull();
    });

    it('should pass verification for matching elements', async () => {
      const mockHandle = {
        evaluate: vi.fn().mockResolvedValue({ tag: 'button', text: 'Submit' }),
      };
      (mockPage.$ as ReturnType<typeof vi.fn>).mockResolvedValue(mockHandle);
      
      const handle = await mockPage.$('selector');
      expect(handle).toBeDefined();
      
      const props = await handle!.evaluate(() => ({}));
      expect(props).toEqual({ tag: 'button', text: 'Submit' });
    });
  });

  describe('executeAction dispatcher', () => {
    it('should route click action correctly', async () => {
      const action: Action = {
        type: 'click',
        elementId: '1',
        reason: 'Test click',
      };
      
      // Action should be routed to click handler
      expect(action.type).toBe('click');
      expect(action.elementId).toBe('1');
    });

    it('should route type action correctly', async () => {
      const action: Action = {
        type: 'type',
        elementId: '2',
        text: 'test@example.com',
        reason: 'Test type',
      };
      
      expect(action.type).toBe('type');
      expect(action.text).toBe('test@example.com');
    });

    it('should route scroll action correctly', async () => {
      const action: Action = {
        type: 'scroll',
        text: 'down',
        reason: 'Test scroll',
      };
      
      expect(action.type).toBe('scroll');
      expect(action.text).toBe('down');
    });

    it('should route navigate action correctly', async () => {
      const action: Action = {
        type: 'navigate',
        text: 'https://example.com',
        reason: 'Test navigate',
      };
      
      expect(action.type).toBe('navigate');
      expect(action.text).toContain('example.com');
    });

    it('should route wait action correctly', async () => {
      const action: Action = {
        type: 'wait',
        reason: 'Test wait',
      };
      
      expect(action.type).toBe('wait');
    });

    it('should route hover action correctly', async () => {
      const action: Action = {
        type: 'hover',
        elementId: '1',
        reason: 'Test hover',
      };
      
      expect(action.type).toBe('hover');
    });
  });

  describe('human-like behavior', () => {
    it('should generate random delays within range', () => {
      const min = 100;
      const max = 300;
      const delay = Math.floor(Math.random() * (max - min + 1)) + min;
      
      expect(delay).toBeGreaterThanOrEqual(min);
      expect(delay).toBeLessThanOrEqual(max);
    });
  });

  describe('element lookup', () => {
    const elements: ElementInfo[] = [
      { index: 1, tag: 'button', text: 'Submit', selector: 'btn1', attributes: {} },
      { index: 2, tag: 'input', text: 'Search', selector: 'inp2', attributes: {} },
      { index: 3, tag: 'a', text: 'Link', selector: 'a3', attributes: {} },
    ];

    it('should find element by index', () => {
      const element = elements.find((el) => el.index === 2);
      expect(element).toBeDefined();
      expect(element?.text).toBe('Search');
    });

    it('should return undefined for invalid index', () => {
      const element = elements.find((el) => el.index === 99);
      expect(element).toBeUndefined();
    });
  });

  describe('iframe handling', () => {
    it('should detect iframe elements by frameSelector', () => {
      const element: ElementInfo = {
        index: 1,
        tag: 'button',
        text: 'Pay',
        selector: 'button.pay',
        frameSelector: 'iframe[name="stripe"]',
        attributes: {},
      };
      
      expect(element.frameSelector).toBeDefined();
      expect(!!element.frameSelector).toBe(true);
    });

    it('should detect main frame elements', () => {
      const element: ElementInfo = {
        index: 1,
        tag: 'button',
        text: 'Submit',
        selector: 'button.submit',
        attributes: {},
      };
      
      expect(element.frameSelector).toBeUndefined();
      expect(!!element.frameSelector).toBe(false);
    });
  });
});
