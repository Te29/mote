// =============================================================================
// RECORD HANDLER
// =============================================================================
// Handles the RECORDING phase - captures user actions.

import type {
  RecorderState,
  RecorderContext,
  RecordingSection,
  LoopConfig,
  RecordedAction,
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
import { observeAndSavePage } from '../page-observer.js';
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

  // Observe and save initial page state (only in setup section on first entry)
  if (state.section === 'setup') {
    await observeAndSavePage(ctx.page, ctx.presetDir);
  }

  printSectionHeader(state.section, ctx.activeLoopId);

  while (true) {
    // Wait for action
    const action = await interceptor.waitForAction();

    // If navigation detected, observe and save the new page
    if (action.type === 'navigate') {
      // observeAndSavePage will handle waiting for page load internally
      await observeAndSavePage(ctx.page, ctx.presetDir);
    }

    // Handle recorded action
    const decision = await promptAfterAction(action, ctx.presetDir);

    if (decision.action === 'keep') {
      await saveKeptAction(ctx, state.section, action, decision.description, decision.generatePrompt);
    } else if (decision.action === 'edit') {
      // Edit selector - put action back with new selector
      action.selector = decision.newSelector;
      // Re-prompt for this action (one retry only)
      const retryDecision = await promptAfterAction(action, ctx.presetDir);
      if (retryDecision.action === 'keep') {
        await saveKeptAction(ctx, state.section, action, retryDecision.description, retryDecision.generatePrompt);
      } else if (retryDecision.action === 'menu') {
        // User requested menu - show phase control
        const control = await promptPhaseControl(state.section, ctx.activeLoopId);
        await handlePhaseControl(control, state, ctx, interceptor);
      }
      // If retry is 'discard' or 'edit', silently drop it
    } else if (decision.action === 'menu') {
      // User requested control menu - show it
      const control = await promptPhaseControl(state.section, ctx.activeLoopId);
      const result = await handlePhaseControl(control, state, ctx, interceptor);
      if (result) return result; // Exit recording if done or moving to next section
    }
    // 'discard' - do nothing, continue to next action
  }
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Save a kept action to the session plan.
 * Handles step creation, prompt generation, and checkpointing.
 */
async function saveKeptAction(
  ctx: RecorderContext,
  section: RecordingSection,
  action: RecordedAction,
  description: string,
  generatePrompt: boolean,
): Promise<void> {
  ctx.stepCounter++;
  const stepId = generateStepId(ctx.stepCounter, description);

  const step: StepPlan = {
    stepId,
    description,
    instruction: description,
    targetElementSelector: action.selector,
  };

  // Handle type action - store value in instruction
  if (action.type === 'type' && action.value) {
    step.instruction = `${description}. Enter value: "${action.value}"`;
  }

  // Generate step prompt if requested
  if (generatePrompt) {
    try {
      const promptContent = await generateStepPrompt(
        ctx.llmClient,
        description,
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
  addStepToSection(ctx, section, step, ctx.activeLoopId);

  // Auto-save
  saveCheckpoint(ctx);
  saveSessionPlan(ctx);

  console.log(`   ✓ Step saved: ${stepId}`);
}

/**
 * Handle phase control menu actions.
 * Returns a new RecorderState if the phase should exit (next section or done).
 */
async function handlePhaseControl(
  control: import('../types.js').PhaseControlAction,
  state: RecorderState & { phase: 'RECORDING' },
  ctx: RecorderContext,
  interceptor: ActionInterceptor,
): Promise<RecorderState | null> {
  switch (control) {
    case 'start-loop':
      // Loops only make sense in cycle section (setup/wrapup run once)
      if (state.section !== 'cycle') {
        console.log('\n⚠️ Loops can only be created in the cycle section.');
        console.log('   Move to cycle section first (setup → cycle → wrapup).');
        return null;
      }
      const loopConfig = await promptLoopConfig();
      const loopId = `loop-${Date.now()}`;
      addLoopToSection(ctx, loopId, loopConfig);
      ctx.activeLoopId = loopId;
      console.log(`\n🔄 Started loop: ${loopId}`);
      printSectionHeader(state.section, ctx.activeLoopId);
      return null;

    case 'end-loop':
      ctx.activeLoopId = null;
      console.log('\n✓ Loop ended');
      printSectionHeader(state.section, null);
      return null;

    case 'verification':
      const verifyDesc = await promptVerification();
      const script = await generateVerificationScript(ctx.llmClient, verifyDesc);
      addVerificationToSection(ctx, state.section, script, verifyDesc);
      console.log('\n✓ Verification added');
      printSectionHeader(state.section, ctx.activeLoopId);
      return null;

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
      return null;
  }
}

function printSectionHeader(section: RecordingSection, loopId: string | null): void {
  console.log('\n' + '─'.repeat(50));
  console.log(
    `📍 Recording: ${section.toUpperCase()}` +
      (loopId ? ` (in loop: ${loopId})` : ''),
  );
  console.log('   Perform actions in browser. Press "m" for menu.');
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
