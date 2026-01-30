/**
 * Preset storage and loading utilities.
 *
 * Structure:
 *   presets/
 *   └── {preset-name}/
 *       ├── preset.json         (required)
 *       ├── session-plan.json   (optional - session blueprint)
 *       └── system-prompt.md    (optional)
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  Preset,
  SessionPlan,
  CyclePlan
} from '../types/index.js';

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
 * @returns Array of preset metadata (name, description, hasSessionPlan)
 */
export function listPresets(): Array<{
  name: string;
  description: string;
  hasSessionPlan: boolean;
  presetDir: string;
}> {
  ensurePresetsDir();

  const entries = fs.readdirSync(PRESETS_DIR, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory());
  const presets: Array<{
    name: string;
    description: string;
    hasSessionPlan: boolean;
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
        hasSessionPlan: !!preset.sessionPlanRef,
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
 * Load session plan from preset directory.
 * @param presetDir - Path to preset directory
 * @param sessionPlanRef - Reference from preset (e.g., "./session-plan.json")
 * @returns SessionPlan object, or null if not found
 */
export function loadSessionPlan(
  presetDir: string,
  sessionPlanRef?: string,
): SessionPlan | null {
  if (!sessionPlanRef) {
    return null;
  }

  const sessionPlanFile = path.join(presetDir, sessionPlanRef);

  try {
    const content = fs.readFileSync(sessionPlanFile, 'utf-8');
    return JSON.parse(content) as SessionPlan;
  } catch {
    console.warn(`Warning: Could not load session plan from: ${sessionPlanFile}`);
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
 * @param sessionPlan - Optional session plan to save
 * @param systemPrompt - Optional system prompt to save
 * @param folderName - Optional custom folder name (defaults to preset.name)
 * @returns The path to the preset directory
 */
export function savePreset(
  preset: Preset,
  sessionPlan?: SessionPlan | CyclePlan,
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
  if (sessionPlan) {
    presetCopy.sessionPlanRef = './session-plan.json';
  }
  if (systemPrompt) {
    presetCopy.systemPromptRef = './system-prompt.md';
  }

  const presetFilePath = path.join(presetDir, 'preset.json');
  fs.writeFileSync(presetFilePath, JSON.stringify(presetCopy, null, 2));

  // Save session-plan.json if provided
  if (sessionPlan) {
    const sessionPlanFile = path.join(presetDir, 'session-plan.json');
    fs.writeFileSync(sessionPlanFile, JSON.stringify(sessionPlan, null, 2));
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
