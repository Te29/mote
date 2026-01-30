
import * as readline from 'readline';
import type {
  Goal,
  SessionTracker,
  ThinkResult,
  InterventionPoint,
  EngagementMode,
  InterventionResponse,
  PageState,
  Preset,
} from './types/index.js';
import { listPresets, loadPresetFromPath } from './utils/preset.js';

// -----------------------------------------------------------------------------
// INTERRUPT ANYTIME FEATURE
// -----------------------------------------------------------------------------
// Allows user to press a key at any time to pause and intervene.

let interruptRequested = false;
let interruptListenerActive = false;

/**
 * Start listening for interrupt key presses.
 * Works in raw mode when available (terminal), falls back gracefully otherwise.
 */
export function startInterruptListener(): void {
  if (interruptListenerActive) return;
  
  try {
    // Enable raw mode if available (allows key-by-key input)
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
    
    readline.emitKeypressEvents(process.stdin);
    
    process.stdin.on('keypress', (_str: string | undefined, key: readline.Key) => {
      // Check for 'i' key or Ctrl+C
      if (key?.name === 'i' || (key?.ctrl && key?.name === 'c')) {
        interruptRequested = true;
        console.log('\n⚡ Interrupt requested - will pause at next step...');
      }
    });
    
    interruptListenerActive = true;
    console.log('💡 Press "i" at any time to pause and intervene.');
  } catch {
    // Failed to set up raw mode - gracefully degrade
    console.log('ℹ️  Interrupt-anytime not available in this terminal.');
  }
}

/**
 * Check if user has requested an interrupt and clear the flag.
 */
export function checkInterrupt(): boolean {
  if (interruptRequested) {
    interruptRequested = false;
    return true;
  }
  return false;
}

/**
 * Stop the interrupt listener (cleanup on exit).
 */
export function stopInterruptListener(): void {
  if (interruptListenerActive && typeof process.stdin.setRawMode === 'function') {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Ignore cleanup errors
    }
  }
  interruptListenerActive = false;
}

// -----------------------------------------------------------------------------
// READLINE MANAGEMENT
// -----------------------------------------------------------------------------

let rl: readline.Interface | null = null;

