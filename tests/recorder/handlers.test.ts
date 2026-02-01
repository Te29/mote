import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleInit } from '../../src/recorder/handlers/init.js';
import type { RecorderState, RecorderContext } from '../../src/recorder/types.js';
import type { Preset, SessionPlan } from '../../src/types/index.js';

describe('Recorder Handlers', () => {
  describe('handleInit', () => {
    let mockContext: RecorderContext;

    beforeEach(() => {
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
        page: {} as any,
        llmClient: {} as any,
        checkpointPath: '/test/preset/.recording-state.json',
      };

      // Mock console.log
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('should transition from INIT to RECORDING with setup section', async () => {
      const initState: RecorderState & { phase: 'INIT' } = { phase: 'INIT' };

      const result = await handleInit(initState, mockContext);

      expect(result.phase).toBe('RECORDING');
      if (result.phase === 'RECORDING') {
        expect(result.section).toBe('setup');
      }
    });

    it('should print instructions on init', async () => {
      const initState: RecorderState & { phase: 'INIT' } = { phase: 'INIT' };

      await handleInit(initState, mockContext);

      expect(console.log).toHaveBeenCalled();
    });
  });
});
