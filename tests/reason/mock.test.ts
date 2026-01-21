import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Goal, PageState, SessionPlan, Action } from '../../src/types.js';
import type { ExecutionMetrics } from '../../src/prompt.js';
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

    const mockPlan: SessionPlan = {
        goalSummary: 'Test goal summary',
        cycleDescription: 'Test cycle',
        cycles: [{ isCompleted: false, cycleSteps: [] }],
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
    };

    const mockMetrics: ExecutionMetrics = {
        consecutiveFailures: 0,
        replanCount: 0,
        reobserveCount: 0
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
                                selector: '1',
                                reason: 'To proceed'
                            }
                        })
                    }
                }]
            });

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics);

            expect(result.type).toBe('ACTION');
            if (result.type === 'ACTION') {
                expect(result.action.type).toBe('click');
                expect(result.action.selector).toBe('1');
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

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics);

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

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics);

            expect(result.type).toBe('FAIL');
        });

        it('should return FAIL on Zod validation error (wrong action type)', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            thinking: 'Bad action',
                            resultType: 'ACTION',
                            action: 'click' // Should be object, not string
                        })
                    }
                }]
            });

            const result = await think(mockPageState, mockGoal, undefined, mockPlan, [], client, mockMetrics);

            expect(result.type).toBe('FAIL');
            if (result.type === 'FAIL') {
                expect(result.error).toContain('Invalid JSON format');
            }
        });
    });

    describe('evaluateDrift()', () => {
        it('should return approved for identical states', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            status: 'approved',
                            reason: 'States are identical'
                        })
                    }
                }]
            });

            const action: Action = { type: 'click', selector: '#btn1', reason: 'Test' };
            const result = await evaluateDrift(mockPageState, mockPageState, action, client);

            expect(result.status).toBe('approved');
        });

        it('should return update_required with correction', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            status: 'update_required',
                            reason: 'Button moved',
                            correction: { selector: '#btn2' }
                        })
                    }
                }]
            });

            const action: Action = { type: 'click', selector: '#btn1', reason: 'Test' };
            const result = await evaluateDrift(mockPageState, mockPageState, action, client);

            expect(result.status).toBe('update_required');
            expect(result.correction?.selector).toBe('#btn2');
        });

        it('should return fallback on parse error', async () => {
            mockCreate.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: 'Invalid response'
                    }
                }]
            });

            const action: Action = { type: 'click', selector: '#btn1', reason: 'Test' };
            const result = await evaluateDrift(mockPageState, mockPageState, action, client);

            expect(result.status).toBe('fallback');
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
