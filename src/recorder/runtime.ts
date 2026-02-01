// =============================================================================
// RECORDER RUNTIME
// =============================================================================
// State machine loop for the recording module.
// Mirrors pattern from src/runtime/runtime.ts.

import type { RecorderState, RecorderContext, RecorderResult } from './types.js';
import { handleInit, handleRecording, handleFinalize } from './handlers/index.js';
import { closeRecorderReadline } from './prompts.js';
import { closeBrowser } from '../browser.js';

// -----------------------------------------------------------------------------
// MAIN EXECUTION LOOP
// -----------------------------------------------------------------------------

/**
 * Execute the recorder state machine.
 * Loops through phases until DONE.
 */
export async function executeRecorder(
  context: RecorderContext,
): Promise<RecorderResult> {
  let state: RecorderState = { phase: 'INIT' };

  try {
    while (state.phase !== 'DONE') {
      switch (state.phase) {
        case 'INIT':
          state = await handleInit(state, context);
          break;

        case 'RECORDING':
          state = await handleRecording(state, context);
          break;

        case 'FINALIZE':
          state = await handleFinalize(state, context);
          break;
      }
    }

    return {
      success: true,
      presetDir: state.presetDir,
      message: `Preset created successfully at ${state.presetDir}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n💥 Recording error: ${errorMessage}`);

    return {
      success: false,
      presetDir: context.presetDir,
      message: `Recording failed: ${errorMessage}`,
    };
  } finally {
    // Cleanup
    try {
      await closeBrowser(context.page.context().browser()!);
    } catch {
      // Ignore browser close errors
    }
    closeRecorderReadline();
  }
}
