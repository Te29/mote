// =============================================================================
// RECORDER MODULE - Public API
// =============================================================================
// Interactive preset creation through action recording.

// Types
export type {
  RecordingPhase,
  RecordingSection,
  RecorderState,
  RecordedAction,
  RecordedElementInfo,
  RecorderContext,
  ActionDecision,
  PhaseControlAction,
  LoopConfig,
  RecorderResult,
  RecorderBootstrapResult,
  RecorderCheckpoint,
  RecordingInitResult,
} from './types.js';

// Bootstrap
export { bootstrapRecorder } from './bootstrap.js';

// Runtime
export { executeRecorder } from './runtime.js';

// Prompts (for external use if needed)
export {
  promptRecordingInit,
  promptAfterAction,
  promptPhaseControl,
} from './prompts.js';
