
import { describe, it, expect } from 'vitest';
import { processInterventionControl, InterventionControl } from '../src/interaction.js';
import { InterventionResponse } from '../src/types/index.js';

describe('Interaction Logic', () => {
  describe('processInterventionControl', () => {
    it('should map approve to continue', () => {
      const response: InterventionResponse = { type: 'approve' };
      const expected: InterventionControl = { action: 'continue' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map reject to continue (default)', () => {
      const response: InterventionResponse = { type: 'reject', reason: 'bad idea' };
      const expected: InterventionControl = { action: 'continue' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map modify to modify with instruction', () => {
      const response: InterventionResponse = { type: 'modify', instruction: 'do this instead' };
      const expected: InterventionControl = { action: 'modify', instruction: 'do this instead' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map skip to skip', () => {
      const response: InterventionResponse = { type: 'skip' };
      const expected: InterventionControl = { action: 'skip' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map force_success to succeed', () => {
      const response: InterventionResponse = { type: 'force_success', message: 'done' };
      const expected: InterventionControl = { action: 'succeed', message: 'done' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map force_fail to terminate', () => {
      const response: InterventionResponse = { type: 'force_fail', message: 'failed' };
      const expected: InterventionControl = { action: 'terminate', reason: 'failed' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map pause to terminate', () => {
      const response: InterventionResponse = { type: 'pause' };
      const expected: InterventionControl = { action: 'terminate', reason: 'User paused' };
      expect(processInterventionControl(response)).toEqual(expected);
    });

    it('should map quit to terminate', () => {
      const response: InterventionResponse = { type: 'quit' };
      const expected: InterventionControl = { action: 'terminate', reason: 'User quit' };
      expect(processInterventionControl(response)).toEqual(expected);
    });
  });
});
