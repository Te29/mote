// =============================================================================
// VERIFICATION MODULE
// =============================================================================
// Executes script-based verification with LLM fallback

import type { Page } from 'playwright';
import type { VerificationConfig } from '../types/actions.js';
import type { PageState, Goal, Preset, SessionTracker, StepResult } from '../types/index.js';
import type { OpenAI } from 'openai';
import type { InterventionMetrics } from '../prompt.js';

/**
 * Result of verification execution.
 */
export interface VerificationResult {
  /** Whether verification passed */
  passed: boolean;

  /** How the result was determined */
  method: 'script' | 'llm' | 'strategy';

  /** Optional detail message */
  detail?: string;

  /** Optional error if script failed */
  error?: string;
}

/**
 * Context required for LLM fallback reasoning.
 */
export interface VerificationContext {
  pageState: PageState;
  goal?: Goal;
  preset?: Preset;
  tracker: SessionTracker;
  history: StepResult[];
  llmClient: OpenAI;
  metrics: InterventionMetrics;
  limits: {
    tokenMarkdown: number;
    tokenElements: number;
    tokenMaxElements: number;
    tokenHistory: number;
  };
  customSystemPrompt?: string;
}

/**
 * Execute a verification script in browser context.
 *
 * @param page - Playwright page instance
 * @param config - Verification configuration
 * @param context - Context for LLM fallback (optional)
 * @returns Verification result
 */
export async function executeVerification(
  page: Page,
  config: VerificationConfig,
  context?: VerificationContext,
): Promise<VerificationResult> {
  const { script, description, onFailure = 'llm' } = config;

  try {
    // Execute script in browser context
    const result = await page.evaluate(script);

    // Validate return type
    if (typeof result !== 'boolean') {
      throw new Error(
        `Verification script must return boolean, got ${typeof result}`,
      );
    }

    if (result) {
      return {
        passed: true,
        method: 'script',
        detail: description || 'Script verification passed',
      };
    } else {
      // Script returned false - handle based on strategy
      return handleScriptFailure(config, context, 'Script returned false');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Verification script error: ${errorMsg}`);

    // Handle script error based on strategy
    return handleScriptFailure(config, context, errorMsg);
  }
}

/**
 * Handle script failure or error based on onFailure strategy.
 */
async function handleScriptFailure(
  config: VerificationConfig,
  context: VerificationContext | undefined,
  errorMsg: string,
): Promise<VerificationResult> {
  const { onFailure = 'llm', description } = config;

  switch (onFailure) {
    case 'continue':
      console.log(
        `ℹ️ Verification failed but continuing (strategy: continue)`,
      );
      return {
        passed: true,
        method: 'strategy',
        detail: `Script failed but strategy is 'continue': ${errorMsg}`,
        error: errorMsg,
      };

    case 'fail':
      console.log(`❌ Verification failed (strategy: fail)`);
      return {
        passed: false,
        method: 'strategy',
        detail: description || 'Script verification failed',
        error: errorMsg,
      };

    case 'llm':
    default:
      if (!context) {
        // No context for LLM fallback - treat as failure
        console.warn('⚠️ No context for LLM fallback, treating as failure');
        return {
          passed: false,
          method: 'strategy',
          detail: 'Script failed and no LLM context available',
          error: errorMsg,
        };
      }

      // Fall back to LLM reasoning
      console.log(`🤖 Script failed, falling back to LLM reasoning...`);
      return executeLLMVerification(config, context);
  }
}

/**
 * Execute LLM-based verification as fallback.
 */
async function executeLLMVerification(
  config: VerificationConfig,
  context: VerificationContext,
): Promise<VerificationResult> {
  const { description } = config;
  const {
    pageState,
    goal,
    preset,
    tracker,
    history,
    llmClient,
    metrics,
    limits,
    customSystemPrompt,
  } = context;

  // Import reason service dynamically to avoid circular dependency
  const { think } = await import('../reason.js');

  // Ask LLM to verify completion
  const result = await think(
    pageState,
    goal,
    preset,
    tracker,
    history,
    llmClient,
    metrics,
    limits,
    {
      point: 'TERMINAL',
      previousResult: {
        type: 'GOAL_SUCCESS',
        finalAnswer: 'Verification needed',
      },
      instruction: description
        ? `Verify the following condition: ${description}`
        : 'Verify if the current goal/step is truly complete.',
    },
    customSystemPrompt,
  );

  // Interpret LLM result
  if (result.type === 'GOAL_SUCCESS') {
    return {
      passed: true,
      method: 'llm',
      detail: result.finalAnswer,
    };
  } else if (result.type === 'FAIL') {
    return {
      passed: false,
      method: 'llm',
      detail: result.error,
    };
  } else {
    // LLM wants to continue acting - treat as incomplete
    return {
      passed: false,
      method: 'llm',
      detail: 'LLM determined task is not complete',
    };
  }
}
