// =============================================================================
// FINALIZE HANDLER
// =============================================================================
// Handles the FINALIZE phase - cleanup, polish, dry run options.

import type { RecorderState, RecorderContext } from '../types.js';
import { promptFinalize } from '../prompts.js';
import { clearCheckpoint, saveSessionPlan, savePresetConfig } from '../checkpoint.js';
import { polishPreset } from '../llm-generator.js';

/**
 * Handle FINALIZE phase.
 * Offers polish and dry run options, then completes.
 */
export async function handleFinalize(
  _state: RecorderState & { phase: 'FINALIZE' },
  ctx: RecorderContext,
): Promise<RecorderState> {
  // Final save
  saveSessionPlan(ctx);
  savePresetConfig(ctx);

  // Prompt for finalization options
  const options = await promptFinalize();

  // Polish with LLM if requested
  if (options.polish) {
    console.log('\n🤖 Polishing preset with LLM...');
    try {
      const { polishedPreset, polishedPlan } = await polishPreset(
        ctx.llmClient,
        ctx.preset,
        ctx.sessionPlan,
      );

      // Show diff
      console.log('\n📝 Suggested improvements:');
      console.log('─'.repeat(40));

      if (polishedPreset.description !== ctx.preset.description) {
        console.log(`Description: "${ctx.preset.description}" → "${polishedPreset.description}"`);
      }

      if (polishedPlan.goalSummary !== ctx.sessionPlan.goalSummary) {
        console.log(`Goal: "${ctx.sessionPlan.goalSummary}" → "${polishedPlan.goalSummary}"`);
      }

      // Apply polished versions
      ctx.preset = polishedPreset;
      ctx.sessionPlan = polishedPlan;

      // Save again
      saveSessionPlan(ctx);
      savePresetConfig(ctx);

      console.log('✓ Preset polished');
    } catch (error) {
      console.warn(`⚠️ Failed to polish preset: ${error}`);
    }
  }

  // Dry run if requested
  if (options.dryRun) {
    console.log('\n🧪 Dry run not implemented yet.');
    console.log('   You can test manually with: mote --preset ' + ctx.preset.name);
    // TODO: Import and call runAgent with the created preset
  }

  // Clear checkpoint (successful completion)
  clearCheckpoint(ctx.checkpointPath);

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('✅ PRESET CREATED SUCCESSFULLY');
  console.log('═'.repeat(60));
  console.log(`\n📁 Location: ${ctx.presetDir}`);
  console.log(`📝 Name: ${ctx.preset.name}`);
  console.log(`📋 Steps recorded: ${ctx.stepCounter}`);
  console.log(`\n🚀 Run with: mote --preset ${ctx.preset.name}`);
  console.log('');

  return {
    phase: 'DONE',
    presetDir: ctx.presetDir,
  };
}
