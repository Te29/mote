import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  hasCheckpoint,
  getCheckpointPath,
} from '../../src/recorder/checkpoint.js';
import type { RecorderContext, RecorderCheckpoint } from '../../src/recorder/types.js';
import type { Preset, SessionPlan } from '../../src/types/index.js';

// Mock fs module
vi.mock('fs');

describe('Recorder Checkpoint Module', () => {
  const mockPreset: Preset = {
    name: 'test-preset',
    description: 'Test preset',
    goal: {
      name: 'Test Goal',
      description: 'Test description',
    },
    startUrl: 'https://example.com',
  };

  const mockSessionPlan: SessionPlan = {
    goalSummary: 'Test goal',
    cycleDescription: 'Test cycle',
    cyclePlan: { units: [] },
  };

  const mockContext: RecorderContext = {
    preset: mockPreset,
    sessionPlan: mockSessionPlan,
    presetDir: '/test/preset/dir',
    currentSection: 'setup',
    activeLoopId: null,
    stepCounter: 5,
    page: {} as any,
    llmClient: {} as any,
    checkpointPath: '/test/preset/dir/.recording-state.json',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveCheckpoint', () => {
    it('should save checkpoint to file', () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      saveCheckpoint(mockContext);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(
        mockContext.checkpointPath,
        expect.any(String),
      );

      // Verify the saved content
      const savedContent = JSON.parse(writeSpy.mock.calls[0][1] as string);
      expect(savedContent.currentSection).toBe('setup');
      expect(savedContent.stepCounter).toBe(5);
      expect(savedContent.preset.name).toBe('test-preset');
    });

    it('should handle write errors gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('Write error');
      });

      // Should not throw
      expect(() => saveCheckpoint(mockContext)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to save checkpoint'));
    });
  });

  describe('loadCheckpoint', () => {
    it('should return null if checkpoint file does not exist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = loadCheckpoint('/test/path/.recording-state.json');

      expect(result).toBeNull();
    });

    it('should load and parse checkpoint file', () => {
      const mockCheckpoint: RecorderCheckpoint = {
        currentSection: 'cycle',
        activeLoopId: 'loop-123',
        stepCounter: 10,
        sessionPlan: mockSessionPlan,
        preset: mockPreset,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockCheckpoint));

      const result = loadCheckpoint('/test/path/.recording-state.json');

      expect(result).toEqual(mockCheckpoint);
    });

    it('should return null on parse error', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('invalid json');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = loadCheckpoint('/test/path/.recording-state.json');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('clearCheckpoint', () => {
    it('should delete checkpoint file if it exists', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      clearCheckpoint('/test/path/.recording-state.json');

      expect(unlinkSpy).toHaveBeenCalledWith('/test/path/.recording-state.json');
    });

    it('should do nothing if checkpoint file does not exist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

      clearCheckpoint('/test/path/.recording-state.json');

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    it('should handle delete errors gracefully', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
        throw new Error('Delete error');
      });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => clearCheckpoint('/test/path/.recording-state.json')).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('hasCheckpoint', () => {
    it('should return true if checkpoint exists', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      expect(hasCheckpoint('/test/preset/dir')).toBe(true);
    });

    it('should return false if checkpoint does not exist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      expect(hasCheckpoint('/test/preset/dir')).toBe(false);
    });
  });

  describe('getCheckpointPath', () => {
    it('should return correct checkpoint path', () => {
      const result = getCheckpointPath('/test/preset/dir');

      expect(result).toBe(path.join('/test/preset/dir', '.recording-state.json'));
    });
  });
});
