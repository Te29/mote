// =============================================================================
// LLM GENERATOR
// =============================================================================
// Generate step prompts, verification scripts, and polish presets using LLM.

import type OpenAI from 'openai';
import type { RecordedAction } from './types.js';
import type { Preset, SessionPlan, ElementInfo } from '../types/index.js';
import { getDefaultModel } from '../reason.js';

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
      model: getDefaultModel(),
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
// LLM SCRIPT HELPERS
// -----------------------------------------------------------------------------

/**
 * Clean LLM-generated script by removing markdown code blocks and extra whitespace.
 */
function cleanLLMScript(script: string): string {
  let cleaned = script.trim();

  // Remove markdown code blocks (```javascript ... ``` or ``` ... ```)
  const codeBlockMatch = cleaned.match(/^```(?:javascript|js)?\s*\n?([\s\S]*?)\n?```$/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Remove single backticks wrapping the whole thing
  if (cleaned.startsWith('`') && cleaned.endsWith('`') && !cleaned.includes('\n')) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  return cleaned;
}

/**
 * Validate that a string looks like a valid JavaScript function.
 */
function isValidScriptFunction(script: string): boolean {
  // Check for arrow function or function declaration
  if (!script.startsWith('()') && !script.startsWith('function')) {
    return false;
  }

  // Basic bracket balance check
  const openParens = (script.match(/\(/g) || []).length;
  const closeParens = (script.match(/\)/g) || []).length;
  const openBraces = (script.match(/\{/g) || []).length;
  const closeBraces = (script.match(/\}/g) || []).length;

  if (openParens !== closeParens || openBraces !== closeBraces) {
    return false;
  }

  // Must have at least a return or => for arrow functions
  if (script.startsWith('()')) {
    // Arrow function: must have =>
    if (!script.includes('=>')) {
      return false;
    }
  }

  return true;
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
      model: getDefaultModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    });

    const rawScript = response.choices[0]?.message?.content?.trim() || '';
    const script = cleanLLMScript(rawScript);

    // Validate it looks like a function
    if (isValidScriptFunction(script)) {
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
      model: getDefaultModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    });

    const rawScript = response.choices[0]?.message?.content?.trim() || '';
    const script = cleanLLMScript(rawScript);

    if (isValidScriptFunction(script)) {
      return script;
    }

    return '() => true'; // Default: always continue (rely on iteration count)
  } catch (error) {
    console.warn(`LLM call failed: ${error}`);
    return '() => true';
  }
}

// -----------------------------------------------------------------------------
// WAIT FOR READY SCRIPT GENERATION
// -----------------------------------------------------------------------------

/**
 * Format page elements for LLM analysis.
 * Focuses on elements that might indicate loading state.
 */
function formatElementsForWaitAnalysis(elements: ElementInfo[]): string {
  if (!elements || elements.length === 0) {
    return 'No elements observed on page.';
  }

  // Filter and format elements - focus on potential loading indicators
  const relevantElements = elements
    .filter(el => {
      const selector = el.selector.toLowerCase();
      const text = el.text.toLowerCase();
      const tag = el.tag.toLowerCase();

      // Include elements that might be loading indicators
      const loadingKeywords = ['load', 'spinner', 'skeleton', 'progress', 'loading', 'wait', 'pending'];
      const hasLoadingHint = loadingKeywords.some(kw =>
        selector.includes(kw) || text.includes(kw) ||
        Object.values(el.attributes).some(v => v.toLowerCase().includes(kw))
      );

      // Include main content elements that indicate page is ready
      const contentKeywords = ['content', 'main', 'container', 'wrapper', 'body', 'article', 'section'];
      const isContentElement = contentKeywords.some(kw => selector.includes(kw));

      // Include buttons, forms, and interactive elements (indicate page is interactive)
      const isInteractive = ['button', 'input', 'select', 'a', 'form'].includes(tag);

      return hasLoadingHint || isContentElement || isInteractive;
    })
    .slice(0, 30); // Limit to avoid token overflow

  if (relevantElements.length === 0) {
    // If no relevant elements found, include first 20 elements as context
    return elements.slice(0, 20).map(el =>
      `- [${el.tag}] selector="${el.selector}" text="${el.text.slice(0, 50)}"`
    ).join('\n');
  }

  return relevantElements.map(el => {
    const attrs = Object.entries(el.attributes)
      .filter(([k]) => ['class', 'id', 'aria-label', 'role', 'data-testid'].includes(k))
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return `- [${el.tag}] selector="${el.selector}" text="${el.text.slice(0, 50)}" ${attrs}`.trim();
  }).join('\n');
}

/**
 * Generate a waitForReady script using LLM.
 * Analyzes page elements to create meaningful wait conditions.
 *
 * @param client - OpenAI client
 * @param description - Human description of what to wait for
 * @param pageElements - Optional array of page elements for LLM analysis
 */
