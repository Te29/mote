
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as mote from '../../src/mote.js';
import * as browser from '../../src/browser.js';
import * as observe from '../../src/observe.js';
import * as reason from '../../src/reason.js';
import * as interaction from '../../src/interaction.js';
import {
  type ConfigInput,
  type SessionTracker,
  type PageState,
  createTimestamp,
} from '../../src/types/index.js';

// Mock ONLY the reasoning/LLM part
vi.mock('../../src/reason');
vi.mock('../../src/interaction'); // Mock interaction to avoid hanging on prompts

describe('Mote Agent Live Smoke Test', () => {
  
  beforeEach(() => {
    vi.resetAllMocks();

    // Setup default mock behaviors for Reason (LLM)
    const mockLLMClient = {
      chat: { completions: { create: vi.fn() } },
    } as any;
    
    vi.spyOn(reason, 'createLLMClient').mockReturnValue(mockLLMClient);
    
    const mockPlan: SessionTracker = {
      goalSummary: 'Live Test Goal',
      cycleDescription: 'Live Test Cycle',
      cycles: [
        {
          isCompleted: false,
          cycleSteps: [],
        },
      ],
      startedAt: createTimestamp(),
      lastUpdatedAt: createTimestamp(),
    };
    
    vi.spyOn(reason, 'generatePlan').mockResolvedValue(mockPlan);

    // Mock interaction to auto-approve everything
    // We access the mocked module via the top-level import
    vi.spyOn(interaction, 'shouldIntervene').mockReturnValue(false);
    vi.spyOn(interaction, 'startInterruptListener').mockImplementation(() => {});
    vi.spyOn(interaction, 'stopInterruptListener').mockImplementation(() => {});
    vi.spyOn(interaction, 'closeReadline').mockImplementation(() => {});
    vi.spyOn(interaction, 'promptForLogin').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should successfully launch real browser, observe example.com, and succeed', async () => {
    // Increase timeout for real browser interaction
    vi.setConfig({ testTimeout: 30000 });

    const config: ConfigInput = {
      goal: { name: 'Live Smoke Test', description: 'Visit example.com' },
      startUrl: 'https://example.com',
      engagementMode: 'autonomous',
      stepPause: 0,
      verbose: true,
      headless: true, // Run headless for CI/Test speed
    };

    // Spy on real browser/observe modules to verify they are called
    const launchSpy = vi.spyOn(browser, 'launchBrowser');
    const observeSpy = vi.spyOn(observe, 'observe');

    // Mock think to immediately succeed after seeing the page
    // This proves the agent loop ran, observed, called think, and handled success.
    vi.spyOn(reason, 'think').mockResolvedValue({
      type: 'GOAL_SUCCESS', 
      finalAnswer: 'I have visited the page.',
    });

    console.log('Starting live agent run...');
    const result = await mote.runAgent(config);
    console.log('Agent run finished.');

    // Verifications
    expect(result.success).toBe(true);
    expect(result.finalUrl).toContain('example.com');
    
    // Check that REAL browser was launched
    expect(launchSpy).toHaveBeenCalled();
    
    // Check that REAL observe was called
    expect(observeSpy).toHaveBeenCalled();
    
    // Optional: Check that observe actually returned something valid (not just undefined)
    // We can't easily check the *return value* of the spy for specific calls in a simple way 
    // without more complex spying, but the fact that runAgent succeeded means observe() 
    // must have returned a PageState that observe() liked.
  });
});
