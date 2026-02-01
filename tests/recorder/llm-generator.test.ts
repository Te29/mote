import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import {
  generateStepPrompt,
  generateVerificationScript,
  generateLoopCondition,
  polishPreset,
} from '../../src/recorder/llm-generator.js';
import type { RecordedAction } from '../../src/recorder/types.js';
import type { Preset, SessionPlan } from '../../src/types/index.js';

describe('LLM Generator Module', () => {
  let mockClient: OpenAI;

  beforeEach(() => {
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as unknown as OpenAI;
  });

  describe('generateStepPrompt', () => {
    const mockAction: RecordedAction = {
      type: 'click',
      selector: '#submit-btn',
      elementInfo: {
        tag: 'button',
        text: 'Submit',
        attributes: { id: 'submit-btn', type: 'submit' },
      },
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    it('should generate step prompt from LLM response', async () => {
      const mockResponse = `You are specialized for this step.

**Current Step Goal:** {{instruction}}

**Step-Specific Rules:**
- Click the submit button
- Wait for form submission

**Success:** Button is clicked successfully
**Failure:** Button not found`;

      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: mockResponse } }],
      });

      const result = await generateStepPrompt(mockClient, 'Click submit button', mockAction);

      expect(result).toContain('Current Step Goal');
      expect(result).toContain('Step-Specific Rules');
    });

    it('should return default prompt on LLM failure', async () => {
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API Error'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await generateStepPrompt(mockClient, 'Click submit button', mockAction);

      expect(result).toContain('Current Step Goal');
      expect(result).toContain('#submit-btn');
    });

    it('should include action value for type actions', async () => {
      const typeAction: RecordedAction = {
        type: 'type',
        selector: 'input[name="email"]',
        value: 'test@example.com',
        elementInfo: {
          tag: 'input',
          text: '',
          attributes: { name: 'email' },
        },
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: 'Generated prompt' } }],
      });

      await generateStepPrompt(mockClient, 'Enter email', typeAction);

      // Verify the prompt sent to LLM includes the value
      const callArgs = (mockClient.chat.completions.create as any).mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('test@example.com');
    });
  });

  describe('generateVerificationScript', () => {
    it('should generate verification script from LLM', async () => {
      const mockScript = "() => document.querySelector('.success') !== null";

      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: mockScript } }],
      });

      const result = await generateVerificationScript(mockClient, 'Success message is displayed');

      expect(result).toBe(mockScript);
    });

    it('should return default script on LLM failure', async () => {
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API Error'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await generateVerificationScript(mockClient, 'Check for success');

      expect(result).toContain('() =>');
    });

    it('should return default script for invalid LLM response', async () => {
      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: 'This is not a valid script' } }],
      });

      const result = await generateVerificationScript(mockClient, 'Check for success');

      // Should return a default script since response doesn't start with () or function
      expect(result).toContain('() =>');
    });

    it('should generate success-related script for success descriptions', async () => {
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API Error'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await generateVerificationScript(mockClient, 'Verify success message appears');

      expect(result.toLowerCase()).toContain('success');
    });
  });

  describe('generateLoopCondition', () => {
    it('should generate loop condition from LLM', async () => {
      const mockScript = "() => document.querySelectorAll('.item').length > 0";

      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: mockScript } }],
      });

      const result = await generateLoopCondition(mockClient, 'While items exist');

      expect(result).toBe(mockScript);
    });

    it('should return default condition on LLM failure', async () => {
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API Error'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await generateLoopCondition(mockClient, 'While items exist');

      expect(result).toBe('() => true');
    });
  });

  describe('polishPreset', () => {
    const mockPreset: Preset = {
      name: 'test-preset',
      description: 'Test preset',
      goal: {
        name: 'Test Goal',
        description: 'Test description',
      },
    };

    const mockSessionPlan: SessionPlan = {
      goalSummary: 'Test goal',
      cycleDescription: 'Test cycle',
      cyclePlan: { units: [] },
    };

    it('should return polished preset and plan from LLM', async () => {
      const polishedResponse = {
        preset: {
          description: 'Improved test preset description',
        },
        sessionPlan: {
          goalSummary: 'Improved goal summary',
        },
      };

      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(polishedResponse) } }],
      });

      const result = await polishPreset(mockClient, mockPreset, mockSessionPlan);

      expect(result.polishedPreset.description).toBe('Improved test preset description');
      expect(result.polishedPlan.goalSummary).toBe('Improved goal summary');
    });

    it('should return original preset on LLM failure', async () => {
      (mockClient.chat.completions.create as any).mockRejectedValue(new Error('API Error'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await polishPreset(mockClient, mockPreset, mockSessionPlan);

      expect(result.polishedPreset).toEqual(mockPreset);
      expect(result.polishedPlan).toEqual(mockSessionPlan);
    });

    it('should return original preset on invalid JSON response', async () => {
      (mockClient.chat.completions.create as any).mockResolvedValue({
        choices: [{ message: { content: 'Not valid JSON' } }],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await polishPreset(mockClient, mockPreset, mockSessionPlan);

      expect(result.polishedPreset).toEqual(mockPreset);
      expect(result.polishedPlan).toEqual(mockSessionPlan);
    });
  });
});
