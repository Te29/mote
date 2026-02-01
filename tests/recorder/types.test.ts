import { describe, it, expect } from 'vitest';
import type {
  RecordingPhase,
  RecordingSection,
  RecorderState,
  RecordedAction,
  RecorderContext,
  ActionDecision,
  PhaseControlAction,
  LoopConfig,
  RecorderResult,
  RecorderCheckpoint,
} from '../../src/recorder/types.js';

describe('Recorder Types', () => {
  describe('RecordingPhase', () => {
    it('should allow valid phases', () => {
      const phases: RecordingPhase[] = ['INIT', 'RECORDING', 'FINALIZE', 'DONE'];
      expect(phases).toHaveLength(4);
    });
  });

  describe('RecordingSection', () => {
    it('should allow valid sections', () => {
      const sections: RecordingSection[] = ['setup', 'cycle', 'wrapup'];
      expect(sections).toHaveLength(3);
    });
  });

  describe('RecorderState', () => {
    it('should create INIT state', () => {
      const state: RecorderState = { phase: 'INIT' };
      expect(state.phase).toBe('INIT');
    });

    it('should create RECORDING state with section', () => {
      const state: RecorderState = { phase: 'RECORDING', section: 'setup' };
      expect(state.phase).toBe('RECORDING');
      expect(state.section).toBe('setup');
    });

    it('should create RECORDING state with loop', () => {
      const state: RecorderState = {
        phase: 'RECORDING',
        section: 'cycle',
        loopId: 'loop-123',
      };
      expect(state.phase).toBe('RECORDING');
      expect(state.loopId).toBe('loop-123');
    });

    it('should create FINALIZE state', () => {
      const state: RecorderState = { phase: 'FINALIZE' };
      expect(state.phase).toBe('FINALIZE');
    });

    it('should create DONE state with presetDir', () => {
      const state: RecorderState = { phase: 'DONE', presetDir: '/path/to/preset' };
      expect(state.phase).toBe('DONE');
      expect(state.presetDir).toBe('/path/to/preset');
    });
  });

  describe('RecordedAction', () => {
    it('should create a click action', () => {
      const action: RecordedAction = {
        type: 'click',
        selector: '#submit-btn',
        elementInfo: {
          tag: 'button',
          text: 'Submit',
          attributes: { id: 'submit-btn', type: 'submit' },
        },
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      expect(action.type).toBe('click');
      expect(action.selector).toBe('#submit-btn');
    });

    it('should create a type action with value', () => {
      const action: RecordedAction = {
        type: 'type',
        selector: 'input[name="email"]',
        value: 'test@example.com',
        elementInfo: {
          tag: 'input',
          text: '',
          attributes: { name: 'email', type: 'text' },
        },
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      expect(action.type).toBe('type');
      expect(action.value).toBe('test@example.com');
    });

    it('should create action with alternative selectors', () => {
      const action: RecordedAction = {
        type: 'click',
        selector: '[data-testid="login"]',
        alternativeSelectors: ['#login-btn', 'button:has-text("Login")'],
        elementInfo: {
          tag: 'button',
          text: 'Login',
          attributes: { 'data-testid': 'login' },
        },
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      expect(action.alternativeSelectors).toHaveLength(2);
    });
  });

  describe('ActionDecision', () => {
    it('should create keep decision', () => {
      const decision: ActionDecision = {
        action: 'keep',
        description: 'Click submit button',
        generatePrompt: true,
        generateVerification: false,
      };

      expect(decision.action).toBe('keep');
      expect(decision.generatePrompt).toBe(true);
    });

    it('should create discard decision', () => {
      const decision: ActionDecision = { action: 'discard' };
      expect(decision.action).toBe('discard');
    });

    it('should create edit decision', () => {
      const decision: ActionDecision = {
        action: 'edit',
        newSelector: '#new-selector',
      };

      expect(decision.action).toBe('edit');
      expect(decision.newSelector).toBe('#new-selector');
    });
  });

  describe('PhaseControlAction', () => {
    it('should allow all valid actions', () => {
      const actions: PhaseControlAction[] = [
        'continue',
        'start-loop',
        'end-loop',
        'verification',
        'next-section',
        'done',
      ];

      expect(actions).toHaveLength(6);
    });
  });

  describe('LoopConfig', () => {
    it('should create config with iterations', () => {
      const config: LoopConfig = { iterations: 5 };
      expect(config.iterations).toBe(5);
    });

    it('should create config with condition description', () => {
      const config: LoopConfig = {
        conditionDescription: 'While items exist on page',
      };
      expect(config.conditionDescription).toBe('While items exist on page');
    });
  });

  describe('RecorderResult', () => {
    it('should create success result', () => {
      const result: RecorderResult = {
        success: true,
        presetDir: '/path/to/preset',
        message: 'Preset created successfully',
      };

      expect(result.success).toBe(true);
      expect(result.presetDir).toBe('/path/to/preset');
    });

    it('should create failure result', () => {
      const result: RecorderResult = {
        success: false,
        presetDir: '/path/to/preset',
        message: 'Recording failed: Browser crashed',
      };

      expect(result.success).toBe(false);
    });
  });

  describe('RecorderCheckpoint', () => {
    it('should create valid checkpoint', () => {
      const checkpoint: RecorderCheckpoint = {
        currentSection: 'cycle',
        activeLoopId: 'loop-123',
        stepCounter: 10,
        sessionPlan: {
          goalSummary: 'Test',
          cycleDescription: 'Test cycle',
          cyclePlan: { units: [] },
        },
        preset: {
          name: 'test',
          description: 'Test preset',
          goal: { name: 'Test', description: 'Test' },
        },
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      expect(checkpoint.currentSection).toBe('cycle');
      expect(checkpoint.activeLoopId).toBe('loop-123');
      expect(checkpoint.stepCounter).toBe(10);
    });
  });
});
