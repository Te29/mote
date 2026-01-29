// =============================================================================
// RESULT ASSEMBLY MODULE
// =============================================================================
//
// Phase 5: Result Assembly - Finalize result and handle preset save
//
// =============================================================================

import * as path from 'path';
import type {
  Goal,
  Preset,
  ExecutionStep,
  ExecutionPath,
  SessionTracker,
  StepResult,
  AgentResult,
  EngagementMode,
  ExecutionUnit,
} from '../types/index.js';
import { getCompletedCycles } from '../types/index.js';
import { shouldIntervene, promptForPresetSave } from '../interaction.js';
import { savePreset } from '../utils/preset.js';

// ... (omitted)

/**
 * Context for result assembly.
 */
export interface ResultContext {
  success: boolean;
  message: string;
  finalUrl: string;
  startUrl: string;
  startTime: number;
  tracker: SessionTracker;
  history: StepResult[];
  hadAdaptations: boolean;
  executionPath?: ExecutionPath;
  preset?: Preset;
  presetDir?: string;
  customSystemPrompt?: string;
  engagementMode: EngagementMode;
  goal?: Goal;
}

// -----------------------------------------------------------------------------
// EXTRACT PATH FROM HISTORY
// -----------------------------------------------------------------------------

/**
 * Extract an ExecutionPath from successful run history.
 * This enables self-healing: learned paths can be cached in presets.
 *
 * @param history - Array of successful step results from an Explore mode run
 * @returns ExecutionPath object suitable for preset.executionPath
 */
export function extractPathFromHistory(history: StepResult[]): ExecutionPath {
  const steps = history
    .filter((step) => step.action.type !== 'wait') // Skip wait actions
    .map((step, index) => {
      // Find the element that was targeted (in the BEFORE state, where it exists)
      const elementIndex = parseInt(step.action.elementId || '0', 10);
      const targetElement = step.pageStateBefore.elements.find(
        (el: import('../types/index.js').ElementInfo) => el.index === elementIndex
      );

      return {
        stepId: `learned-${index + 1}`,
        description: step.action.reason || `Step ${index + 1}`,
        url: step.pageStateBefore.url,  // URL where we need to be to execute this action
        targetElementSelector: targetElement?.selector || '',
        action: step.action,
        expectedPageState: step.pageStateBefore,  // State we expect BEFORE executing the action
      } as ExecutionStep;
    })
    .filter((step) => step.targetElementSelector !== '' && !/^\d+$/.test(step.targetElementSelector || '')); // Only include steps with valid, non-index selectors
    
    return {
      units: steps.map(step => ({ type: 'step', step } as ExecutionUnit))
    };
}

// -----------------------------------------------------------------------------
// RESULT ASSEMBLY FUNCTION
// -----------------------------------------------------------------------------

/**
 * Assemble final result and handle preset save if needed.
 *
 * @param ctx - Result context with execution data
 * @returns Complete AgentResult
 */
export async function assembleResult(
  ctx: ResultContext
): Promise<AgentResult> {
  const {
    success,
    message,
    finalUrl,
    startUrl,
    startTime,
    tracker,
    history,
    hadAdaptations,
    executionPath,
    preset,
    presetDir,
    customSystemPrompt,
    engagementMode,
    goal,
  } = ctx;

  // Calculate duration
  const duration = Date.now() - startTime;
  const cyclesCompleted = getCompletedCycles(tracker);

  // Print completion banner
  console.log('\n' + '═'.repeat(60));
  console.log('📊 AGENT RUN COMPLETE');
  console.log('═'.repeat(60));
  console.log(`   Status: ${success ? '✅ Success' : '❌ Failed'}`);
  console.log(`   Message: ${message}`);
  console.log(`   Steps taken: ${history.length}`);
  console.log(`   Cycles completed: ${cyclesCompleted}/${tracker.cycles.length}`);
  console.log(`   Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`   Final URL: ${finalUrl}`);
  console.log('═'.repeat(60) + '\n');

  // ---------------------------------------------------------------------------
  // SELF-HEALING: Save/Update preset after successful run
  // Offer to save if:
  // 1. Ran in Explore mode (!executionPath) - learned new path
  // 2. Ran in Execute with adaptations (hadAdaptations) - updated existing path
  // ---------------------------------------------------------------------------
  if (success && history.length > 0 && (hadAdaptations || !executionPath)) {
    const learnedPath = extractPathFromHistory(history);

    if (learnedPath.units.length > 0 && shouldIntervene(engagementMode, 'TERMINAL')) {
      const saveResponse = await promptForPresetSave(preset, learnedPath.units.length);

      switch (saveResponse.type) {
        case 'update':
          if (preset && presetDir) {
            const savedPath = savePreset(preset, learnedPath, customSystemPrompt, path.basename(presetDir));
            console.log(`\n✅ Updated preset saved to: ${savedPath}`);
          }
          break;
        case 'save_new': {
          const presetGoal = preset?.goal || goal;
          if (!presetGoal) {
            console.log('\n⚠️  Cannot save preset without a goal.');
            break;
          }
          const newPreset: Preset = {
            name: saveResponse.name || 'Learned Preset',
            description: presetGoal.description,
            goal: presetGoal,
            startUrl,
            sessionPlan: tracker,
          };
          const savedPath = savePreset(newPreset, learnedPath, customSystemPrompt, saveResponse.name);
          console.log(`\n💾 New preset saved to: ${savedPath}`);
          console.log(`   Steps: ${learnedPath.units.length}`);
          break;
        }
        case 'discard':
          console.log('\n🗑️  Learned path discarded.');
          break;
      }
    }
  }

  // Return final result
  return {
    success,
    message,
    history,
    plan: tracker,
    cyclesCompleted,
    duration,
    finalUrl,
  };
}