export async function generateWaitForReadyScript(
  client: OpenAI,
  description: string,
  pageElements?: ElementInfo[],
): Promise<string> {
  const elementsContext = pageElements
    ? formatElementsForWaitAnalysis(pageElements)
    : 'No page elements provided.';

  const prompt = `Generate a JavaScript async script for web automation that waits until the page is ready.
The script runs in browser context and should resolve when the page/element is ready.

Wait condition: ${description}

Current page elements (analyze these to find real selectors):
${elementsContext}

Requirements:
- Must be an async expression that resolves when ready (using Promise or MutationObserver)
- Use REAL selectors from the page elements above - do NOT invent generic selectors like '.spinner'
- If waiting for loading to finish, look for actual loading indicators in the elements list
- If waiting for content to appear, use a selector that exists in the elements list
- Should complete/resolve when the condition is met
- No return value needed - completion signals readiness

Patterns:
- Wait for element to appear: new Promise(resolve => { if (document.querySelector('SELECTOR')) return resolve(); const observer = new MutationObserver(() => { if (document.querySelector('SELECTOR')) { observer.disconnect(); resolve(); } }); observer.observe(document.body, { childList: true, subtree: true }); })
- Wait for element to disappear: new Promise(resolve => { const check = () => !document.querySelector('SELECTOR') ? resolve() : setTimeout(check, 100); check(); })
- Wait for text content (native JS): new Promise(resolve => { const check = () => { const el = Array.from(document.querySelectorAll('a,button')).find(e => e.textContent.includes('TEXT')); el ? resolve() : setTimeout(check, 100); }; check(); })
- Wait by href pattern: new Promise(resolve => { const check = () => document.querySelector('a[href*="/pattern/"]') ? resolve() : setTimeout(check, 100); check(); })

Important:
- Prefer GENERIC selectors over specific ones (e.g., use 'a[href*="/assessment/"]' instead of '[aria-label="Take test Specific Course Name"]')
- Use href patterns (a[href*="..."]) when the URL structure is predictable
- Use text matching with Array.find() for button/link text (not :has-text which is Playwright-only)
- Avoid selectors with specific content names that would change between runs

Only output the script, no explanations or markdown.`;

  try {
    const response = await client.chat.completions.create({
      model: getDefaultModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 400,
    });

    const rawScript = response.choices[0]?.message?.content?.trim() || '';
    const script = cleanLLMScript(rawScript);

    // Basic validation - should start with 'new Promise' or contain 'Promise'
    if (script.includes('Promise') || script.includes('await')) {
      return script;
    }

    return getDefaultWaitForReadyScript(description, pageElements);
  } catch (error) {
    console.warn(`LLM call failed, using default script: ${error}`);
    return getDefaultWaitForReadyScript(description, pageElements);
  }
}

/**
 * Default waitForReady script when LLM fails.
 * Tries to find loading indicators from page elements.
 */
function getDefaultWaitForReadyScript(description: string, pageElements?: ElementInfo[]): string {
  // Try to find actual loading indicators from page elements
  if (pageElements && pageElements.length > 0) {
    const loadingKeywords = ['spinner', 'loading', 'skeleton', 'progress', 'loader'];
    const loadingElement = pageElements.find(el => {
      const selector = el.selector.toLowerCase();
      return loadingKeywords.some(kw => selector.includes(kw));
    });

    if (loadingElement) {
      // Wait for loading indicator to disappear
      return `new Promise(resolve => { const check = () => !document.querySelector('${loadingElement.selector}') ? resolve() : setTimeout(check, 100); check(); })`;
    }

    // If no loading indicator, wait for first interactive element to appear
    const interactiveElement = pageElements.find(el =>
      ['button', 'input', 'a'].includes(el.tag.toLowerCase())
    );
    if (interactiveElement) {
      return `new Promise(resolve => { if (document.querySelector('${interactiveElement.selector}')) return resolve(); const observer = new MutationObserver(() => { if (document.querySelector('${interactiveElement.selector}')) { observer.disconnect(); resolve(); } }); observer.observe(document.body, { childList: true, subtree: true }); })`;
    }
  }

  // Fallback: try to extract a selector hint from description
  const lowerDesc = description.toLowerCase();
  const selectorMatch = lowerDesc.match(/['"]([.#][^'"]+)['"]/);
  if (selectorMatch) {
    const selector = selectorMatch[1];
    return `new Promise(resolve => { if (document.querySelector('${selector}')) return resolve(); const observer = new MutationObserver(() => { if (document.querySelector('${selector}')) { observer.disconnect(); resolve(); } }); observer.observe(document.body, { childList: true, subtree: true }); })`;
  }

  // Generic wait for page to be interactive
  return `new Promise(resolve => { if (document.readyState === 'complete') return resolve(); window.addEventListener('load', resolve); })`;
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
      model: getDefaultModel(),
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