function getReadlineInterface(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

export function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/**
 * Helper to ask a question using the shared readline interface.
 */
function askQuestion(prompt: string): Promise<string> {
  const rli = getReadlineInterface();
  return new Promise((resolve) => {
    rli.question(prompt, resolve);
  });
}

// -----------------------------------------------------------------------------
// ENGAGEMENT MODE → INTERVENTION POINTS MAPPING
// -----------------------------------------------------------------------------

export const ENGAGEMENT_POINTS: Record<EngagementMode, Set<InterventionPoint>> = {
  autonomous: new Set([]),
  minimal: new Set(['TERMINAL']),
  standard: new Set(['PLAN_PREVIEW', 'ACTION', 'TERMINAL', 'ERROR']),
  supervised: new Set([
    'PLAN_PREVIEW',
    'CYCLE_START',
    'ACTION',
    'TERMINAL',
    'ERROR',
  ]),
  full: new Set([
    'PLAN_PREVIEW',
    'CYCLE_START',
    'ACTION',
    'TERMINAL',
    'REPLAN',
    'REPERCEIVE',
    'CYCLE_END',
    'ERROR',
  ]),
};

/**
 * Check if intervention is needed at this point based on engagement mode.
 */
export function shouldIntervene(
  engagementMode: EngagementMode,
  point: InterventionPoint,
): boolean {
  return ENGAGEMENT_POINTS[engagementMode].has(point);
}

// -----------------------------------------------------------------------------
// HELPER: ANSI COLORS (Safe)
// -----------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

const colors = {
  reset: isTTY ? '\x1b[0m' : '',
  bright: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  gray: isTTY ? '\x1b[90m' : '',
};

// -----------------------------------------------------------------------------
// INTERVENTION SYSTEM
// -----------------------------------------------------------------------------

/**
 * Control flow decision from an intervention.
 */
export type InterventionControl =
  | { action: 'continue' }
  | { action: 'skip' }
  | { action: 'terminate'; reason: string }
  | { action: 'succeed'; message?: string }
  | { action: 'modify'; instruction: string };

/**
 * Request user intervention at a specific point.
 * Loops until a valid response is received.
 */
export async function requestIntervention(
  point: InterventionPoint,
  context: {
    plan: SessionTracker;
    thinkResult?: ThinkResult;
    pageState?: PageState;
    error?: string;
    cycleIndex?: number;
  },
): Promise<InterventionResponse> {
  
  // ---------------------------------------------------------------------------
  // Display context based on intervention point
  // ---------------------------------------------------------------------------
  console.log('\n' + colors.gray + '═'.repeat(60) + colors.reset);
  console.log(`${colors.red}🛑 INTERVENTION POINT: ${point}${colors.reset}`);
  console.log(colors.gray + '═'.repeat(60) + colors.reset);

  switch (point) {
    case 'PLAN_PREVIEW':
      console.log(`\n${colors.cyan}📋 Session Plan:${colors.reset}`);
      console.log(`   Goal: ${context.plan.goalSummary}`);
      console.log(`   Cycles: ${context.plan.cycles.length}`);
      console.log(`   Each cycle: ${context.plan.cycleDescription}`);
      break;

    case 'CYCLE_START':
      console.log(
        `\n${colors.cyan}🔄 Starting Cycle ${(context.cycleIndex || 0) + 1}/${context.plan.cycles.length}${colors.reset}`,
      );
      console.log(`   ${context.plan.cycleDescription}`);
      break;

    case 'ACTION':
      if (context.thinkResult?.type === 'ACTION') {
        const action = context.thinkResult.action;
        console.log(`\n${colors.yellow}⚡ Proposed Action: ${action.type.toUpperCase()}${colors.reset}`);
        if (action.elementId)
          console.log(`   Target: Element [${action.elementId}]`);
        if (action.text) console.log(`   Text: "${action.text}"`);
        console.log(`   Reason: ${action.reason}`);
      }
      break;

    case 'TERMINAL':
      if (context.thinkResult?.type === 'GOAL_SUCCESS') {
        console.log(`\n${colors.green}✅ Agent says GOAL_SUCCESS:${colors.reset}`);
        console.log(`   ${context.thinkResult.finalAnswer}`);
      } else if (context.thinkResult?.type === 'FAIL') {
        console.log(`\n${colors.red}❌ Agent says FAIL:${colors.reset}`);
        console.log(`   ${context.thinkResult.error}`);
      }
      break;

    case 'REPLAN':
      if (context.thinkResult?.type === 'REPLAN') {
        console.log(`\n${colors.yellow}🔄 Agent wants to REPLAN:${colors.reset}`);
        console.log(`   Reason: ${context.thinkResult.reason}`);
      }
      break;

    case 'REPERCEIVE':
      console.log(`\n${colors.cyan}👁️ Agent wants to re-perceive the page${colors.reset}`);
      if (context.pageState) {
        console.log(`   Current URL: ${context.pageState.url}`);
      }
      break;

    case 'CYCLE_END':
      console.log(`\n${colors.green}✓ Cycle ${(context.cycleIndex || 0) + 1} completed${colors.reset}`);
      const remaining =
        context.plan.cycles.length - (context.cycleIndex || 0) - 1;
      console.log(`   Remaining cycles: ${remaining}`);
      break;

    case 'ERROR':
    case 'INTERRUPT': // Handle interruptions same as errors visually
      console.log(`\n${colors.red}⚠️  ${point === 'ERROR' ? 'Action Error' : 'Interrupted'}:${colors.reset}`);
      if (context.error) console.log(`   ${context.error}`);
      break;
  }

  // ---------------------------------------------------------------------------
  // Input Loop
  // ---------------------------------------------------------------------------
  
  while (true) {
    console.log('\n' + colors.gray + '─'.repeat(60) + colors.reset);
    console.log('Available responses:');
    console.log(`  ${colors.bright}[a]pprove${colors.reset}    - Continue as planned`);
    console.log(`  ${colors.bright}[r]eject${colors.reset}     - Don't do this, try alternative`);
    console.log(`  ${colors.bright}[m]odify${colors.reset}     - Provide instruction to guide LLM`);
    console.log(`  ${colors.bright}[s]kip${colors.reset}       - Skip this step/cycle`);
    console.log(`  ${colors.bright}[fs] success${colors.reset} - Override to success`);
    console.log(`  ${colors.bright}[ff] fail${colors.reset}    - Override to failure`);
    console.log(`  ${colors.bright}[q]uit${colors.reset}       - Stop immediately`);
    console.log(colors.gray + '─'.repeat(60) + colors.reset);

    const input = await askQuestion(`\n👤 Your response ${colors.dim}[a]${colors.reset}: `);
    const normalized = input.trim().toLowerCase();

    // Default to 'approve' on empty input
    if (normalized === '') {
      console.log(`${colors.green}✓ Approved${colors.reset}`);
      return { type: 'approve' };
    }

    switch (normalized) {
      case 'a':
      case 'approve':
        console.log(`${colors.green}✓ Approved${colors.reset}`);
        return { type: 'approve' };

      case 'r':
      case 'reject': {
        const reason = await askQuestion('   Reason (optional): ');
        console.log(`${colors.red}✗ Rejected${colors.reset}`);
        return { type: 'reject', reason: reason || undefined };
      }

      case 'm':
      case 'modify': {
        const instruction = await askQuestion('   Your instruction: ');
        if (!instruction.trim()) {
          console.log(`${colors.red}❌ Instruction required for modify${colors.reset}`);
          continue;
        }
        console.log(`${colors.cyan}✎ Modifying with: "${instruction}"${colors.reset}`);
        return { type: 'modify', instruction };
      }

      case 's':
      case 'skip':
        console.log(`${colors.yellow}⏭ Skipping${colors.reset}`);
        return { type: 'skip' };

      case 'fs':
      case 'force_success': {
        const message = await askQuestion('   Success message: ');
        return {
          type: 'force_success',
          message: message || 'Forced success by user',
        };
      }

      case 'ff':
      case 'force_fail': {
        const message = await askQuestion('   Failure message: ');
        return {
          type: 'force_fail',
          message: message || 'Forced failure by user',
        };
      }

      case 'q':
      case 'quit':
        console.log(`${colors.red}🛑 Quitting${colors.reset}`);
        return { type: 'quit' };

      default:
        console.log(`${colors.red}? Unknown response "${normalized}". Please try again.${colors.reset}`);
        // Loop continues
    }
  }
}

/**
 * Process the raw intervention response into a control flow decision.
 * Handles common logic (skip, quit, etc.) centrally.
 */
export function processInterventionControl(
  response: InterventionResponse
): InterventionControl {
  switch (response.type) {
    case 'approve':
      return { action: 'continue' };

    case 'reject':
      return { action: 'continue' }; // Default for complex types handled by caller

    case 'modify':
      return { action: 'modify', instruction: response.instruction };

    case 'skip':
      return { action: 'skip' };

    case 'force_success':
      return { action: 'succeed', message: response.message };

    case 'force_fail':
      return { action: 'terminate', reason: response.message || 'Forced failure' };

    case 'quit':
      return { action: 'terminate', reason: 'User quit' };
      
    default:
      return { action: 'continue' };
  }
}

// -----------------------------------------------------------------------------
// INTERACTIVE MODE
// -----------------------------------------------------------------------------

/**
 * Prompt user for goal when neither preset nor goal is provided.
 */
export async function promptForGoal(): Promise<Goal> {
  console.log('\n' + '═'.repeat(60));
  console.log('🎯 INTERACTIVE MODE - No goal provided');
  console.log('═'.repeat(60));

  const name = await askQuestion('\n📝 Goal name (short): ');
  const description = await askQuestion('📋 What do you want to accomplish? ');
  const successCriteria = await askQuestion(
    "✅ How will you know it's done? (optional): ",
  );

  return {
    name: name || 'Custom Goal',
    description,
    successCriteria: successCriteria || undefined,
  };
}

/**
 * Prompt user for start URL if not provided.
 */
export async function promptForUrl(defaultUrl?: string): Promise<string> {
  console.log('\nWhere would you like to start?');
  console.log('1. Enter a specific URL');
  console.log('2. Search on Google');
  
  const choice = await askQuestion('\nChoice [1]: ');
  
  if (choice === '2' || choice.toLowerCase().includes('search') || choice.toLowerCase().includes('google')) {
    return 'https://www.google.com';
  }

  const prompt = defaultUrl
    ? `🌐 Start URL [${defaultUrl}]: `
    : '🌐 Start URL: ';

  const answer = await askQuestion(prompt);
  return answer || defaultUrl || 'https://www.google.com';
}

/**
 * Prompt user to log in when using a new browser profile.
 * Browser opens, user logs in manually, then presses Enter to continue.
 */
export async function promptForLogin(): Promise<void> {
  console.log('\n' + '═'.repeat(60));
  console.log('🔐 NEW BROWSER PROFILE - Login Required');
  console.log('═'.repeat(60));
  console.log('The browser is open. Please log in to any sites you need.');
  console.log('Your logins will be saved for future runs.\n');

  await askQuestion('Press Enter when you\'re done logging in...');
  console.log('✅ Profile saved! Future runs will be logged in.\n');
}

/**
 * Prompt user to save the learned path as a preset.
 * Part of the self-healing feature.
 */
export async function promptForPresetSave(
  existingPreset?: Preset,
  learnedStepsCount: number = 0
): Promise<{ type: 'update' | 'save_new' | 'discard'; name?: string }> {
  console.log('\n' + '✨'.repeat(30));
  console.log('🧠 SELF-HEALING: Learned a successful path!');
  console.log('✨'.repeat(30));
  console.log(`The agent found a path with ${learnedStepsCount} steps in this session.`);
  
  if (existingPreset) {
    console.log(`Current preset: "${existingPreset.name}"`);
  }
  
  console.log('\nWhat would you like to do?');
  console.log('1. [update] Update the existing preset with this path');
  console.log('2. [save_new] Save as a new preset file');
  console.log('3. [discard] Don\'t save (discard learned path)');
  
  const choice = await askQuestion('\nChoice (1/2/3): ');
  
  if (choice === '1' || choice.toLowerCase() === 'update') {
    return { type: 'update' };
  }
  
  if (choice === '2' || choice.toLowerCase() === 'save_new') {
    const name = await askQuestion('Preset name: ');
    return { type: 'save_new', name: name || 'New Learned Preset' };
  }
  
  return { type: 'discard' };
}

/**
 * Prompt user when initial URL navigation fails.
 */
export async function promptForUrlError(
  errorMsg: string,
): Promise<{ type: 'retry' | 'new_url' | 'search' | 'quit'; url?: string }> {
  console.log('\n' + '⚠️'.repeat(30));
  console.log('FAILED TO LOAD URL');
  console.log('⚠️'.repeat(30));
  console.log(`Error: ${errorMsg}\n`);
  
  console.log('What would you like to do?');
  console.log('1. [retry] Try the same URL again');
  console.log('2. [new] Enter a new URL');
  console.log('3. [search] Search on Google instead');
  console.log('4. [quit] Exit');

  const choice = await askQuestion('\nChoice [2]: ');
  const normalized = choice.trim().toLowerCase();

  if (normalized === '1' || normalized === 'retry') {
    return { type: 'retry' };
  }
  
  if (normalized === '3' || normalized === 'search') {
    return { type: 'search', url: 'https://www.google.com' };
  }
  
  if (normalized === '4' || normalized === 'quit') {
    return { type: 'quit' };
  }

  // Default to new URL (Option 2)
  const newUrl = await promptForUrl();
  return { type: 'new_url', url: newUrl };
}

/**
 * Prompt user to select a preset or enter a new goal at session start.
 * @returns Selected preset and its directory, or null to enter a new goal interactively
 */
export async function promptForPresetSelection(): Promise<{ preset: Preset; presetDir: string } | null> {
  const presets = listPresets();

  console.log('\n' + '═'.repeat(60));
  console.log('🚀 MOTE - Browser Automation Agent');
  console.log('═'.repeat(60));

  if (presets.length === 0) {
    console.log('\nNo saved presets found.');
    console.log('You can save presets after successful runs.\n');
    return null;
  }

  console.log('\n📋 Available Presets:');
  console.log('─'.repeat(40));

  presets.forEach((preset, index) => {
    const execMode = preset.hasSessionPlan ? '⚡ Execute' : '🔍 Explore';
    console.log(`  ${index + 1}. ${preset.name}`);
    console.log(`     ${preset.description}`);
    console.log(`     Mode: ${execMode}`);
  });

  console.log('─'.repeat(40));
  console.log(`  0. Enter a new goal (no preset)`);
  console.log('');

  const choice = await askQuestion(`Select preset [0-${presets.length}]: `);
  const normalized = choice.trim();

  // Default or explicit 0 = new goal
  if (normalized === '' || normalized === '0') {
    return null;
  }

  const index = parseInt(normalized, 10);
  if (isNaN(index) || index < 1 || index > presets.length) {
    console.log('Invalid selection, starting with new goal.');
    return null;
  }

  const selected = presets[index - 1];
  const preset = loadPresetFromPath(selected.presetDir);

  if (!preset) {
    console.log(`Failed to load preset: ${selected.name}`);
    return null;
  }

  console.log(`\n✅ Selected: ${preset.name}`);
  return { preset, presetDir: selected.presetDir };
}
