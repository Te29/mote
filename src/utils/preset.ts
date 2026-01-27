/**
 * Preset storage and loading utilities.
 *
 * Structure:
 *   presets/
 *   └── {preset-name}/
 *       ├── preset.json           (required)
 *       ├── execution-path.json   (optional)
 *       └── system-prompt.md      (optional)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Preset, ExecutionStep } from '../types/index.js';

// Default presets directory relative to project root
const PRESETS_DIR = path.join(process.cwd(), 'presets');

/**
 * Ensure the presets directory exists.
 */
function ensurePresetsDir(): void {
  if (!fs.existsSync(PRESETS_DIR)) {
    fs.mkdirSync(PRESETS_DIR, { recursive: true });
  }
}

/**
 * List all available presets from the presets directory.
 * Scans for preset folders containing preset.json files.
 * @returns Array of preset metadata (name, description, hasExecutionPath)
 */
export function listPresets(): Array<{
  name: string;
  description: string;
  hasExecutionPath: boolean;
  presetDir: string;
}> {
  ensurePresetsDir();

  const entries = fs.readdirSync(PRESETS_DIR, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory());
  const presets: Array<{
    name: string;
    description: string;
    hasExecutionPath: boolean;
    presetDir: string;
  }> = [];

  for (const folder of folders) {
    try {
      const presetDir = path.join(PRESETS_DIR, folder.name);
      const presetFilePath = path.join(presetDir, 'preset.json');

      if (!fs.existsSync(presetFilePath)) {
        continue; // Skip folders without preset.json
      }

      const content = fs.readFileSync(presetFilePath, 'utf-8');
      const preset = JSON.parse(content) as Preset;

      presets.push({
        name: preset.name,
        description: preset.description,
        hasExecutionPath: !!preset.executionPathRef,
        presetDir,
      });
    } catch {
      // Skip invalid preset folders
      console.warn(`Warning: Could not parse preset in folder: ${folder.name}`);
    }
  }

  return presets;
}

/**
 * Load a preset by name.
 * @param name - The preset name to load (folder name)
 * @returns The preset object, or null if not found
 */
export function loadPreset(name: string): Preset | null {
  ensurePresetsDir();

  const presetDir = path.join(PRESETS_DIR, name);
  const presetFilePath = path.join(presetDir, 'preset.json');

  if (!fs.existsSync(presetFilePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(presetFilePath, 'utf-8');
    return JSON.parse(content) as Preset;
  } catch {
    return null;
  }
}

/**
 * Load a preset from a preset directory path.
 * @param presetDir - Full path to the preset directory
 * @returns The preset object, or null if not found
 */
export function loadPresetFromPath(presetDir: string): Preset | null {
  const presetFilePath = path.join(presetDir, 'preset.json');

  try {
    const content = fs.readFileSync(presetFilePath, 'utf-8');
    return JSON.parse(content) as Preset;
  } catch {
    return null;
  }
}

/**
 * Load execution path from preset directory.
 * @param presetDir - Path to preset directory
 * @param executionPathRef - Reference from preset (e.g., "./execution-path.json")
 * @returns ExecutionStep array, or null if not found
 */
export function loadExecutionPath(
  presetDir: string,
  executionPathRef?: string,
): ExecutionStep[] | null {
  if (!executionPathRef) {
    return null;
  }

  const executionPathFile = path.join(presetDir, executionPathRef);

  try {
    const content = fs.readFileSync(executionPathFile, 'utf-8');
    return JSON.parse(content) as ExecutionStep[];
  } catch {
    console.warn(`Warning: Could not load execution path from: ${executionPathFile}`);
    return null;
  }
}

/**
 * Load system prompt from preset directory.
 * @param presetDir - Path to preset directory
 * @param systemPromptRef - Reference from preset (e.g., "./system-prompt.md")
 * @returns System prompt text, or null if not found
 */
export function loadSystemPrompt(
  presetDir: string,
  systemPromptRef?: string,
): string | null {
  if (!systemPromptRef) {
    return null;
  }

  const systemPromptFile = path.join(presetDir, systemPromptRef);

  try {
    return fs.readFileSync(systemPromptFile, 'utf-8');
  } catch {
    console.warn(`Warning: Could not load system prompt from: ${systemPromptFile}`);
    return null;
  }
}

/**
 * Save a preset to the presets directory.
 * @param preset - The preset to save
 * @param executionPath - Optional execution path to save
 * @param systemPrompt - Optional system prompt to save
 * @param folderName - Optional custom folder name (defaults to preset.name)
 * @returns The path to the preset directory
 */
export function savePreset(
  preset: Preset,
  executionPath?: ExecutionStep[],
  systemPrompt?: string,
  folderName?: string,
): string {
  ensurePresetsDir();

  // Sanitize folder name
  const safeName = (folderName || preset.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const presetDir = path.join(PRESETS_DIR, safeName);

  // Create preset directory
  if (!fs.existsSync(presetDir)) {
    fs.mkdirSync(presetDir, { recursive: true });
  }

  // Save preset.json
  const presetCopy = { ...preset };
  if (executionPath && executionPath.length > 0) {
    presetCopy.executionPathRef = './execution-path.json';
  }
  if (systemPrompt) {
    presetCopy.systemPromptRef = './system-prompt.md';
  }

  const presetFilePath = path.join(presetDir, 'preset.json');
  fs.writeFileSync(presetFilePath, JSON.stringify(presetCopy, null, 2));

  // Save execution-path.json if provided
  if (executionPath && executionPath.length > 0) {
    const executionPathFile = path.join(presetDir, 'execution-path.json');
    fs.writeFileSync(executionPathFile, JSON.stringify(executionPath, null, 2));
  }

  // Save system-prompt.md if provided
  if (systemPrompt) {
    const systemPromptFile = path.join(presetDir, 'system-prompt.md');
    fs.writeFileSync(systemPromptFile, systemPrompt);
  }

  return presetDir;
}

/**
 * Get the presets directory path.
 */
export function getPresetsDir(): string {
  ensurePresetsDir();
  return PRESETS_DIR;
}
