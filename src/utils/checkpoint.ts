// =============================================================================
// SESSION CHECKPOINT UTILITIES
// =============================================================================
// Utilities for saving and loading session checkpoints.
// Separate from presets - checkpoints are transient execution state.
//
// Structure:
//   .mote-checkpoints/
//   └── {session-id}-{timestamp}.json

import * as fs from 'fs';
import * as path from 'path';
import type { SessionTracker, StepResult } from '../types/index.js';

const CHECKPOINT_DIR = path.join(process.cwd(), '.mote-checkpoints');

// =============================================================================
// Types
// =============================================================================

/**
 * Complete checkpoint data structure.
 * Contains everything needed to resume a session.
 */
export interface SessionCheckpoint {
  /** Mote version for compatibility checking */
  version: string;

  /** When checkpoint was created */
  timestamp: string;

  /** Unique session identifier */
  sessionId: string;

  // Core session state
  /** Session execution tracker */
  tracker: SessionTracker;

  /** Complete step history */
  history: StepResult[];

  // Runtime metadata
  /** Initial start URL */
  startUrl: string;

  /** Last known URL when checkpoint was saved */
  lastUrl: string;

  // Config for resumption
  /** Goal description (optional) */
  goalDescription?: string;

  /** Preset name if loaded from preset (optional) */
  presetName?: string;
}

/**
 * Checkpoint metadata for listing.
 */
export interface CheckpointMetadata {
  /** Full path to checkpoint file */
  filepath: string;

  /** Session identifier */
  sessionId: string;

  /** Checkpoint timestamp */
  timestamp: string;

  /** Goal description if available */
  goalDescription?: string;
}

// =============================================================================
// File System Utilities
// =============================================================================

/**
 * Ensure checkpoint directory exists.
 */
function ensureCheckpointDir(): void {
  if (!fs.existsSync(CHECKPOINT_DIR)) {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  }
}

/**
 * Generate checkpoint filename.
 */
function generateCheckpointFilename(sessionId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${sessionId}-${timestamp}.json`;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Save session checkpoint to disk.
 *
 * @param checkpoint - Complete checkpoint data
 * @returns Path to saved checkpoint file
 * @throws Error if save fails
 */
export function saveCheckpoint(checkpoint: SessionCheckpoint): string {
  ensureCheckpointDir();

  const filename = generateCheckpointFilename(checkpoint.sessionId);
  const filepath = path.join(CHECKPOINT_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(checkpoint, null, 2), 'utf-8');

  return filepath;
}

/**
 * Load checkpoint from file.
 *
 * @param filepath - Path to checkpoint file
 * @returns Checkpoint data or null if load fails
 */
export function loadCheckpoint(filepath: string): SessionCheckpoint | null {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content) as SessionCheckpoint;
  } catch (error) {
    console.error(`Failed to load checkpoint from ${filepath}:`, error);
    return null;
  }
}

/**
 * List available checkpoints.
 *
 * @returns Array of checkpoint metadata, sorted by timestamp descending (newest first)
 */
export function listCheckpoints(): CheckpointMetadata[] {
  ensureCheckpointDir();

  const files = fs.readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json'));

  const checkpoints: CheckpointMetadata[] = [];

  for (const file of files) {
    const filepath = path.join(CHECKPOINT_DIR, file);
    const checkpoint = loadCheckpoint(filepath);

    if (checkpoint) {
      checkpoints.push({
        filepath,
        sessionId: checkpoint.sessionId,
        timestamp: checkpoint.timestamp,
        goalDescription: checkpoint.goalDescription,
      });
    }
  }

  // Sort by timestamp descending (newest first)
  return checkpoints.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

/**
 * Delete old checkpoints, keeping only the most recent N.
 *
 * @param keepCount - Number of recent checkpoints to keep (default: 5)
 */
export function cleanupCheckpoints(keepCount: number = 5): void {
  const checkpoints = listCheckpoints();

  if (checkpoints.length > keepCount) {
    const toDelete = checkpoints.slice(keepCount);

    for (const checkpoint of toDelete) {
      try {
        fs.unlinkSync(checkpoint.filepath);
      } catch (error) {
        console.warn(`Failed to delete checkpoint ${checkpoint.filepath}:`, error);
        // Non-fatal, continue cleanup
      }
    }
  }
}

/**
 * Get checkpoint directory path.
 * Ensures directory exists before returning.
 *
 * @returns Absolute path to checkpoint directory
 */
export function getCheckpointDir(): string {
  ensureCheckpointDir();
  return CHECKPOINT_DIR;
}

/**
 * Delete a specific checkpoint file.
 *
 * @param filepath - Path to checkpoint file to delete
 * @returns true if deletion successful, false otherwise
 */
export function deleteCheckpoint(filepath: string): boolean {
  try {
    fs.unlinkSync(filepath);
    return true;
  } catch (error) {
    console.error(`Failed to delete checkpoint ${filepath}:`, error);
    return false;
  }
}

/**
 * Get the most recent checkpoint for a specific session.
 *
 * @param sessionId - Session identifier
 * @returns Checkpoint metadata or null if not found
 */
export function getLatestCheckpoint(sessionId: string): CheckpointMetadata | null {
  const checkpoints = listCheckpoints();
  return checkpoints.find((cp) => cp.sessionId === sessionId) || null;
}
