import { describe, it, expect, vi } from 'vitest';
import { handleReason } from '../../src/handlers/reason.js';
import type { AgentStateReason } from '../../src/types/state-machine.js';
import type { AgentContext } from '../../src/types/context.js';
import type { StepPlan, Action, PageState } from '../../src/types/index.js';

describe('handleReason State Handler', () => {
    const mockPageState: PageState = {
        url: 'https://current-url.com',
        title: 'Current Page',
        markdown: 'Content',
        elements: [
            { index: 1, tag: 'button', text: 'Target', selector: '#target-btn', attributes: {} }
        ]
    };

    const mockState: AgentStateReason = {
        phase: 'REASON',
        cycleIndex: 0,
        pageState: mockPageState
    };

    const cachedAction: Action = { type: 'click', elementId: '#target-btn', reason: 'Cached act' };

    const mockStepPlan: StepPlan = {
        stepId: 'step-1',
        description: 'Click button',
        url: 'https://original-url.com', // Different from current URL
        targetElementSelector: '#target-btn',
        expectedPageState: mockPageState,
        action: cachedAction,
        llmRequired: false
    };

    it('should proceed with cached action even if URL is different but element matches', async () => {
        const ctx = {
            cyclePlan: {
                units: [{ type: 'step', step: mockStepPlan }]
            },
            runtime: {
                executionPointer: [0],
                hadAdaptations: false,
                pendingUserInstruction: undefined
            },
            services: {
                reason: {
                    think: vi.fn(),
                    evaluateDrift: vi.fn()
                }
            }
        } as unknown as AgentContext;

        const result = await handleReason(mockState, ctx);

        expect(result.phase).toBe('ACT');
        if (result.phase === 'ACT') {
            expect(result.action).toEqual(cachedAction);
        }
        // Should NOT call any services if exact match is found
        expect(ctx.services.reason.think).not.toHaveBeenCalled();
        expect(ctx.services.reason.evaluateDrift).not.toHaveBeenCalled();
    });

    it('should proceed with cached action even if URL is missing in the step', async () => {
        // Step with NO URL
        const stepNoUrl: StepPlan = {
            ...mockStepPlan,
            url: undefined
        };

        const ctx = {
            cyclePlan: {
                units: [{ type: 'step', step: stepNoUrl }]
            },
            runtime: {
                executionPointer: [0],
                hadAdaptations: false,
                pendingUserInstruction: undefined
            },
            services: {
                reason: {
                    think: vi.fn(),
                    evaluateDrift: vi.fn()
                }
            }
        } as unknown as AgentContext;

        const result = await handleReason(mockState, ctx);

        expect(result.phase).toBe('ACT');
        if (result.phase === 'ACT') {
            expect(result.action).toEqual(cachedAction);
        }
    });

    it('should proceed with cached action if URL exists in pageState but not used for matching', async () => {
        // This is essentially same as first test but confirms the semantic intent
        const result = await handleReason(mockState, {
            cyclePlan: {
                units: [{ type: 'step', step: mockStepPlan }]
            },
            runtime: { 
                executionPointer: [0],
                hadAdaptations: false,
                pendingUserInstruction: undefined
            },
            services: { reason: {} }
        } as any);

        expect(result.phase).toBe('ACT');
    });
});
