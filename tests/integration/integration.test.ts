
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from '../../src/mote.js';
import * as browser from '../../src/browser.js';
import * as observeModule from '../../src/observe.js';
import * as checkModule from '../../src/reason.js';
import type { Page, Browser, BrowserContext } from 'playwright';
import type { Preset, Goal, PageState } from '../../src/types/index.js';

// Mock Modules
vi.mock('../../src/observe.js');
vi.mock('../../src/reason.js');
vi.mock('../../src/act.js');
vi.mock('../../src/interaction.js');
vi.mock('../../src/browser.js');
vi.mock('../../src/utils/debug.js', () => ({
  createTraceProxy: <T extends object>(target: T, _name: string) => target,
  logVariable: vi.fn(),
  logPromptToFile: vi.fn(),
}));

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
    
    const actModule = await import('../../src/act.js');
    vi.spyOn(actModule, 'executeAction').mockResolvedValue({ success: true });
    
    // Default mock for interaction
    const interactionModule = await import('../../src/interaction.js');
    vi.spyOn(interactionModule, 'requestIntervention').mockResolvedValue({ type: 'approve' });
    vi.spyOn(interactionModule, 'shouldIntervene').mockReturnValue(false); 
    vi.spyOn(interactionModule, 'startInterruptListener').mockReturnValue();
    vi.spyOn(interactionModule, 'checkInterrupt').mockReturnValue(false);
    vi.spyOn(interactionModule, 'stopInterruptListener').mockReturnValue();
    vi.spyOn(interactionModule, 'promptForPresetSave').mockResolvedValue({ type: 'discard' });
    vi.spyOn(interactionModule, 'promptForPresetSave').mockResolvedValue({ type: 'discard' });
    vi.spyOn(interactionModule, 'promptForUrlError').mockResolvedValue({ type: 'quit' });
    
    // Mock generateStrategy to prevent crashes in handleCycleSuccess
    if ('generateStrategy' in checkModule) {
      vi.spyOn(checkModule, 'generateStrategy').mockResolvedValue(undefined);
    }
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

  it('should run with preset and execution path provided', async () => {
    // In the current handler architecture, execution path is passed through config
    // but the observe handler always does full observation (Explore mode).
    // Execute Mode with targeted selectors is planned for future implementation.
    const preset: Preset = {
      name: 'Cached Test',
      description: 'Test with cache',
      goal: { name: 'Test', description: 'Test Goal' },
      sessionPlan: {
         goalSummary: 'Test', cycleDescription: 'Test', cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
      }
    };
    const executionPath = [{
      stepId: '1',
      description: 'Cached Step 1',
      url: 'https://example.com/test',
      targetElementSelector: '#exact-btn',
      action: { type: 'click' as const, selector: '#exact-btn', reason: 'Cached Click' },
      expectedPageState: {} as any
    }];

    vi.spyOn(observeModule, 'observe').mockResolvedValue({
      url: 'https://example.com/test', title: 'Test', markdown: '',
      elements: [{ index: 1, tag: 'button', text: 'Target', selector: '#exact-btn', attributes: {} }]
    });

    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'think').mockResolvedValue({
        type: 'GOAL_SUCCESS', finalAnswer: 'Done'
    });

    const result = await runAgent({
      preset,
      executionPath,
      headless: true
    });

    // Verify agent completes successfully with preset
    expect(result.success).toBe(true);
    // In current architecture, observe is called without selectors (full observation)
    expect(observeModule.observe).toHaveBeenCalledWith(mockPage);
    expect(checkModule.think).toHaveBeenCalled();
  });

  it('should use full observation and LLM reasoning in explore mode', async () => {
    // In the current handler architecture, observe always does full observation.
    // The LLM (think) is always called to decide the next action.
    const preset: Preset = {
      name: 'Cached Test',
      description: 'Test with cache',
      goal: { name: 'Test', description: 'Test Goal' },
      sessionPlan: {
         goalSummary: 'Test', cycleDescription: 'Test', cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
      }
    };

    vi.spyOn(observeModule, 'observe').mockResolvedValue({
      url: 'https://example.com', title: 'Test', markdown: 'Found real content',
      elements: [{ index: 1, tag: 'div', text: 'Real Content', selector: '#real', attributes: {} }]
    });

    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'think').mockResolvedValue({
       type: 'GOAL_SUCCESS', finalAnswer: 'Recovered'
    });

    const result = await runAgent({
      preset,
      headless: true
    });

    // Verify full observation (no selectors) and LLM reasoning
    expect(observeModule.observe).toHaveBeenCalledWith(mockPage);
    expect(checkModule.think).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('should handle preset with execution path through explore mode fallback', async () => {
    // In the current handler architecture, the agent always uses explore mode.
    // Even when an execution path is provided, observe does full observation
    // and reason (think) is always called. Execute Mode with drift evaluation
    // is planned for future implementation.

    const preset: Preset = {
      name: 'Self-Healing Test',
      description: 'Test with execution path',
      goal: { name: 'Test', description: 'Test Goal' },
      sessionPlan: {
         goalSummary: 'Test', cycleDescription: 'Test', cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
      }
    };
    const executionPath = [{
      stepId: '1', description: 'Step needing adaptation', url: 'https://example.com',
      targetElementSelector: '#old-btn',
      action: { type: 'click' as const, selector: '1', reason: 'Click button' },
      expectedPageState: { url: 'https://example.com', title: 'Expected', markdown: '', elements: [] } as PageState
    }];

    vi.spyOn(observeModule, 'observe').mockResolvedValue({
      url: 'https://example.com/updated', title: 'Test', markdown: '',
      elements: [{ index: 1, tag: 'button', text: 'Updated Button', selector: '#old-btn', attributes: {} }]
    });

    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'think').mockResolvedValue({
       type: 'GOAL_SUCCESS', finalAnswer: 'Done'
    });

    const result = await runAgent({
      preset,
      executionPath,
      headless: true
    });

    // Verify agent succeeds through explore mode
    expect(result.success).toBe(true);
    expect(observeModule.observe).toHaveBeenCalled();
    expect(checkModule.think).toHaveBeenCalled();
  });

  it('should track history for self-healing preset update', async () => {
    // Test that successful exploration records steps in history for future preset update

    vi.spyOn(observeModule, 'observe').mockResolvedValue({
      url: 'https://example.com', title: 'Test', markdown: 'Content',
      elements: [
        { index: 1, tag: 'button', text: 'Step 1 Button', selector: '#btn1', attributes: {} },
        { index: 2, tag: 'input', text: 'Step 2 Input', selector: '#input2', attributes: {} },
      ]
    });

    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'generatePlan').mockResolvedValue({
         goalSummary: 'Test',
         cycleDescription: 'Test Cycle',
         cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
    } as any);
    
    // Multi-step exploration that should be recordable as execution path
    vi.spyOn(checkModule, 'think')
      .mockResolvedValueOnce({
        type: 'ACTION',
        action: { type: 'click', selector: '1', reason: 'Click first button' }
      })
      .mockResolvedValueOnce({
        type: 'ACTION',
        action: { type: 'type', selector: '2', text: 'test input', reason: 'Type into field' }
      })
      .mockResolvedValueOnce({
        type: 'GOAL_SUCCESS', finalAnswer: 'Exploration complete'
      });

    const result = await runAgent({
      goal: { name: 'Self-Healing Source', description: 'Multi-step goal to record' },
      headless: true
    });

    // Verify: History should contain the steps for potential extraction
    expect(result.success).toBe(true);
    expect(result.history.length).toBeGreaterThanOrEqual(2);
    
    // Verify actions are recorded in history
    expect(result.history[0].action.type).toBe('click');
    expect(result.history[1].action.type).toBe('type');
    
    // In real implementation, extractPathFromHistory(result.history) would create ExecutionPath
    // This validates the history structure is suitable for extraction
  });

  it('should execute a multi-step Explore Mode workflow with state changes', async () => {
    // Scenario:
    // 1. Start at https://example.com/step1
    // 2. Observe -> Think -> Decide to click 'Next'
    // 3. Action executed -> Page state changes
    // 4. Observe (new state) -> Think -> Decide Success
    //
    // In the handler architecture:
    //   handleObserve (call 1) → handleReason (think 1 → ACTION) → handleAct →
    //   handleObserve (call 2) → handleReason (think 2 → GOAL_SUCCESS) → handleCycleEnd → TERMINATED

    const page1State = {
      url: 'https://example.com/step1',
      title: 'Step 1',
      markdown: 'Page 1 Content',
      elements: [{ index: 1, tag: 'button', text: 'Next', selector: '#next', attributes: {} }]
    };

    const page2State = {
      url: 'https://example.com/step2',
      title: 'Step 2',
      markdown: 'Page 2 Content',
      elements: [{ index: 1, tag: 'div', text: 'Success', selector: '#success', attributes: {} }]
    };

    vi.spyOn(observeModule, 'observe')
      .mockResolvedValueOnce(page1State as any) // handleObserve call 1
      .mockImplementationOnce(async () => {
         // After action, page URL changed
         mockPage.url = vi.fn().mockReturnValue('https://example.com/step2');
         return page2State as any;
      }); // handleObserve call 2

    // Ensure initial URL is correct
    mockPage.url = vi.fn().mockReturnValue('https://example.com/step1');

    // Setup: Think sequences
    vi.spyOn(checkModule, 'createLLMClient').mockReturnValue({} as any);
    vi.spyOn(checkModule, 'generatePlan').mockResolvedValue({
         goalSummary: 'Multi-step Test',
         cycleDescription: 'Test Cycle',
         cycles: [{ isCompleted: false, cycleSteps: [] }],
         startedAt: '', lastUpdatedAt: ''
    } as any);

    vi.spyOn(checkModule, 'think')
      .mockResolvedValueOnce({
        type: 'ACTION',
        action: { type: 'click', selector: '1', reason: 'Go to next step' }
      })
      .mockResolvedValueOnce({
        type: 'GOAL_SUCCESS',
        finalAnswer: 'Reached Step 2'
      });

    // Run
    const result = await runAgent({
      goal: { name: 'Multi-step Flow', description: 'Navigate through steps' },
      startUrl: 'https://example.com/step1',
      headless: true
    });

    // Verify
    expect(result.success).toBe(true);
    expect(result.history.length).toBe(1); // One action taken
    expect(result.finalUrl).toBe('https://example.com/step2');

    // In handler architecture: 2 observe calls (one per OBSERVE state), 2 think calls
    expect(observeModule.observe).toHaveBeenCalledTimes(2);
    expect(checkModule.think).toHaveBeenCalledTimes(2);

    // Verify first action
    expect(result.history[0].action.type).toBe('click');
    expect(result.history[0].action.reason).toBe('Go to next step');
  });
});
