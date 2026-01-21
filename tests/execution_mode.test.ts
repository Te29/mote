
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from '../src/mote.js';
import * as browser from '../src/browser.js';
import * as observeModule from '../src/observe.js';
import * as checkModule from '../src/reason.js';
import type { Page, Browser, BrowserContext } from 'playwright';
import type { Preset, Goal, PageState } from '../src/types.js';

// Mock Modules
vi.mock('../src/observe.js');
vi.mock('../src/reason.js');
vi.mock('../src/act.js');
vi.mock('../src/interaction.js');

describe('Explore vs Execute Mode', () => {
  let mockPage: any;
  let mockBrowser: any;
  
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock Browser Session
    mockPage = {
      url: () => 'https://example.com/test',
      goto: vi.fn(),
      waitForTimeout: vi.fn(),
      evaluate: vi.fn(), 
      close: vi.fn(),
    };
    
    // Mock Browser launch
    vi.spyOn(browser, 'launchBrowser').mockResolvedValue({
      browser: {} as Browser,
      context: {} as BrowserContext,
      page: mockPage as Page,
    });
    
    vi.spyOn(browser, 'navigateTo').mockResolvedValue();
    vi.spyOn(browser, 'closeBrowser').mockResolvedValue();

    // Default mocks for generic helpers
    vi.spyOn(checkModule, 'validateSessionPlan').mockReturnValue({ valid: true, errors: [] });
    
    const actModule = await import('../src/act.js');
    vi.spyOn(actModule, 'executeAction').mockResolvedValue({ success: true });
    
    // Default mock for interaction
    const interactionModule = await import('../src/interaction.js');
    vi.spyOn(interactionModule, 'requestIntervention').mockResolvedValue({ type: 'approve' });
    vi.spyOn(interactionModule, 'shouldIntervene').mockReturnValue(false); 
  });

  it('should run in Explore Mode when no cached path exists', async () => {
    // Setup: Routine observation
    vi.spyOn(observeModule, 'observe').mockResolvedValue({
      url: 'https://example.com',
      title: 'Test',
      markdown: 'Page Content',
      elements: [{ index: 1, tag: 'button', text: 'Click Me', selector: '#btn', attributes: {} }],
    });

    // Setup: Routine thinking
    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'generatePlan').mockResolvedValue({
         goalSummary: 'Test',
         cycleDescription: 'Test Cycle',
         cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
    } as any);
    vi.spyOn(checkModule, 'think').mockResolvedValueOnce({
      type: 'ACTION',
      action: { type: 'click', selector: '1', reason: 'Clicking button' }
    }).mockResolvedValueOnce({
      type: 'GOAL_SUCCESS', finalAnswer: 'Done'
    });
    
    // Fix: Mock validateSessionPlan to avoid crash
    vi.spyOn(checkModule, 'validateSessionPlan').mockReturnValue({ valid: true, errors: [] });

    // Run
    const result = await runAgent({
      goal: { name: 'Test', description: 'Test Goal' },
      headless: true
    });

    // Verify
    expect(result.success).toBe(true);
    // Should call full observe (no arguments)
    expect(observeModule.observe).toHaveBeenCalledWith(mockPage); 
    // Should not call observe with selector array
    expect(observeModule.observe).not.toHaveBeenCalledWith(mockPage, expect.any(Array));
  });

  it('should run in Execute Mode when cached path exists and matches', async () => {
    // Setup: Mock Preset with Execution Path
    const cachedAction = { type: 'click', selector: '#exact-btn', reason: 'Cached Click' } as const;
    const preset: Preset = {
      name: 'Cached Test',
      description: 'Test with cache',
      sessionPlan: {
         goalSummary: 'Test', cycleDescription: 'Test', cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
      },
      systemPrompt: 'You are helpful',
      executionPath: [{
        stepId: '1',
        description: 'Cached Step 1',
        url: 'https://example.com/test',
        targetElementSelector: '#exact-btn',
        action: cachedAction,
        expectedPageState: {} as any // Not used in simple check yet
      }]
    };

    // Setup: Observe - FIRST call is targeted (Execute Mode)
    // We expect it to find the element
    vi.spyOn(observeModule, 'observe').mockImplementation(async (page, selectors) => {
      if (selectors && selectors.includes('#exact-btn')) {
        return {
           url: 'https://example.com/test', title: 'Test', markdown: '',
           elements: [{ index: 1, tag: 'button', text: 'Target', selector: '#exact-btn', attributes: {} }]
        };
      }
      return { url: 'https://example.com', title: 'Full Scan', markdown: '', elements: [] };
    });


    
    // MOCK THINK:
    // Step 1: Execute Mode (skipped)
    // Step 2: Loop continues -> Calls Think -> We return SUCCESS to stop loop
    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'think').mockResolvedValue({
        type: 'GOAL_SUCCESS', finalAnswer: 'Done after cached step'
    });

    // Run
    const result = await runAgent({
      preset,
      headless: true
    });

    // Verify
    expect(result.success).toBe(true);
    // Should call observe WITH selectors first (Step 1)
    expect(observeModule.observe).toHaveBeenCalledWith(mockPage, ['#exact-btn']);
    
    // Should NOT call think for Step 1 (Execute Mode), but WILL call for Step 2
    expect(checkModule.think).toHaveBeenCalledTimes(1);
    
    // Verify first action in history was the cached one
    expect(result.history[0].action).toEqual(cachedAction);
  });

  it('should fallback to Explore Mode if drift detected', async () => {
    // Setup: Mock Preset with Execution Path
    const preset: Preset = {
      name: 'Cached Test',
      description: 'Test with cache',
      sessionPlan: {
         goalSummary: 'Test', cycleDescription: 'Test', cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
      },
      systemPrompt: 'You are helpful',
      executionPath: [{
        stepId: '1', description: 'Cached Step 1', url: 'https://example.com',
        targetElementSelector: '#missing-btn', // This will NOT be found
        action: { type: 'click', reason: 'Cached' },
        expectedPageState: {} as any
      }]
    };

    // Setup: Observe logic
    vi.spyOn(observeModule, 'observe').mockImplementation(async (page, selectors) => {
      // 1. Execute Mode check -> Returns empty (DRIFT!)
      if (selectors && selectors.includes('#missing-btn')) {
        return { url: 'https://example.com', title: 'Test', markdown: '', elements: [] };
      }
      // 2. Fallback -> Returns full page
      return { 
        url: 'https://example.com', title: 'Fallback Mock', markdown: 'Found real content',
        elements: [{ index: 1, tag: 'div', text: 'Real Content', selector: '#real', attributes: {} }]
      };
    });

    // Setup: Think (fallback should trigger this)
    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'think').mockResolvedValue({
       type: 'GOAL_SUCCESS', finalAnswer: 'Recovered'
    });

    // Run
    const result = await runAgent({
      preset,
      headless: true
    });

    // Verify
    // 1. Called with selector (Execute Attempt)
    expect(observeModule.observe).toHaveBeenCalledWith(mockPage, ['#missing-btn']);
    // 2. Called without selector (Explore Fallback)
    expect(observeModule.observe).toHaveBeenCalledWith(mockPage);
    // 3. Called think (meaning we used LLM)
    expect(checkModule.think).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
