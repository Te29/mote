// =============================================================================
// RECORDER PROMPTS
// =============================================================================
// CLI prompts for the recording module.
// Mirrors patterns from src/interaction.ts.

import * as readline from 'readline';
import type {
  RecordedAction,
  ActionDecision,
  PhaseControlAction,
  RecordingSection,
  LoopConfig,
  RecordingInitResult,
} from './types.js';
import type { Goal } from '../types/index.js';

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

/**
 * Close the readline interface.
 */
export function closeRecorderReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/**
 * Ask a question and return the answer.
 * Returns '__SIGINT__' if Ctrl+C is pressed during the question.
 */
function askQuestion(prompt: string): Promise<string> {
  const rli = getReadlineInterface();
  return new Promise((resolve) => {
    let answered = false;

    const sigintHandler = () => {
      if (!answered) {
        answered = true;
        // Clear the current line and move to next
        if (process.stdout.isTTY) {
          process.stdout.write('\n');
        }
        resolve('__SIGINT__');
      }
    };

    // Listen for SIGINT during this question
    process.once('SIGINT', sigintHandler);

    rli.question(prompt, (answer) => {
      if (!answered) {
        answered = true;
        process.removeListener('SIGINT', sigintHandler);
        resolve(answer);
      }
    });
  });
}

// -----------------------------------------------------------------------------
// ANSI COLORS
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
// INIT PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user for initial recording configuration.
 */
export async function promptRecordingInit(): Promise<RecordingInitResult> {
  console.log('\n' + '═'.repeat(60));
  console.log(`${colors.cyan}📹 PRESET RECORDING MODE${colors.reset}`);
  console.log('═'.repeat(60));
  console.log('Create a new preset by recording your actions in the browser.\n');

  const name = await askQuestion(`${colors.bright}📝 Preset name:${colors.reset} `);
  const description = await askQuestion(`${colors.bright}📋 Goal description:${colors.reset} `);
  const startUrl = await askQuestion(`${colors.bright}🌐 Start URL:${colors.reset} `);
  const contextStr = await askQuestion(
    `${colors.bright}📦 Context variables${colors.reset} ${colors.dim}(JSON or empty):${colors.reset} `,
  );

  let context: Record<string, string> = {};
  if (contextStr.trim()) {
    try {
      context = JSON.parse(contextStr);
    } catch {
      console.log(`${colors.yellow}   (Invalid JSON, using empty context)${colors.reset}`);
    }
  }

  const goal: Goal = {
    name: name || 'New Preset',
    description: description || 'Complete the task',
    context,
  };

  return {
    name: name || 'new-preset',
    goal,
    startUrl: startUrl || 'https://www.google.com',
  };
}

// -----------------------------------------------------------------------------
// ACTION PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user after recording an action.
 */
