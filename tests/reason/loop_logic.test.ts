
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReason } from '../../src/handlers/reason.js';
import type { AgentContext } from '../../src/types/context.js';
import type { AgentStateReason } from '../../src/types/state-machine.js';
import type { PageState } from '../../src/types/page.js';
import type { CyclePlan, PlanUnit } from '../../src/types/actions.js';

// Mock Dependencies
const mockThink = vi.fn();
const mockServices: any = {
  reason: {
    think: mockThink,
    evaluateDrift: vi.fn(), 
  },
  llmClient: {},
};

const defaultPageState: PageState = {
  elements: [],
  url: 'http://test.com',
  title: 'Test',
  markdown: '',

};

function createMockContext(cyclePlan: CyclePlan, mockEvaluate?: any): AgentContext {
  return {
    runtime: {
      executionPointer: [0],
      loopStates: {},
      hadAdaptations: false,
      activePage: {
        evaluate: mockEvaluate || vi.fn().mockResolvedValue(true),
      } as any,
      lastObservedUrl: null,
      lastPageState: null,
      currentCycleDrifts: [],
    },
    cyclePlan: cyclePlan,
    services: mockServices,
    interventionMetrics: {},
    tracker: {
      goalSummary: 'Test',
      cycleDescription: 'Test',
      cycles: [{ isCompleted: false, cycleSteps: [] }],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    } as any,
    history: [],
    verbose: false,
    tokenMarkdown: 1000,
    tokenElements: 1000,
    tokenMaxElements: 100,
    tokenHistory: 1000,
    //... other required fields mocked minimally
  } as any;
}

