
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReason } from '../../src/handlers/reason.js';
import type { AgentContext } from '../../src/types/context.js';
import type { AgentStateReason } from '../../src/types/state-machine.js';
import type { PageState } from '../../src/types/page.js';
import type { ExecutionPath, ExecutionUnit } from '../../src/types/actions.js';

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

function createMockContext(executionPath: ExecutionPath): AgentContext {
  return {
    runtime: {
      executionPointer: [0],
      loopStates: {},
      hadAdaptations: false,
      activePage: {} as any, 
      lastObservedUrl: null,
      lastPageState: null,
    },
    executionPath,
    services: mockServices,
    interventionMetrics: {},
    tracker: {},
    history: [],
    settings: { verbose: false },
    //... other required fields mocked minimally
  } as any;
}

describe('Loop Logic in handleReason', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should enter a loop and initialize pointer', async () => {
    const loopUnit: ExecutionUnit = {
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
    const loopUnit: ExecutionUnit = {
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
    expect(ctx.runtime.loopStates['loop-itr']).toEqual({ iteration: 2 });
    // Should execute step s1 again
    expect((result2 as any).stepId).toBe('s1');
  });

  it('should exit loop after max fixed iterations', async () => {
    const loopUnit: ExecutionUnit = {
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
    const nextUnit: ExecutionUnit = {
      type: 'step',
      step: { stepId: 's2', description: 'After Loop', action: { type: 'wait', reason: 'done' } }
    };
    
    const ctx = createMockContext({ units: [loopUnit, nextUnit] });
    const state: AgentStateReason = { phase: 'REASON', cycleIndex: 0, pageState: defaultPageState };

    // --- Iteration 1 ---
    await handleReason(state, ctx); // Enter loop
    expect(ctx.runtime.loopStates['loop-itr-exit']).toBeUndefined(); // initialized on completion logic, or maybe not? 
    // Wait, my impl initializes `loopStates` only on *continuation*. 
    // The "currentIteration" defaults to 1 if missing. Correct.

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

  it('should continue loop based on dynamic element_exists condition', async () => {
    const loopUnit: ExecutionUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-dyn',
        // No fixed iterations
        loopCondition: { type: 'element_exists', selector: '#marker' },
        steps: [{ stepId: 's1', description: 'S1', action: { type: 'wait', reason: 'w' } }]
      }
    };
    
    const ctx = createMockContext({ units: [loopUnit] });
    // Page state WITH the marker element -> Should Continue
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
    expect(ctx.runtime.loopStates['loop-dyn']).toEqual({ iteration: 2 });
  });

  it('should exit loop based on dynamic element_exists condition (element missing)', async () => {
    const loopUnit: ExecutionUnit = {
      type: 'loop',
      loop: {
        loopId: 'loop-dyn-exit',
        loopCondition: { type: 'element_exists', selector: '#marker' },
        steps: [{ stepId: 's1', description: 'S1', action: { type: 'wait', reason: 'w' } }]
      }
    };
    
    const nextUnit: ExecutionUnit = { type: 'step', step: { stepId: 's2', description: 'S2' } };
    const ctx = createMockContext({ units: [loopUnit, nextUnit] });
    
    // Page state WITHOUT the marker
    const stateWithoutMarker: AgentStateReason = { 
        phase: 'REASON', 
        cycleIndex: 0, 
        pageState: defaultPageState 
    };

    // Simulate End of Iteration 1
    // Loop check: element '#marker' exists? No. -> Exit.
    ctx.runtime.executionPointer = [0, 1];
    
    // Should exit and execute s2 (but s2 has no action, so verify logic might return wait or interact with LLM)
    // My mock nextUnit has no action, so handleReason will try Fast Path -> No Action -> return Verify Wait.
    const result = await handleReason(stateWithoutMarker, ctx);
    
    expect(ctx.runtime.executionPointer).toEqual([1]);
    expect((result as any).stepId).toBe('s2');
  });

});
