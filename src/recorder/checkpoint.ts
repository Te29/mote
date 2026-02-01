// =============================================================================
// RECORDER CHECKPOINT
// =============================================================================
// Auto-save and crash recovery for recording sessions.

import * as fs from 'fs';
import * as path from 'path';
import type { RecorderContext, RecorderCheckpoint } from './types.js';
import { createTimestamp } from '../types/index.js';

// -----------------------------------------------------------------------------
// SAVE CHECKPOINT
// -----------------------------------------------------------------------------

/**
 * Save current recording state to checkpoint file.
 * Called after every confirmed action for crash recovery.
 */
export function saveCheckpoint(ctx: RecorderContext): void {
  const checkpoint: RecorderCheckpoint = {
    currentSection: ctx.currentSection,
    activeLoopId: ctx.activeLoopId,
    stepCounter: ctx.stepCounter,
    sessionPlan: ctx.sessionPlan,
    preset: ctx.preset,
    timestamp: createTimestamp(),
  };

  try {
    fs.writeFileSync(ctx.checkpointPath, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    console.warn(`Warning: Failed to save checkpoint: ${error}`);
  }
}

// -----------------------------------------------------------------------------
// LOAD CHECKPOINT
// -----------------------------------------------------------------------------

/**
 * Load checkpoint from file if it exists.
 * Returns null if no checkpoint or invalid.
 */
export function loadCheckpoint(checkpointPath: string): RecorderCheckpoint | null {
  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(checkpointPath, 'utf-8');
    return JSON.parse(content) as RecorderCheckpoint;
  } catch (error) {
    console.warn(`Warning: Failed to load checkpoint: ${error}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// CLEAR CHECKPOINT
// -----------------------------------------------------------------------------

/**
 * Remove checkpoint file after successful completion.
 */
export function clearCheckpoint(checkpointPath: string): void {
  if (fs.existsSync(checkpointPath)) {
    try {
      fs.unlinkSync(checkpointPath);
    } catch (error) {
      console.warn(`Warning: Failed to clear checkpoint: ${error}`);
    }
  }
}

// -----------------------------------------------------------------------------
// CHECK FOR EXISTING CHECKPOINT
// -----------------------------------------------------------------------------

/**
 * Check if a checkpoint exists for a preset directory.
 */
export function hasCheckpoint(presetDir: string): boolean {
  const checkpointPath = path.join(presetDir, '.recording-state.json');
  return fs.existsSync(checkpointPath);
}

/**
 * Get checkpoint path for a preset directory.
 */
export function getCheckpointPath(presetDir: string): string {
  return path.join(presetDir, '.recording-state.json');
}

// -----------------------------------------------------------------------------
// SAVE SESSION PLAN
// -----------------------------------------------------------------------------

/**
 * Save session plan to file.
 * Called after checkpoint save for redundancy.
 */
export function saveSessionPlan(ctx: RecorderContext): void {
  const sessionPlanPath = path.join(ctx.presetDir, 'session-plan.json');

  try {
    fs.writeFileSync(sessionPlanPath, JSON.stringify(ctx.sessionPlan, null, 2));
  } catch (error) {
    console.warn(`Warning: Failed to save session plan: ${error}`);
  }
}

/**
 * Save preset configuration to file.
 */
export function savePresetConfig(ctx: RecorderContext): void {
  const presetPath = path.join(ctx.presetDir, 'preset.json');

  try {
    fs.writeFileSync(presetPath, JSON.stringify(ctx.preset, null, 2));
  } catch (error) {
    console.warn(`Warning: Failed to save preset config: ${error}`);
  }
}
