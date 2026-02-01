// =============================================================================
// RECORD HANDLER
// =============================================================================
// Handles the RECORDING phase - captures user actions.

import type {
  RecorderState,
  RecorderContext,
  RecordingSection,
  LoopConfig,
} from '../types.js';
import type { StepPlan, LoopPlan, PlanUnit } from '../../types/index.js';
import { ActionInterceptor } from '../interceptor.js';
import {
  promptAfterAction,
  promptPhaseControl,
  promptLoopConfig,
  promptVerification,
} from '../prompts.js';
import { saveCheckpoint, saveSessionPlan } from '../checkpoint.js';
import { generateStepPrompt, generateVerificationScript } from '../llm-generator.js';
import * as fs from 'fs';
import * as path from 'path';

// -----------------------------------------------------------------------------
// MAIN HANDLER
// -----------------------------------------------------------------------------

/**
 * Handle RECORDING phase.
 * Main recording loop that captures actions and builds the session plan.
 */
export async function handleRecording(
  state: RecorderState & { phase: 'RECORDING' },
  ctx: RecorderContext,
): Promise<RecorderState> {
  const interceptor = new ActionInterceptor(ctx.page);
  await interceptor.attach();

  // Update context section from state
  ctx.currentSection = state.section;
  ctx.activeLoopId = state.loopId || null;

  printSectionHeader(state.section, ctx.activeLoopId);

  // Set up Ctrl+C handler for phase control
  let controlRequested = false;
  // Preserve all existing SIGINT handlers for restoration
  const originalHandlers = process.listeners('SIGINT').slice() as ((...args: unknown[]) => void)[];

  const sigintHandler = () => {
    controlRequested = true;
  };

  process.removeAllListeners('SIGINT');
  process.on('SIGINT', sigintHandler);

  try {
    while (true) {
      // Check for control request
      if (controlRequested) {
        controlRequested = false;
        const control = await promptPhaseControl(state.section, ctx.activeLoopId);

        switch (control) {
          case 'start-loop':
            // Loops only make sense in cycle section (setup/wrapup run once)
            if (state.section !== 'cycle') {
              console.log('\n⚠️ Loops can only be created in the cycle section.');
              console.log('   Move to cycle section first (setup → cycle → wrapup).');
              break;
            }
            const loopConfig = await promptLoopConfig();
            const loopId = `loop-${Date.now()}`;
            addLoopToSection(ctx, loopId, loopConfig);
            ctx.activeLoopId = loopId;
            console.log(`\n🔄 Started loop: ${loopId}`);
            break;

          case 'end-loop':
            ctx.activeLoopId = null;
            console.log('\n✓ Loop ended');
            break;

          case 'verification':
            const verifyDesc = await promptVerification();
            const script = await generateVerificationScript(ctx.llmClient, verifyDesc);
            addVerificationToSection(ctx, state.section, script, verifyDesc);
            console.log('\n✓ Verification added');
            break;

          case 'next-section':
            interceptor.detach();
            const nextSection = getNextSection(state.section);
            if (nextSection) {
              return { phase: 'RECORDING', section: nextSection };
            }
            return { phase: 'FINALIZE' };

          case 'done':
            interceptor.detach();
            return { phase: 'FINALIZE' };

          case 'continue':
          default:
            printSectionHeader(state.section, ctx.activeLoopId);
            break;
        }
        continue;
      }

      // Wait for action with timeout to check for control requests
      const action = await Promise.race([
        interceptor.waitForAction(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);

      if (action === null) {
        // Timeout - check for control request and loop
        continue;
      }

      // Handle recorded action
      const decision = await promptAfterAction(action);

      if (decision.action === 'keep') {
        ctx.stepCounter++;
        const stepId = generateStepId(ctx.stepCounter, decision.description);

        const step: StepPlan = {
          stepId,
          description: decision.description,
          instruction: decision.description,
          targetElementSelector: action.selector,
        };

        // Handle type action - store value in instruction
        if (action.type === 'type' && action.value) {
          step.instruction = `${decision.description}. Enter value: "${action.value}"`;
        }

        // Generate step prompt if requested
        if (decision.generatePrompt) {
          try {
            const promptContent = await generateStepPrompt(
              ctx.llmClient,
              decision.description,
              action,
            );
            const promptPath = `./prompts/${stepId}.md`;
            const fullPromptPath = path.join(ctx.presetDir, promptPath);
            fs.writeFileSync(fullPromptPath, promptContent);
            step.promptRef = promptPath;
            console.log(`   📝 Generated prompt: ${promptPath}`);
          } catch (error) {
            console.warn(`   ⚠️ Failed to generate prompt: ${error}`);
          }
        }

        // Add step to session plan
        addStepToSection(ctx, state.section, step, ctx.activeLoopId);

        // Auto-save
        saveCheckpoint(ctx);
        saveSessionPlan(ctx);

        console.log(`   ✓ Step saved: ${stepId}`);
      } else if (decision.action === 'edit') {
        // Edit selector - put action back with new selector
        action.selector = decision.newSelector;
        // Re-prompt for this action
        const retryDecision = await promptAfterAction(action);
        if (retryDecision.action === 'keep') {
          ctx.stepCounter++;
          const stepId = generateStepId(ctx.stepCounter, retryDecision.description);

          const step: StepPlan = {
            stepId,
            description: retryDecision.description,
            instruction: retryDecision.description,
            targetElementSelector: action.selector,
          };

          // Handle type action - store value in instruction
          if (action.type === 'type' && action.value) {
            step.instruction = `${retryDecision.description}. Enter value: "${action.value}"`;
          }

          // Generate step prompt if requested
          if (retryDecision.generatePrompt) {
            try {
              const promptContent = await generateStepPrompt(
                ctx.llmClient,
                retryDecision.description,
                action,
              );
              const promptPath = `./prompts/${stepId}.md`;
              const fullPromptPath = path.join(ctx.presetDir, promptPath);
              fs.writeFileSync(fullPromptPath, promptContent);
              step.promptRef = promptPath;
              console.log(`   📝 Generated prompt: ${promptPath}`);
            } catch (error) {
              console.warn(`   ⚠️ Failed to generate prompt: ${error}`);
            }
          }

          addStepToSection(ctx, state.section, step, ctx.activeLoopId);
          saveCheckpoint(ctx);
          saveSessionPlan(ctx);
          console.log(`   ✓ Step saved: ${stepId}`);
        }
      }
      // 'discard' - do nothing, continue to next action
    }
  } finally {
    // Restore all original SIGINT handlers
    process.removeAllListeners('SIGINT');
    for (const handler of originalHandlers) {
      process.on('SIGINT', handler);
    }
  }
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

function printSectionHeader(section: RecordingSection, loopId: string | null): void {
  console.log('\n' + '─'.repeat(50));
  console.log(
    `📍 Recording: ${section.toUpperCase()}` +
      (loopId ? ` (in loop: ${loopId})` : ''),
  );
  console.log('   Perform actions in browser. Ctrl+C for menu.');
  console.log('─'.repeat(50));
}

function getNextSection(current: RecordingSection): RecordingSection | null {
  switch (current) {
    case 'setup':
      return 'cycle';
    case 'cycle':
      return 'wrapup';
    case 'wrapup':
      return null;
  }
}

function generateStepId(counter: number, description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return `step-${counter}-${slug || 'action'}`;
}

function addStepToSection(
  ctx: RecorderContext,
  section: RecordingSection,
  step: StepPlan,
  loopId: string | null,
): void {
  const plan = ctx.sessionPlan;
  const unit: PlanUnit = { type: 'step', step };

  switch (section) {
    case 'setup':
      if (!plan.setupSteps) plan.setupSteps = [];
      plan.setupSteps.push(step);
      break;

    case 'cycle':
      if (loopId) {
        // Find loop and add step to it
        const loop = findLoop(plan.cyclePlan.units, loopId);
        if (loop) {
          loop.steps.push(step);
        } else {
          console.warn(`Warning: Loop ${loopId} not found, adding to cycle directly`);
          plan.cyclePlan.units.push(unit);
        }
      } else {
        plan.cyclePlan.units.push(unit);
      }
      break;

    case 'wrapup':
      if (!plan.wrapupSteps) plan.wrapupSteps = [];
      plan.wrapupSteps.push(step);
      break;
  }
}

function addLoopToSection(
  ctx: RecorderContext,
  loopId: string,
  config: LoopConfig,
): void {
  const loop: LoopPlan = {
    loopId,
    steps: [],
  };

  if (config.iterations) {
    loop.iterations = config.iterations;
  }
  // Note: loopCondition would need more complex handling for dynamic conditions

  const unit: PlanUnit = { type: 'loop', loop };
  ctx.sessionPlan.cyclePlan.units.push(unit);
}

function findLoop(units: PlanUnit[], loopId: string): LoopPlan | null {
  for (const unit of units) {
    if (unit.type === 'loop' && unit.loop.loopId === loopId) {
      return unit.loop;
    }
  }
  return null;
}

function addVerificationToSection(
  ctx: RecorderContext,
  section: RecordingSection,
  script: string,
  description: string,
): void {
  const verification = {
    script,
    description,
    onFailure: 'llm' as const,
  };

  switch (section) {
    case 'setup':
      // Runs after setup steps complete, before cycles begin
      ctx.sessionPlan.setupVerification = verification;
      break;
    case 'cycle':
      // Runs after each cycle completes
      ctx.sessionPlan.cyclePlan.verification = verification;
      break;
    case 'wrapup':
      // Runs after wrapup steps complete
      ctx.sessionPlan.wrapupVerification = verification;
      break;
  }
}
