// =============================================================================
// LLM GENERATOR
// =============================================================================
// Generate step prompts, verification scripts, and polish presets using LLM.

import type OpenAI from 'openai';
import type { RecordedAction } from './types.js';
import type { Preset, SessionPlan } from '../types/index.js';

// -----------------------------------------------------------------------------
// STEP PROMPT GENERATION
// -----------------------------------------------------------------------------

/**
 * Generate a step-specific prompt using LLM.
 */
export async function generateStepPrompt(
  client: OpenAI,
  description: string,
  action: RecordedAction,
): Promise<string> {
  const prompt = `Generate a step-specific prompt for a web automation agent.

Step description: ${description}
Action type: ${action.type}
Target element selector: ${action.selector}
Element tag: ${action.elementInfo.tag}
Element text: ${action.elementInfo.text || 'N/A'}
Element attributes: ${JSON.stringify(action.elementInfo.attributes)}
${action.value ? `Value: ${action.value}` : ''}

Generate a prompt in this exact format (keep it concise):

You are specialized for this step.

**Current Step Goal:** {{instruction}}

**Step-Specific Rules:**
- [2-3 specific rules for this type of action]

**Context:**
- {{context.KEY}} (mention any relevant context variables)

**Success:** [What indicates the step completed successfully]
**Failure:** [When to report failure]

Only output the prompt content, no explanations.`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content || getDefaultStepPrompt(description, action);
  } catch (error) {
    console.warn(`LLM call failed, using default prompt: ${error}`);
    return getDefaultStepPrompt(description, action);
  }
}

/**
 * Default step prompt when LLM fails.
 */
function getDefaultStepPrompt(description: string, action: RecordedAction): string {
  return `You are specialized for this step.

**Current Step Goal:** {{instruction}}

**Step-Specific Rules:**
- Target the element: ${action.selector}
- Action type: ${action.type}
${action.value ? `- Use value: ${action.value}` : ''}

**Context:**
- {{context.KEY}}

**Success:** The ${action.type} action completes successfully on the target element.
**Failure:** Element not found or action cannot be performed.`;
}

// -----------------------------------------------------------------------------
// VERIFICATION SCRIPT GENERATION
// -----------------------------------------------------------------------------

/**
 * Generate a verification script using LLM.
 */
export async function generateVerificationScript(
  client: OpenAI,
  description: string,
): Promise<string> {
  const prompt = `Generate a JavaScript verification script for browser automation.
The script runs in browser context and must return a boolean.

Verification goal: ${description}

Requirements:
- Must be a single arrow function: () => { ... return true/false; }
- Use document.querySelector or document.querySelectorAll
- Keep it simple and robust
- Return true if verification passes, false if it fails

Examples:
- Check element exists: () => document.querySelector('.success') !== null
- Check text content: () => document.body.innerText.includes('Complete')
- Check URL: () => window.location.href.includes('/success')

Only output the script, no explanations or markdown.`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    });

    const script = response.choices[0]?.message?.content?.trim() || '';

    // Validate it looks like a function
    if (script.startsWith('()') || script.startsWith('function')) {
      return script;
    }

    return getDefaultVerificationScript(description);
  } catch (error) {
    console.warn(`LLM call failed, using default script: ${error}`);
    return getDefaultVerificationScript(description);
  }
}

/**
 * Default verification script when LLM fails.
 */
function getDefaultVerificationScript(description: string): string {
  // Try to extract keywords for basic verification
  const lowerDesc = description.toLowerCase();

  if (lowerDesc.includes('success') || lowerDesc.includes('complete')) {
    return `() => document.body.innerText.toLowerCase().includes('success') || document.body.innerText.toLowerCase().includes('complete')`;
  }

  if (lowerDesc.includes('error') || lowerDesc.includes('fail')) {
    return `() => !document.body.innerText.toLowerCase().includes('error')`;
  }

  // Generic - just check page loaded
  return `() => document.readyState === 'complete'`;
}

// -----------------------------------------------------------------------------
// LOOP CONDITION GENERATION
// -----------------------------------------------------------------------------

/**
 * Generate a loop condition script using LLM.
 */
export async function generateLoopCondition(
  client: OpenAI,
  description: string,
): Promise<string> {
  const prompt = `Generate a JavaScript condition for a web automation loop.
The script runs in browser context and must return a boolean.
Return true to continue the loop, false to exit.

Condition: ${description}

Requirements:
- Must be a single arrow function: () => { ... return true/false; }
- Use document.querySelector or document.querySelectorAll
- Return true if loop should continue
- Return false if loop should stop

Examples:
- While items exist: () => document.querySelectorAll('.item').length > 0
- Until no more pages: () => document.querySelector('.next-page') !== null
- While not at end: () => !document.body.innerText.includes('No more results')

Only output the script, no explanations or markdown.`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    });

    const script = response.choices[0]?.message?.content?.trim() || '';

    if (script.startsWith('()') || script.startsWith('function')) {
      return script;
    }

    return '() => true'; // Default: always continue (rely on iteration count)
  } catch (error) {
    console.warn(`LLM call failed: ${error}`);
    return '() => true';
  }
}

// -----------------------------------------------------------------------------
// PRESET POLISH
// -----------------------------------------------------------------------------

/**
 * Polish a preset using LLM to improve descriptions and instructions.
 */
export async function polishPreset(
  client: OpenAI,
  preset: Preset,
  sessionPlan: SessionPlan,
): Promise<{ polishedPreset: Preset; polishedPlan: SessionPlan }> {
  const prompt = `Review and improve this web automation preset. Make descriptions clearer and more professional.

Current preset:
${JSON.stringify(preset, null, 2)}

Current session plan:
${JSON.stringify(sessionPlan, null, 2)}

Improve:
1. Make the preset description more professional and clear
2. Improve the goal summary to be more actionable
3. Improve cycle description to be clearer
4. Make step descriptions more descriptive (keep them concise)

Return a JSON object with two keys:
- "preset": the improved preset object
- "sessionPlan": the improved session plan object

Only output valid JSON, no explanations.`;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 2000,
    });

    const content = response.choices[0]?.message?.content || '';

    // Try to parse JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        polishedPreset: { ...preset, ...parsed.preset },
        polishedPlan: { ...sessionPlan, ...parsed.sessionPlan },
      };
    }

    // Return original if parsing fails
    return { polishedPreset: preset, polishedPlan: sessionPlan };
  } catch (error) {
    console.warn(`Polish failed: ${error}`);
    return { polishedPreset: preset, polishedPlan: sessionPlan };
  }
}
