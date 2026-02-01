// =============================================================================
// INIT HANDLER
// =============================================================================
// Handles the INIT phase - transition to RECORDING.

import type { RecorderState, RecorderContext } from '../types.js';

/**
 * Handle INIT phase.
 * Simply transitions to RECORDING with setup section.
 */
export async function handleInit(
  _state: RecorderState & { phase: 'INIT' },
  _ctx: RecorderContext,
): Promise<RecorderState> {
  console.log('\n' + '═'.repeat(60));
  console.log('📹 Starting recording session');
  console.log('═'.repeat(60));
  console.log('\nPhases: SETUP → CYCLE → WRAPUP');
  console.log('');
  console.log('Instructions:');
  console.log('  • Perform actions in the browser');
  console.log('  • Each action will be captured and prompted');
  console.log('  • Press Ctrl+C in terminal for phase control menu');
  console.log('');

  return {
    phase: 'RECORDING',
    section: 'setup',
  };
}
