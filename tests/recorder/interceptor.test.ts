import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionInterceptor } from '../../src/recorder/interceptor.js';
import type { Page, Frame } from 'playwright';

describe('ActionInterceptor', () => {
  let mockPage: Page;

  beforeEach(() => {
    mockPage = {
      url: vi.fn().mockReturnValue('https://example.com'),
      exposeFunction: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      mainFrame: vi.fn().mockReturnValue({} as Frame),
    } as unknown as Page;
  });

  describe('constructor', () => {
    it('should create interceptor with page', () => {
      const interceptor = new ActionInterceptor(mockPage);
      expect(interceptor).toBeDefined();
    });
  });

  describe('attach', () => {
    it('should expose callback function to browser', async () => {
      const interceptor = new ActionInterceptor(mockPage);
      await interceptor.attach();

      expect(mockPage.exposeFunction).toHaveBeenCalledWith(
        '__moteRecordAction',
        expect.any(Function),
      );
    });

    it('should inject capture script', async () => {
      const interceptor = new ActionInterceptor(mockPage);
      await interceptor.attach();

      expect(mockPage.addInitScript).toHaveBeenCalled();
    });

    it('should evaluate script on current page', async () => {
      const interceptor = new ActionInterceptor(mockPage);
      await interceptor.attach();

      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('should listen for navigation events', async () => {
      const interceptor = new ActionInterceptor(mockPage);
      await interceptor.attach();

      expect(mockPage.on).toHaveBeenCalledWith('framenavigated', expect.any(Function));
    });

    it('should not attach twice', async () => {
      const interceptor = new ActionInterceptor(mockPage);
      await interceptor.attach();
      await interceptor.attach();

      // Should only be called once
      expect(mockPage.exposeFunction).toHaveBeenCalledTimes(1);
    });
  });

  describe('waitForAction', () => {
    it('should return queued action immediately if available', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      // Simulate receiving an action
      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      // Simulate action from browser
      capturedCallback({
        type: 'click',
        tag: 'button',
        text: 'Submit',
        selector: '#submit',
        alternativeSelectors: [],
        attributes: { id: 'submit' },
      });

      const action = await interceptor.waitForAction();

      expect(action.type).toBe('click');
      expect(action.selector).toBe('#submit');
    });

    it('should wait for action if queue is empty', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      // Start waiting before action arrives
      const actionPromise = interceptor.waitForAction();

      // Simulate action arriving later
      setTimeout(() => {
        capturedCallback({
          type: 'type',
          tag: 'input',
          text: '',
          selector: 'input[name="email"]',
          alternativeSelectors: [],
          value: 'test@example.com',
          attributes: { name: 'email' },
        });
      }, 10);

      const action = await actionPromise;

      expect(action.type).toBe('type');
      expect(action.value).toBe('test@example.com');
    });
  });

  describe('hasPendingActions', () => {
    it('should return false initially', () => {
      const interceptor = new ActionInterceptor(mockPage);
      expect(interceptor.hasPendingActions()).toBe(false);
    });

    it('should return true when actions are queued', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      // Queue an action
      capturedCallback({
        type: 'click',
        tag: 'button',
        text: 'Test',
        selector: '#test',
        alternativeSelectors: [],
        attributes: {},
      });

      expect(interceptor.hasPendingActions()).toBe(true);
    });
  });

  describe('clearQueue', () => {
    it('should clear pending actions', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      // Queue actions
      capturedCallback({
        type: 'click',
        tag: 'button',
        text: 'Test',
        selector: '#test',
        alternativeSelectors: [],
        attributes: {},
      });

      expect(interceptor.hasPendingActions()).toBe(true);

      interceptor.clearQueue();

      expect(interceptor.hasPendingActions()).toBe(false);
    });
  });

  describe('detach', () => {
    it('should clear state on detach', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      // Queue an action
      capturedCallback({
        type: 'click',
        tag: 'button',
        text: 'Test',
        selector: '#test',
        alternativeSelectors: [],
        attributes: {},
      });

      interceptor.detach();

      expect(interceptor.hasPendingActions()).toBe(false);
    });
  });

  describe('action type mapping', () => {
    it('should map checkbox input click to checkbox type', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      capturedCallback({
        type: 'click',
        tag: 'input',
        text: '',
        selector: 'input[type="checkbox"]',
        alternativeSelectors: [],
        attributes: { type: 'checkbox' },
      });

      const action = await interceptor.waitForAction();
      expect(action.type).toBe('checkbox');
    });

    it('should map select change to select type', async () => {
      const interceptor = new ActionInterceptor(mockPage);

      let capturedCallback: (data: any) => void = () => {};
      (mockPage.exposeFunction as any).mockImplementation(
        (_name: string, callback: (data: any) => void) => {
          capturedCallback = callback;
          return Promise.resolve();
        },
      );

      await interceptor.attach();

      capturedCallback({
        type: 'change',
        tag: 'select',
        text: 'Option 1',
        selector: 'select[name="country"]',
        alternativeSelectors: [],
        value: 'us',
        attributes: { name: 'country' },
      });

      const action = await interceptor.waitForAction();
      expect(action.type).toBe('select');
    });
  });
});
