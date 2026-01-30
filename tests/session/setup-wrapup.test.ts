// =============================================================================
// SETUP/WRAPUP INTEGRATION TESTS
// =============================================================================
// Tests for SessionPlan execution with setup/cycles/wrapup phases

import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionPlan, CyclePlan, StepPlan, SessionTracker } from '../../src/types/index.js';
import {
  getCurrentSection,
  getProgress,
  createTimestamp,
} from '../../src/types/session.js';
import { initializeTrackerFromPlan } from '../../src/reason.js';

describe('Setup/Wrapup Session Execution', () => {
  describe('SessionTracker Initialization', () => {
    it('should initialize empty setupSteps array when SessionPlan has setup', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test goal',
        cycleDescription: 'Test cycle',
        setupSteps: [
          {
            stepId: 'setup-1',
            description: 'Setup step 1',
            action: {
              type: 'navigate',
              text: 'https://example.com',
              reason: 'Navigate to site',
            },
          },
        ],
        cyclePlan: {
          units: [
            {
              type: 'step',
              step: {
                stepId: 'cycle-1',
                description: 'Cycle step 1',
              },
            },
          ],
        },
        numberOfCycles: 1,
      };

      const tracker = initializeTrackerFromPlan(sessionPlan);

      expect(tracker.setupSteps).toBeDefined();
      expect(tracker.setupSteps).toEqual([]);
      expect(tracker.sessionPlan).toBe(sessionPlan);
    });

    it('should initialize empty wrapupSteps array when SessionPlan has wrapup', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test goal',
        cycleDescription: 'Test cycle',
        cyclePlan: {
          units: [
            {
              type: 'step',
              step: {
                stepId: 'cycle-1',
                description: 'Cycle step 1',
              },
            },
          ],
        },
        wrapupSteps: [
          {
            stepId: 'wrapup-1',
            description: 'Wrapup step 1',
            action: {
              type: 'wait',
              text: '1000',
              reason: 'Wait before completing',
            },
          },
        ],
        numberOfCycles: 1,
      };

      const tracker = initializeTrackerFromPlan(sessionPlan);

      expect(tracker.wrapupSteps).toBeDefined();
      expect(tracker.wrapupSteps).toEqual([]);
      expect(tracker.sessionPlan).toBe(sessionPlan);
    });

    it('should leave setupSteps undefined when SessionPlan has no setup', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test goal',
        cycleDescription: 'Test cycle',
        cyclePlan: {
          units: [
            {
              type: 'step',
              step: {
                stepId: 'cycle-1',
                description: 'Cycle step 1',
              },
            },
          ],
        },
        numberOfCycles: 1,
      };

      const tracker = initializeTrackerFromPlan(sessionPlan);

      expect(tracker.setupSteps).toBeUndefined();
      expect(tracker.wrapupSteps).toBeUndefined();
    });
  });

  describe('getCurrentSection Logic', () => {
    it('should return "setup" when setup steps are not all executed', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [
          { stepId: 's1', description: 'Step 1' },
          { stepId: 's2', description: 'Step 2' },
        ],
        cyclePlan: {
          units: [{ type: 'step', step: { stepId: 'c1', description: 'Cycle 1' } }],
        },
      };

      const tracker: SessionTracker = {
        sessionPlan,
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [], // 0 executed, 2 total
        cycles: [{ isCompleted: false, cycleSteps: [] }],
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      expect(getCurrentSection(tracker)).toBe('setup');
    });

    it('should return "cycles" when setup complete but cycles incomplete', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [{ stepId: 's1', description: 'Step 1' }],
        cyclePlan: {
          units: [{ type: 'step', step: { stepId: 'c1', description: 'Cycle 1' } }],
        },
      };

      const tracker: SessionTracker = {
        sessionPlan,
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [
          {
            globalIndex: 0,
            stepId: 's1',
            isCompleted: true,
            stepDescription: 'Step 1',
          },
        ],
        cycles: [{ isCompleted: false, cycleSteps: [] }],
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      expect(getCurrentSection(tracker)).toBe('cycles');
    });

    it('should return "wrapup" when cycles complete but wrapup not executed', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        cyclePlan: {
          units: [{ type: 'step', step: { stepId: 'c1', description: 'Cycle 1' } }],
        },
        wrapupSteps: [
          { stepId: 'w1', description: 'Wrapup 1' },
          { stepId: 'w2', description: 'Wrapup 2' },
        ],
      };

      const tracker: SessionTracker = {
        sessionPlan,
        goalSummary: 'Test',
        cycleDescription: 'Test',
        cycles: [{ isCompleted: true, cycleSteps: [] }],
        wrapupSteps: [], // 0 executed, 2 total
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      expect(getCurrentSection(tracker)).toBe('wrapup');
    });

    it('should return "complete" when all phases done', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [{ stepId: 's1', description: 'Setup 1' }],
        cyclePlan: {
          units: [{ type: 'step', step: { stepId: 'c1', description: 'Cycle 1' } }],
        },
        wrapupSteps: [{ stepId: 'w1', description: 'Wrapup 1' }],
      };

      const tracker: SessionTracker = {
        sessionPlan,
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [
          {
            globalIndex: 0,
            stepId: 's1',
            isCompleted: true,
            stepDescription: 'Setup 1',
          },
        ],
        cycles: [{ isCompleted: true, cycleSteps: [] }],
        wrapupSteps: [
          {
            globalIndex: 1,
            stepId: 'w1',
            isCompleted: true,
            stepDescription: 'Wrapup 1',
          },
        ],
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      expect(getCurrentSection(tracker)).toBe('complete');
    });
  });

  describe('getProgress with Setup/Wrapup', () => {
    it('should show setup progress', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [
          { stepId: 's1', description: 'Step 1' },
          { stepId: 's2', description: 'Step 2' },
          { stepId: 's3', description: 'Step 3' },
        ],
        cyclePlan: {
          units: [{ type: 'step', step: { stepId: 'c1', description: 'Cycle' } }],
        },
      };

      const tracker: SessionTracker = {
        sessionPlan,
        goalSummary: 'Test',
        cycleDescription: 'Test',
        setupSteps: [
          {
            globalIndex: 0,
            stepId: 's1',
            isCompleted: true,
            stepDescription: 'Step 1',
          },
          {
            globalIndex: 1,
            stepId: 's2',
            isCompleted: false,
            stepDescription: 'Step 2',
          },
        ],
        cycles: [{ isCompleted: false, cycleSteps: [] }],
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      expect(getProgress(tracker)).toBe('Setup: Step 2/3');
    });

    it('should show wrapup progress', () => {
      const sessionPlan: SessionPlan = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        cyclePlan: {
          units: [{ type: 'step', step: { stepId: 'c1', description: 'Cycle' } }],
        },
        wrapupSteps: [
          { stepId: 'w1', description: 'Wrapup 1' },
          { stepId: 'w2', description: 'Wrapup 2' },
        ],
      };

      const tracker: SessionTracker = {
        sessionPlan,
        goalSummary: 'Test',
        cycleDescription: 'Test',
        cycles: [{ isCompleted: true, cycleSteps: [] }],
        wrapupSteps: [
          {
            globalIndex: 0,
            stepId: 'w1',
            isCompleted: true,
            stepDescription: 'Wrapup 1',
          },
        ],
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      expect(getProgress(tracker)).toBe('Wrapup: Step 2/2');
    });

    it('should handle edge case when currentCycleIdx is -1', () => {
      const tracker: SessionTracker = {
        goalSummary: 'Test',
        cycleDescription: 'Test',
        cycles: [{ isCompleted: true, cycleSteps: [] }],
        startedAt: createTimestamp(),
        lastUpdatedAt: createTimestamp(),
      };

      // All cycles complete, no wrapup
      expect(getProgress(tracker)).toBe('Session complete');
    });
  });
});
