import { describe, it, expect, beforeAll } from 'vitest';
import { config } from 'dotenv';
import {
  createLLMClient,
  think,
  generatePlan,
  validateSessionPlan,
  getDefaultModel,
  askLLM,
  evaluateDrift
} from '../../src/reason.js';
import type { Goal, PageState, Action, SessionTracker, ThinkResult } from '../../src/types/index.js';
import type { InterventionMetrics } from '../../src/prompt.js';

// Load env vars
config();

// These tests require a running LLM (Ollama or OpenAI compatible).
// Run with: npm run test:reason:live
describe('Reason Module - Live LLM Tests', () => {
    let client: ReturnType<typeof createLLMClient>;

    const mockGoal: Goal = {
        name: 'Web Search',
        description: 'Search for "weather today" on Google',
        context: { query: 'weather today' },
        successCriteria: 'Search results are displayed',
    };

    const mockPageState: PageState = {
        url: 'https://www.google.com',
        title: 'Google',
        markdown: 'Google Search page with a search box and buttons.',
        elements: [
            {
                index: 1,
                tag: 'input',
                text: 'Search',
                selector: 'input[name="q"]',
                inputType: 'text',
                attributes: { name: 'q', placeholder: 'Search Google' },
            },
            {
                index: 2,
                tag: 'button',
                text: 'Google Search',
                selector: 'input[name="btnK"]',
                attributes: {},
            },
            {
                index: 3,
                tag: 'button',
                text: "I'm Feeling Lucky",
                selector: 'input[name="btnI"]',
                attributes: {},
            },
        ],
    };

    const mockInterventionMetrics: InterventionMetrics = {
        consecutiveFailures: 0,
        replanCount: 0,
        reobserveCount: 0,
    };

    const mockPlan: SessionTracker = {
        goalSummary: 'Search for "weather today" on Google',
        cycleDescription: 'Perform search',
        cycles: [{ isCompleted: false, cycleSteps: [] }],
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString()
    };

    beforeAll(() => {
        client = createLLMClient();
        console.log(`📡 Connecting to LLM...`);
        console.log(`   Base URL: ${process.env.LLM_BASE_URL || 'http://localhost:11434/v1'}`);
        console.log(`   Model: ${getDefaultModel()}`);
    });

    it('should connect to LLM and answer a simple question', async () => {
        const answer = await askLLM('What is 2 + 2? Answer with just the number.', client);
        expect(answer).toContain('4');
    }, 120000);

    it('should generate a valid plan from goal', async () => {
        const plan = await generatePlan(mockGoal, client);

        expect(plan.goalSummary).toBeDefined();
        expect(plan.cycleDescription).toBeDefined();
        expect(plan.cycles.length).toBeGreaterThanOrEqual(1);

        const validation = validateSessionPlan(plan);
        expect(validation.valid).toBe(true);
    }, 120000);

    // Skipped due to extreme slowness on local LLM (timeout > 3 mins)
    it.skip('should return a valid ThinkResult from think()', async () => {
        // Use mockPlan to save a heavy LLM call
        const result = await think(
            mockPageState,
            mockGoal,
            undefined,
            mockPlan,
            [],
            client,
            mockInterventionMetrics,
        );

        expect(['ACTION', 'GOAL_SUCCESS', 'FAIL', 'REPLAN', 'RETRY_PERCEPTION']).toContain(result.type);

        if (result.type === 'ACTION') {
            expect(result.action.type).toBeDefined();
            expect(result.action.reason).toBeDefined();
        }
    }, 300000);

    // Skipped due to extreme slowness on local LLM
    it.skip('should handle user intervention in think()', async () => {
        // Mock the initial result to skip a heavy LLM call
        const initialResult: ThinkResult = {
            type: 'ACTION',
            action: { type: 'type', selector: '1', text: 'wrong query', reason: 'Initial thought' }
        };

        const interventionResult = await think(
            mockPageState,
            mockGoal,
            undefined,
            mockPlan,
            [],
            client,
            mockInterventionMetrics,
            {
                point: 'ACTION',
                previousResult: initialResult,
                instruction: 'Actually, type "weather forecast" instead',
            },
        );

        expect(['ACTION', 'GOAL_SUCCESS', 'FAIL', 'REPLAN', 'RETRY_PERCEPTION']).toContain(interventionResult.type);
    }, 300000);

    it.skip('should evaluate drift between states', async () => {
        const driftAction: Action = { type: 'click', selector: 'input[name="q"]', reason: 'Search' };
        const result = await evaluateDrift(mockPageState, mockPageState, driftAction, client);

        expect(['can_proceed', 'cannot_complete']).toContain(result.decision);
        expect(result.reason).toBeDefined();
    }, 120000);
});
