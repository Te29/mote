import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as mote from '../../src/mote';
import * as interaction from '../../src/interaction';
import * as browser from '../../src/browser';
import * as observe from '../../src/observe';
import * as reason from '../../src/reason';
import * as handlers from '../../src/handlers/index';
import {
  type ConfigInput,
  type SessionTracker,
  type Cycle,
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
} from '../../src/types';

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
    url: () => 'https://example.com',
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
    const config: ConfigInput = {
      goal: { name: 'Test', description: 'Test Description' },
      startUrl: 'https://example.com',
      engagementMode: 'autonomous',
      stepPause: 0,
      verbose: false,
    };

    // State machine flow: CYCLE_START -> OBSERVE -> REASON -> CYCLE_END -> TERMINATED
    // Handlers are mocked in beforeEach

    const result = await mote.runAgent(config);

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
    const config: ConfigInput = {
      goal: { name: 'Test Action', description: 'Test Action' },
      startUrl: 'https://example.com',
      engagementMode: 'autonomous',
      stepPause: 0,
      verbose: false,
    };

    // State machine flow:
    // CYCLE_START -> OBSERVE -> REASON -> ACT -> OBSERVE -> REASON -> CYCLE_END -> TERMINATED
    vi.spyOn(handlers, 'handleReason')
      .mockResolvedValueOnce({
        phase: 'ACT' as const,
        cycleIndex: 0,
        action: { type: 'click', selector: '1', reason: 'Click it' },
        pageState: mockPageState,
      })
      .mockResolvedValueOnce({
        phase: 'CYCLE_END' as const,
        cycleIndex: 0,
        result: 'SUCCESS' as const,
        detail: 'Done',
      });

    vi.spyOn(handlers, 'handleAct').mockResolvedValue({
      phase: 'OBSERVE' as const,
      cycleIndex: 0,
    });

    const result = await mote.runAgent(config);

    expect(handlers.handleObserve).toHaveBeenCalledTimes(2);
    expect(handlers.handleReason).toHaveBeenCalledTimes(2);
    expect(handlers.handleAct).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('should handle failures gracefully', async () => {
    const config: ConfigInput = {
      goal: { name: 'Test Fail', description: 'Fail Description' },
      startUrl: 'https://example.com',
      engagementMode: 'autonomous',
      stepPause: 0,
      verbose: false,
    };

    // State machine flow: CYCLE_START -> OBSERVE -> REASON -> CYCLE_END (FAILURE) -> TERMINATED
    vi.spyOn(handlers, 'handleReason').mockResolvedValue({
      phase: 'CYCLE_END' as const,
      cycleIndex: 0,
      result: 'FAILURE' as const,
      detail: 'Something went wrong',
    });

    vi.spyOn(handlers, 'handleCycleEnd').mockResolvedValue({
      phase: 'TERMINATED' as const,
      success: false,
      message: 'Failed as expected',
    });

    const result = await mote.runAgent(config);

    expect(handlers.handleCycleEnd).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed as expected');
  });

  it('should respect maxSteps limit', async () => {
     const originalEnv = process.env;
     process.env = { ...originalEnv, MAX_STEPS: '2' };

     const config: ConfigInput = {
      goal: { name: 'Test Max Steps', description: 'Loop forever' },
      startUrl: 'https://example.com',
      engagementMode: 'autonomous',
      stepPause: 0,
      verbose: false,
     };

     // Track step count - max steps is checked in OBSERVE handler
     let observeCount = 0;
     vi.spyOn(handlers, 'handleObserve').mockImplementation(async (state: AgentStateObserve) => {
        observeCount++;
        if (observeCount >= 2) {
          // Max steps reached - handleObserve returns TERMINATED
          return {
            phase: 'TERMINATED' as const,
            success: false,
            message: 'Reached maximum steps (2) without completing goal',
          };
        }
        // Return REASON to continue
        return {
          phase: 'REASON' as const,
          cycleIndex: state.cycleIndex,
          pageState: mockPageState,
        };
     });

     vi.spyOn(handlers, 'handleReason').mockImplementation(async (state: AgentStateReason) => ({
        phase: 'ACT' as const,
        cycleIndex: state.cycleIndex,
        action: { type: 'wait', reason: 'Waiting' },
        pageState: mockPageState,
     }));

     vi.spyOn(handlers, 'handleAct').mockImplementation(async (state: AgentStateAct) => ({
        phase: 'OBSERVE' as const,
        cycleIndex: state.cycleIndex,
     }));

     const result = await mote.runAgent(config);

     process.env = originalEnv; // Restore env

     // Should stop after 2 observe calls
     expect(result.success).toBe(false);
     expect(result.message).toContain('Reached maximum steps');
     expect(handlers.handleObserve).toHaveBeenCalledTimes(2);
  });
});
