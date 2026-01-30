import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as mote from '../../src/mote.js';
import * as interaction from '../../src/interaction.js';
import * as browser from '../../src/browser.js';
import * as observe from '../../src/observe.js';
import * as reason from '../../src/reason.js';
import * as handlers from '../../src/handlers/index.js';
import {
  type SessionTracker,
  type CycleTracker,
  type PageState,
  type ThinkResult,
  type AgentResult,
  type AgentState,
  type AgentStateCycleStart,
  type AgentStateObserve,
  type AgentStateReason,
  type AgentStateAct,
  type AgentStateCycleEnd,
  createTimestamp,
} from '../../src/types/index.js';

// Mock all external dependencies
vi.mock('../../src/interaction');
vi.mock('../../src/browser');
vi.mock('../../src/observe');
vi.mock('../../src/reason');
vi.mock('../../src/handlers/index');
vi.mock('fs'); // Mock fs to avoid file system reads for profile check

describe('Mote Agent Loop (Mocked)', () => {
  // Common mock objects
  const mockPage = {
    url: vi.fn().mockReturnValue('about:blank'),
    waitForTimeout: vi.fn(),
    close: vi.fn(),
  } as any;

  const mockBrowser = {
    page: mockPage,
    browser: { close: vi.fn() },
  } as any;

  const mockLLMClient = {
    chat: { completions: { create: vi.fn() } },
  } as any;

  const mockPlan: SessionTracker = {
    goalSummary: 'Test Goal',
    cycleDescription: 'Test Cycle',
    cycles: [
      {
        isCompleted: false,
        cycleSteps: [],
      },
    ],
    startedAt: createTimestamp(),
    lastUpdatedAt: createTimestamp(),
  };

  const mockPageState: PageState = {
    url: 'https://example.com',
    title: 'Example',
    markdown: 'Page Content',
    elements: [],
  };

  beforeEach(() => {
    vi.resetAllMocks();

    // Setup default mock behaviors
    vi.spyOn(browser, 'launchBrowser').mockResolvedValue(mockBrowser);
    vi.spyOn(browser, 'navigateTo').mockResolvedValue();
    vi.spyOn(browser, 'closeBrowser').mockResolvedValue();

    mockPage.url.mockReturnValue('about:blank');

    vi.spyOn(observe, 'observe').mockResolvedValue(mockPageState);

    vi.spyOn(reason, 'createLLMClient').mockReturnValue(mockLLMClient);
    vi.spyOn(reason, 'generatePlan').mockResolvedValue(mockPlan);
    vi.spyOn(reason, 'validateSessionPlan').mockReturnValue({ valid: true, errors: [] });
    vi.spyOn(reason, 'think').mockResolvedValue({
      type: 'GOAL_SUCCESS', // Default to immediate success
      finalAnswer: 'Done',
    });

    // Mock handlers to return proper AgentState objects (new 6-state design)
    vi.spyOn(handlers, 'handleCycleStart').mockImplementation(async (state: AgentStateCycleStart) => ({
      phase: 'OBSERVE' as const,
      cycleIndex: state.cycleIndex,
    }));

    vi.spyOn(handlers, 'handleObserve').mockImplementation(async (state: AgentStateObserve) => ({
      phase: 'REASON' as const,
      cycleIndex: state.cycleIndex,
      pageState: mockPageState,
    }));

    vi.spyOn(handlers, 'handleReason').mockImplementation(async (state: AgentStateReason) => ({
      phase: 'CYCLE_END' as const,
      cycleIndex: state.cycleIndex,
      result: 'SUCCESS' as const,
      detail: 'Done',
    }));

    vi.spyOn(handlers, 'handleAct').mockImplementation(async (state: AgentStateAct) => ({
      phase: 'OBSERVE' as const,
      cycleIndex: state.cycleIndex,
    }));

    vi.spyOn(handlers, 'handleCycleEnd').mockImplementation(async (state: AgentStateCycleEnd) => ({
      phase: 'TERMINATED' as const,
      success: state.result === 'SUCCESS',
      message: state.detail || (state.result === 'SUCCESS' ? 'Goal achieved' : 'Failed'),
    }));

    // Mock interaction to avoid hanging on prompts
    vi.spyOn(interaction, 'shouldIntervene').mockReturnValue(false);
    vi.spyOn(interaction, 'startInterruptListener').mockImplementation(() => {});
    vi.spyOn(interaction, 'stopInterruptListener').mockImplementation(() => {});
    vi.spyOn(interaction, 'closeReadline').mockImplementation(() => {});
    vi.spyOn(interaction, 'promptForLogin').mockResolvedValue();
    vi.spyOn(interaction, 'checkInterrupt').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should run a successful agent session', async () => {
    const result = await mote.runAgent({
      overrides: {
        goal: { name: 'Test', description: 'Test Description' },
        startUrl: 'https://example.com',
        engagementMode: 'autonomous',
        stepPause: 0,
        verbose: false,
      }
    });

    expect(browser.launchBrowser).toHaveBeenCalled();
    expect(browser.navigateTo).toHaveBeenCalledWith(mockPage, 'https://example.com');
    expect(handlers.handleCycleStart).toHaveBeenCalled();
    expect(handlers.handleObserve).toHaveBeenCalled();
    expect(handlers.handleReason).toHaveBeenCalled();
    expect(handlers.handleCycleEnd).toHaveBeenCalled();
    expect(browser.closeBrowser).toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(result.message).toBe('Done');
  });

  it('should handle action execution loop', async () => {
    // Override handleReason to return ACTION first, then GOAL_SUCCESS
    vi.spyOn(handlers, 'handleReason').mockImplementationOnce(async (state: AgentStateReason) => ({
      phase: 'ACT' as const,
      cycleIndex: state.cycleIndex,
      action: { type: 'click', elementId: '1', reason: 'Test click' },
      pageState: state.pageState,
    })).mockImplementationOnce(async (state: AgentStateReason) => ({
      phase: 'CYCLE_END' as const,
      cycleIndex: state.cycleIndex,
      result: 'SUCCESS' as const,
      detail: 'Done',
    }));

    const result = await mote.runAgent({
      overrides: {
        goal: { name: 'Test Action', description: 'Test Action' },
        startUrl: 'https://example.com',
        engagementMode: 'autonomous',
        stepPause: 0,
        verbose: false,
      }
    });

    expect(handlers.handleObserve).toHaveBeenCalledTimes(2);
    expect(handlers.handleReason).toHaveBeenCalledTimes(2);
    expect(handlers.handleAct).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('should handle failures gracefully', async () => {
    // Override handleReason to return FAILURE
    vi.spyOn(handlers, 'handleReason').mockImplementationOnce(async (state: AgentStateReason) => ({
      phase: 'CYCLE_END' as const,
      cycleIndex: state.cycleIndex,
      result: 'FAILURE' as const,
      detail: 'Failed as expected',
    }));

    const result = await mote.runAgent({
      overrides: {
        goal: { name: 'Test Fail', description: 'Fail Description' },
        startUrl: 'https://example.com',
        engagementMode: 'autonomous',
        stepPause: 0,
        verbose: false,
      }
    });

    expect(handlers.handleCycleEnd).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed as expected');
  });

  it('should respect maxSteps limit', async () => {
     const originalEnv = process.env;
     process.env = { ...originalEnv, MAX_STEPS: '2' };

     let observeCallCount = 0;

     // Override handleObserve to track calls and terminate after 2
     vi.spyOn(handlers, 'handleObserve').mockImplementation(async (state: AgentStateObserve) => {
       observeCallCount++;

       // Terminate on second observe call (simulating maxSteps=2 check)
       if (observeCallCount >= 2) {
         return {
           phase: 'TERMINATED' as const,
           success: false,
           message: `Reached maximum steps (2) without completing goal`,
         };
       }

       return {
         phase: 'REASON' as const,
         cycleIndex: state.cycleIndex,
         pageState: mockPageState,
       };
     });

     // Override handleReason to always return ACTION (infinite loop without maxSteps)
     vi.spyOn(handlers, 'handleReason').mockImplementation(async (state: AgentStateReason) => ({
       phase: 'ACT' as const,
       cycleIndex: state.cycleIndex,
       action: { type: 'click', elementId: '1', reason: 'Test click' },
       pageState: state.pageState,
     }));

     const result = await mote.runAgent({
      overrides: {
        goal: { name: 'Test Max Steps', description: 'Loop forever' },
        startUrl: 'https://example.com',
        engagementMode: 'autonomous',
        stepPause: 0,
        verbose: false,
      }
     });

     process.env = originalEnv; // Restore env

     // Should stop after 2 observe calls
     expect(result.success).toBe(false);
     expect(result.message).toContain('Reached maximum steps');
     expect(handlers.handleObserve).toHaveBeenCalledTimes(2);
  });
});