export async function promptAfterAction(
  action: RecordedAction,
): Promise<ActionDecision> {
  console.log('\n' + colors.gray + '─'.repeat(50) + colors.reset);
  console.log(`${colors.green}✓ Recorded:${colors.reset} ${colors.bright}${action.type.toUpperCase()}${colors.reset}`);
  console.log(`  Selector: ${colors.cyan}${action.selector}${colors.reset}`);
  if (action.value) {
    console.log(`  Value: ${colors.yellow}"${action.value}"${colors.reset}`);
  }
  if (action.elementInfo.text) {
    console.log(`  Text: "${action.elementInfo.text.slice(0, 50)}${action.elementInfo.text.length > 50 ? '...' : ''}"`);
  }
  console.log(colors.gray + '─'.repeat(50) + colors.reset);

  // For navigation actions, offer option to skip or mark as dynamic
  if (action.type === 'navigate') {
    const navChoice = await askQuestion(
      `\n${colors.yellow}Navigation detected!${colors.reset}\n` +
      `  ${colors.bright}[K]${colors.reset}eep URL / ${colors.bright}[D]${colors.reset}iscard / ${colors.bright}[Y]${colors.reset}namic URL (don't record) [K]: `,
    );

    if (navChoice === '__SIGINT__') {
      console.log(`${colors.yellow}⏭ Interrupted - showing menu${colors.reset}`);
      return { action: 'discard' };
    }

    const normalized = navChoice.trim().toLowerCase() || 'k';
    if (normalized === 'd' || normalized === 'discard') {
      console.log(`${colors.yellow}⏭ Navigation discarded${colors.reset}`);
      return { action: 'discard' };
    }
    if (normalized === 'y' || normalized === 'dynamic') {
      console.log(`${colors.cyan}✓ Marked as dynamic navigation (not recorded)${colors.reset}`);
      return { action: 'discard' };
    }
    // Fall through to keep the navigation
  }

  const choice = await askQuestion(
    `\n${colors.bright}[K]eep${colors.reset} / ${colors.bright}[D]iscard${colors.reset} / ${colors.bright}[E]dit selector${colors.reset} / ${colors.bright}[M]enu (Ctrl+C)${colors.reset} [K]: `,
  );

  // Handle SIGINT - treat as discard and trigger control menu
  if (choice === '__SIGINT__') {
    console.log(`${colors.yellow}⏭ Interrupted - showing menu${colors.reset}`);
    return { action: 'discard' };
  }

  const normalized = choice.trim().toLowerCase() || 'k';

  if (normalized === 'd' || normalized === 'discard') {
    console.log(`${colors.yellow}⏭ Discarded${colors.reset}`);
    return { action: 'discard' };
  }

  if (normalized === 'e' || normalized === 'edit') {
    const newSelector = await askQuestion(`  New selector: `);
    if (!newSelector.trim()) {
      console.log(`${colors.red}  Invalid selector, keeping original${colors.reset}`);
      // Fall through to keep
    } else {
      return { action: 'edit', newSelector: newSelector.trim() };
    }
  }

  // Keep - get additional info
  const description = await askQuestion(`  ${colors.bright}Step description:${colors.reset} `);
  if (description === '__SIGINT__') {
    console.log(`${colors.yellow}⏭ Interrupted - discarding action${colors.reset}`);
    return { action: 'discard' };
  }

  const genPromptStr = await askQuestion(
    `  Generate step prompt with LLM? ${colors.dim}[y/N]:${colors.reset} `,
  );
  if (genPromptStr === '__SIGINT__') {
    console.log(`${colors.yellow}⏭ Interrupted - discarding action${colors.reset}`);
    return { action: 'discard' };
  }

  const genVerifyStr = await askQuestion(
    `  Generate step verification? ${colors.dim}[y/N]:${colors.reset} `,
  );
  if (genVerifyStr === '__SIGINT__') {
    console.log(`${colors.yellow}⏭ Interrupted - discarding action${colors.reset}`);
    return { action: 'discard' };
  }

  console.log(`${colors.green}✓ Step saved${colors.reset}`);

  return {
    action: 'keep',
    description: description || `${action.type} on ${action.elementInfo.tag}`,
    generatePrompt: genPromptStr.toLowerCase() === 'y',
    generateVerification: genVerifyStr.toLowerCase() === 'y',
  };
}

// -----------------------------------------------------------------------------
// PHASE CONTROL PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user for phase control action.
 */
