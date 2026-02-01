import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecorderContext } from '../../src/recorder/types.js';
import type { Preset, SessionPlan } from '../../src/types/index.js';
import type { Browser, BrowserContext, Page } from 'playwright';

// Mock the handlers
vi.mock('../../src/recorder/handlers/index.js', () => ({
  handleInit: vi.fn(),
  handleRecording: vi.fn(),
  handleFinalize: vi.fn(),
}));

// Mock browser close
vi.mock('../../src/browser.js', () => ({
  closeBrowser: vi.fn().mockResolvedValue(undefined),
}));

// Mock prompts close
vi.mock('../../src/recorder/prompts.js', () => ({
  closeRecorderReadline: vi.fn(),
}));

import { executeRecorder } from '../../src/recorder/runtime.js';
import { handleInit, handleRecording, handleFinalize } from '../../src/recorder/handlers/index.js';

describe('Recorder Runtime', () => {
  let mockContext: RecorderContext;
  let mockBrowser: Browser;

  beforeEach(() => {
    vi.clearAllMocks();

    mockBrowser = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser;

    const mockBrowserContext = {
      browser: vi.fn().mockReturnValue(mockBrowser),
    } as unknown as BrowserContext;

    const mockPage = {
      context: vi.fn().mockReturnValue(mockBrowserContext),
    } as unknown as Page;

    mockContext = {
      preset: {
        name: 'test',
        description: 'Test',
        goal: { name: 'Test', description: 'Test' },
      } as Preset,
      sessionPlan: {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        cyclePlan: { units: [] },
      } as SessionPlan,
      presetDir: '/test/preset',
      currentSection: 'setup',
      activeLoopId: null,
      stepCounter: 0,
      page: mockPage,
      llmClient: {} as any,
      checkpointPath: '/test/preset/.recording-state.json',
    };
  });

  describe('executeRecorder', () => {
    it('should execute state machine and return success', async () => {
      // Setup handler mocks to transition through states
      (handleInit as any).mockResolvedValue({ phase: 'RECORDING', section: 'setup' });
      (handleRecording as any).mockResolvedValue({ phase: 'FINALIZE' });
      (handleFinalize as any).mockResolvedValue({ phase: 'DONE', presetDir: '/test/preset' });

      const result = await executeRecorder(mockContext);

      expect(result.success).toBe(true);
      expect(result.presetDir).toBe('/test/preset');
      expect(handleInit).toHaveBeenCalled();
      expect(handleRecording).toHaveBeenCalled();
      expect(handleFinalize).toHaveBeenCalled();
    });

    it('should handle errors and return failure', async () => {
      (handleInit as any).mockRejectedValue(new Error('Test error'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await executeRecorder(mockContext);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Test error');
    });

    it('should transition through multiple RECORDING sections', async () => {
      (handleInit as any).mockResolvedValue({ phase: 'RECORDING', section: 'setup' });
      (handleRecording as any)
        .mockResolvedValueOnce({ phase: 'RECORDING', section: 'cycle' })
        .mockResolvedValueOnce({ phase: 'RECORDING', section: 'wrapup' })
        .mockResolvedValueOnce({ phase: 'FINALIZE' });
      (handleFinalize as any).mockResolvedValue({ phase: 'DONE', presetDir: '/test/preset' });

      const result = await executeRecorder(mockContext);

      expect(result.success).toBe(true);
      expect(handleRecording).toHaveBeenCalledTimes(3);
    });
  });
});
