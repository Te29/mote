import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Goal, PageState, SessionTracker, Action } from '../../src/types/index.js';
import type { InterventionMetrics } from '../../src/prompt.js';
import OpenAI from 'openai';
import {
    createLLMClient,
    think,
    generatePlan,
    validateSessionPlan,
    evaluateDrift
} from '../../src/reason.js';


describe('Reason Module', () => {
    let client: OpenAI;
    let mockCreate: ReturnType<typeof vi.fn>;

    const mockGoal: Goal = {
        name: 'Test Goal',
        description: 'A test goal for unit testing',
        successCriteria: 'Tests pass',
    };

    const mockPageState: PageState = {
        url: 'https://example.com',
        title: 'Example',
        markdown: 'Example page content.',
        elements: [
            { index: 1, tag: 'button', text: 'Click Me', selector: '#btn1', attributes: {} },
            { index: 2, tag: 'input', text: '', selector: '#input1', inputType: 'text', attributes: { placeholder: 'Type here' } }
        ]
    };

    const mockPlan: SessionTracker = {
        goalSummary: 'Test goal summary',
        cycleDescription: 'Test cycle',
        cycles: [{ isCompleted: false, cycleSteps: [] }],
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
    };

    const mockMetrics: InterventionMetrics = {
        consecutiveFailures: 0,
        replanCount: 0,
        reobserveCount: 0,
        llmParseFailures: 0,
    };

    beforeEach(() => {
        client = createLLMClient();
        // Spy on the client's method
        mockCreate = vi.fn();
        client.chat = { completions: { create: mockCreate } } as any;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('think()', () => {
        it('should parse ACTION result correctly', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            thinking: 'I should click the button',
                            resultType: 'ACTION',
                            action: {
                                type: 'click',
                                elementId: '1',
                                reason: 'To proceed'
                            }
                        })
                    }
                }]
            });

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics, { tokenMarkdown: 1000, tokenElements: 1000, tokenMaxElements: 50, tokenHistory: 500 });
            
            expect(result.type).toBe('ACTION');
            if (result.type === 'ACTION') {
                expect(result.action.type).toBe('click');
                expect(result.action.elementId).toBe('1');
            }
        });

        it('should parse GOAL_SUCCESS result correctly', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            thinking: 'Goal achieved',
                            resultType: 'GOAL_SUCCESS',
                            finalAnswer: 'Task completed successfully'
                        })
                    }
                }]
            });

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics, { tokenMarkdown: 1000, tokenElements: 1000, tokenMaxElements: 50, tokenHistory: 500 });

            expect(result.type).toBe('GOAL_SUCCESS');
            if (result.type === 'GOAL_SUCCESS') {
                expect(result.finalAnswer).toBe('Task completed successfully');
            }
        });

        it('should return FAIL on invalid JSON', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: 'This is not JSON at all'
                    }
                }]
            });

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics, { tokenMarkdown: 1000, tokenElements: 1000, tokenMaxElements: 50, tokenHistory: 500 });

            expect(result.type).toBe('FAIL');
        });

        it('should return FAIL on Zod validation error after retries', async () => {
            // Provide invalid responses for all retries
            const invalidResponse = {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            thinking: 'Bad action',
                            resultType: 'ACTION',
                            action: 'click' // Should be object, not string
                        })
                    }
                }]
            };
            
            mockCreate.mockResolvedValue(invalidResponse);

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics, { tokenMarkdown: 1000, tokenElements: 1000, tokenMaxElements: 50, tokenHistory: 500 });

            expect(result.type).toBe('FAIL');
            expect(mockCreate).toHaveBeenCalledTimes(3); // Should have retried
            if (result.type === 'FAIL') {
                expect(result.error).toContain('Invalid JSON format');
            }
        });

        it('should succeed on retry if LLM self-corrects', async () => {
            // 1. First attempt fails validation (wrong action type)
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            resultType: 'ACTION',
                            action: 'click' // invalid
                        })
                    }
                }]
            });
            // 2. Second attempt succeeds
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            resultType: 'ACTION',
                            action: {
                                type: 'click',
                                elementId: '1',
                                reason: 'Fixed it'
                            }
                        })
                    }
                }]
            });

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics, { tokenMarkdown: 1000, tokenElements: 1000, tokenMaxElements: 50, tokenHistory: 500 });

            expect(result.type).toBe('ACTION');
            expect(mockCreate).toHaveBeenCalledTimes(2);
            expect(mockMetrics.llmParseFailures).toBeGreaterThan(0);
        });
    });

    describe('evaluateDrift()', () => {
        it('should return can_proceed for identical states', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            decision: 'can_proceed',
                            reason: 'States are identical'
                        })
                    }
                }]
            });

            const action: Action = { type: 'click', elementId: '#btn1', reason: 'Test' };
            const result = await evaluateDrift(mockPageState, mockPageState, action, client);

            expect(result.decision).toBe('can_proceed');
            expect(result.reason).toBe('States are identical');
        });

        it('should return can_proceed with adapted action', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            decision: 'can_proceed',
                            reason: 'Button moved',
                            adaptedAction: {
                                type: 'click',
                                elementId: '#btn2',
                                reason: 'Adapted to new button location'
                            }
                        })
                    }
                }]
            });

            const action: Action = { type: 'click', elementId: '#btn1', reason: 'Test' };
            const result = await evaluateDrift(mockPageState, mockPageState, action, client);

            expect(result.decision).toBe('can_proceed');
            expect(result.reason).toBe('Button moved');
            if (result.decision === 'can_proceed') {
                expect(result.adaptedAction?.elementId).toBe('#btn2');
            }
        });

        it('should return technical_error on parse error after retries', async () => {
            mockCreate.mockResolvedValue({
                choices: [{
                    message: {
                        content: 'Invalid response'
                    }
                }]
            });

            const action: Action = { type: 'click', elementId: '#btn1', reason: 'Test' };
            const result = await evaluateDrift(mockPageState, mockPageState, action, client);

            expect(result.decision).toBe('technical_error');
            expect(mockCreate).toHaveBeenCalledTimes(3); // Verification of retries
        });
    });

    describe('validateSessionPlan()', () => {
        it('should validate a correct plan', () => {
            const result = validateSessionPlan(mockPlan);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should reject plan with empty goalSummary', () => {
            const badPlan = { ...mockPlan, goalSummary: '' };
            const result = validateSessionPlan(badPlan);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should reject plan with no cycles', () => {
            const badPlan = { ...mockPlan, cycles: [] };
            const result = validateSessionPlan(badPlan);
            expect(result.valid).toBe(false);
        });
    });

    describe('generatePlan()', () => {
        it('should generate a valid plan from LLM response', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            goalSummary: 'Generated summary',
                            cycleDescription: 'Generated cycle',
                            cycleCount: 2
                        })
                    }
                }]
            });

            const plan = await generatePlan(mockGoal, client);

            expect(plan.goalSummary).toBe('Generated summary');
            expect(plan.cycles.length).toBe(2);
        });

        it('should fall back to single cycle on error', async () => {
            mockCreate.mockRejectedValueOnce(new Error('API Error'));

            const plan = await generatePlan(mockGoal, client);

            expect(plan.cycles.length).toBe(1);
            expect(plan.goalSummary).toBe(mockGoal.description);
        });
    });
});