describe('Loop Logic in handleReason', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should enter a loop and initialize pointer', async () => {
    const loopUnit: PlanUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-1',
        iterations: 2,
        steps: [
          { stepId: 's1', description: 'Step 1', action: { type: 'wait', reason: 'wait' } }
        ]
      }
    };
    
    const ctx = createMockContext({ units: [loopUnit] });
    const state: AgentStateReason = { phase: 'REASON', cycleIndex: 0, pageState: defaultPageState };

    // 1. First call: Should detect loop and PUSH 0 to pointer, then execute step 0
    const result = await handleReason(state, ctx);

    // Should have updated pointer to [0, 0] (Unit 0, Step 0)
    expect(ctx.runtime.executionPointer).toEqual([0, 0]);
    
    // Should return result for Step 0
    expect(result.phase).toBe('ACT');
    expect((result as any).stepId).toBe('s1');
  });

  it('should repeat a loop with fixed iterations', async () => {
    const loopUnit: PlanUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-itr',
        iterations: 2,
        steps: [
          { stepId: 's1', description: 'Step 1', action: { type: 'wait', reason: 'w' } }
        ]
      }
    };
    
    const ctx = createMockContext({ units: [loopUnit] });
    const state: AgentStateReason = { phase: 'REASON', cycleIndex: 0, pageState: defaultPageState };

    // --- Iteration 1 ---
    
    // Call 1: Enter Loop -> Step 0
    await handleReason(state, ctx); 
    expect(ctx.runtime.executionPointer).toEqual([0, 0]);
    
    // Call 2: Step 0 done -> Loop End -> Check Iterations -> Loop Back (Iter 2)
    // Manually advance pointer to simulate ACT phase completion logic (usually handled by ACT/OBSERVE cycle)
    // Here we just increment step index to simulate "ready for next step" or "end of loop"
    
    // Simulate end of loop steps: Pointer [0, 1] (out of bounds for 1-step loop)
    ctx.runtime.executionPointer = [0, 1];
    
    // Recursion happens inside handleReason, so one call should handle the transition
    const result2 = await handleReason(state, ctx);
    
    // Should be back at start of loop: [0, 0]
    expect(ctx.runtime.executionPointer).toEqual([0, 0]);
    // State updated to Iteration 2
    expect(ctx.runtime.loopStates['loop-itr'].iteration).toBe(2);
    // Should have conditionsMet array
    expect(ctx.runtime.loopStates['loop-itr'].conditionsMet).toBeDefined();
    // Should execute step s1 again
    expect((result2 as any).stepId).toBe('s1');
  });

  it('should exit loop after max fixed iterations', async () => {
    const loopUnit: PlanUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-itr-exit',
        iterations: 1, // Only 1 iteration
        steps: [
          { stepId: 's1', description: 'Step 1', action: { type: 'wait', reason: 'w' } }
        ]
      }
    };
    
    // Next unit after loop
    const nextUnit: PlanUnit = {
      type: 'step',
      step: { stepId: 's2', description: 'After Loop', action: { type: 'wait', reason: 'done' } }
    };
    
    const ctx = createMockContext({ units: [loopUnit, nextUnit] });
    const state: AgentStateReason = { phase: 'REASON', cycleIndex: 0, pageState: defaultPageState };

    // --- Iteration 1 ---
    await handleReason(state, ctx); // Enter loop
    // Loop state is now initialized when entering the loop
    expect(ctx.runtime.loopStates['loop-itr-exit']).toBeDefined();
    expect(ctx.runtime.loopStates['loop-itr-exit'].iteration).toBe(1);

    // Simulate End of Iteration 1
    ctx.runtime.executionPointer = [0, 1];
    
    // handleReason: Check max (1). current (1) >= max (1)? No... wait. 
    // Logic: if current (1) < max (1) -> continue. 1 < 1 is false.
    // So it should Exit.
    
    const result = await handleReason(state, ctx);
    
    // Should have popped loop: [0] -> increment -> [1]
    // And executed next unit (s2)
    expect(ctx.runtime.executionPointer).toEqual([1]);
    expect((result as any).stepId).toBe('s2');
  });

  it('should continue loop based on dynamic verification script', async () => {
    const loopUnit: PlanUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-dyn',
        // No fixed iterations
        loopCondition: {
          verification: {
            script: '() => document.querySelector("#marker") !== null',
            description: 'Check for marker element',
          },
          maxIterations: 10,
        },
        steps: [{ stepId: 's1', description: 'S1', action: { type: 'wait', reason: 'w' } }]
      }
    };
    
    // Mock evaluate to return true (marker exists)
    const mockEvaluate = vi.fn().mockResolvedValue(true);
    const ctx = createMockContext({ units: [loopUnit] }, mockEvaluate);

    const stateWithMarker: AgentStateReason = {
        phase: 'REASON',
        cycleIndex: 0,
        pageState: { ...defaultPageState, elements: [{ selector: '#marker', index: 1, tag: 'div', text: 'marker', attributes: {} }] }
    };

    // Simulate End of Iteration 1
    ctx.runtime.executionPointer = [0, 1];

    await handleReason(stateWithMarker, ctx);

    // Should loop back
    expect(ctx.runtime.executionPointer).toEqual([0, 0]);
    expect(ctx.runtime.loopStates['loop-dyn'].iteration).toBe(2);
    expect(ctx.runtime.loopStates['loop-dyn'].conditionsMet).toBeDefined();
    expect(mockEvaluate).toHaveBeenCalled();
  });

  it('should exit loop based on dynamic verification script (returns false)', async () => {
    const loopUnit: PlanUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-dyn-exit',
        loopCondition: {
          verification: {
            script: '() => document.querySelector("#marker") !== null',
            description: 'Check for marker element',
            onFailure: 'fail',
          },
          maxIterations: 10,
        },
        steps: [{ stepId: 's1', description: 'S1', action: { type: 'wait', reason: 'w' } }]
      }
    };
    
    const nextUnit: PlanUnit = { type: 'step', step: { stepId: 's2', description: 'S2' } };

    // Mock evaluate to return false (marker doesn't exist)
    const mockEvaluate = vi.fn().mockResolvedValue(false);
    const ctx = createMockContext({ units: [loopUnit, nextUnit] }, mockEvaluate);

    // Page state WITHOUT the marker
    const stateWithoutMarker: AgentStateReason = {
        phase: 'REASON',
        cycleIndex: 0,
        pageState: defaultPageState
    };

    // Simulate End of Iteration 1
    ctx.runtime.executionPointer = [0, 1];

    await handleReason(stateWithoutMarker, ctx);

    // Should exit loop and move to next unit
    expect(ctx.runtime.executionPointer).toEqual([1]);
    expect(mockEvaluate).toHaveBeenCalled();
  });

});