export async function promptPhaseControl(
  section: RecordingSection,
  activeLoopId: string | null,
): Promise<PhaseControlAction> {
  console.log('\n' + colors.gray + '═'.repeat(50) + colors.reset);
  console.log(
    `${colors.cyan}📍 Current:${colors.reset} ${colors.bright}${section.toUpperCase()}${colors.reset}` +
      (activeLoopId ? ` ${colors.dim}(in loop: ${activeLoopId})${colors.reset}` : ''),
  );
  console.log(colors.gray + '─'.repeat(50) + colors.reset);
  console.log(`  ${colors.bright}[C]${colors.reset}ontinue recording`);
  console.log(`  ${colors.bright}[L]${colors.reset}oop - Start a loop`);
  if (activeLoopId) {
    console.log(`  ${colors.bright}[E]${colors.reset}nd loop`);
  }
  console.log(`  ${colors.bright}[V]${colors.reset}erification - Add verification script`);

  // Show what the next phase will be
  const nextPhase = section === 'setup' ? 'cycle' : section === 'cycle' ? 'wrapup' : 'finalize';
  console.log(`  ${colors.bright}[N]${colors.reset}ext phase → ${colors.cyan}${nextPhase}${colors.reset}`);

  console.log(`  ${colors.bright}[D]${colors.reset}one - Finish recording`);
  console.log(colors.gray + '─'.repeat(50) + colors.reset);

  const choice = await askQuestion(`\nChoice ${colors.dim}[C]:${colors.reset} `);
  const normalized = choice.trim().toLowerCase() || 'c';

  switch (normalized) {
    case 'l':
    case 'loop':
      return 'start-loop';
    case 'e':
    case 'end':
      return activeLoopId ? 'end-loop' : 'continue';
    case 'v':
    case 'verification':
      return 'verification';
    case 'n':
    case 'next':
      return 'next-section';
    case 'd':
    case 'done':
      return 'done';
    default:
      return 'continue';
  }
}

// -----------------------------------------------------------------------------
// LOOP PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user for loop configuration.
 */
export async function promptLoopConfig(): Promise<LoopConfig> {
  console.log('\n' + colors.gray + '─'.repeat(50) + colors.reset);
  console.log(`${colors.cyan}🔄 Loop Configuration${colors.reset}`);
  console.log(colors.gray + '─'.repeat(50) + colors.reset);

  const iterStr = await askQuestion(
    `  Number of iterations ${colors.dim}(or enter 'condition' for dynamic):${colors.reset} `,
  );

  const iterations = parseInt(iterStr, 10);
  if (!isNaN(iterations) && iterations > 0) {
    return { iterations };
  }

  // Dynamic condition
  const conditionDesc = await askQuestion(`  Describe loop condition: `);
  return { conditionDescription: conditionDesc || 'Repeat until done' };
}

// -----------------------------------------------------------------------------
// VERIFICATION PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user for verification description.
 */
export async function promptVerification(): Promise<string> {
  console.log('\n' + colors.gray + '─'.repeat(50) + colors.reset);
  console.log(`${colors.cyan}✅ Verification Script${colors.reset}`);
  console.log(colors.gray + '─'.repeat(50) + colors.reset);
  console.log(`  Describe what should be verified.`);
  console.log(`  ${colors.dim}Example: "Success message is displayed"${colors.reset}`);

  const description = await askQuestion(`\n  Verification: `);
  return description || 'Verify the action completed successfully';
}

// -----------------------------------------------------------------------------
// FINALIZATION PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user for finalization options.
 */
export async function promptFinalize(): Promise<{
  polish: boolean;
  dryRun: boolean;
}> {
  console.log('\n' + '═'.repeat(60));
  console.log(`${colors.green}✅ Recording Complete${colors.reset}`);
  console.log('═'.repeat(60));

  const polishStr = await askQuestion(
    `\nPolish preset with LLM? ${colors.dim}[y/N]:${colors.reset} `,
  );
  const dryRunStr = await askQuestion(
    `Dry run to test? ${colors.dim}[y/N]:${colors.reset} `,
  );

  return {
    polish: polishStr.toLowerCase() === 'y',
    dryRun: dryRunStr.toLowerCase() === 'y',
  };
}

// -----------------------------------------------------------------------------
// RECOVERY PROMPTS
// -----------------------------------------------------------------------------

/**
 * Prompt user to resume from checkpoint.
 */
export async function promptResumeCheckpoint(presetDir: string): Promise<boolean> {
  console.log('\n' + colors.yellow + '⚠️  Found incomplete recording session' + colors.reset);
  console.log(`   Directory: ${presetDir}`);

  const resumeStr = await askQuestion(`\nResume? ${colors.dim}[Y/n]:${colors.reset} `);
  return resumeStr.toLowerCase() !== 'n';
}
