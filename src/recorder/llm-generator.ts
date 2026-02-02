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
 * Format page elements for loop condition analysis.
 * Focuses on elements that might indicate loop continuation/termination.
 */
function formatElementsForLoopAnalysis(elements: ElementInfo[]): string {
  if (!elements || elements.length === 0) {
    return 'No elements observed on page.';
  }

  // Filter elements relevant to loop conditions
  const relevantElements = elements
    .filter(el => {
      const selector = el.selector.toLowerCase();
      const text = el.text.toLowerCase();
      const tag = el.tag.toLowerCase();

      // Include pagination/navigation elements
      const paginationKeywords = ['next', 'prev', 'page', 'pagination', 'more', 'continue', 'load'];
      const hasPaginationHint = paginationKeywords.some(kw =>
        selector.includes(kw) || text.includes(kw) ||
        Object.values(el.attributes).some(v => v.toLowerCase().includes(kw))
      );

      // Include list items and containers
      const listKeywords = ['item', 'list', 'row', 'card', 'result', 'entry'];
      const isListElement = listKeywords.some(kw => selector.includes(kw));

      // Include completion/end indicators
      const endKeywords = ['empty', 'done', 'complete', 'finish', 'end', 'no more', 'success'];
      const hasEndHint = endKeywords.some(kw =>
        selector.includes(kw) || text.includes(kw)
      );

      // Include interactive elements (buttons, links)
      const isInteractive = ['button', 'a', 'input'].includes(tag);

      return hasPaginationHint || isListElement || hasEndHint || isInteractive;
    })
    .slice(0, 30);

  if (relevantElements.length === 0) {
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
 * Generate a loop condition script using LLM.
 * Analyzes page elements to create meaningful continuation conditions.
 *
 * @param client - OpenAI client
 * @param description - Human description of the loop condition
 * @param pageElements - Optional array of page elements for LLM analysis
 */
export async function generateLoopCondition(
  client: OpenAI,
  description: string,
  pageElements?: ElementInfo[],
): Promise<string> {
  const elementsContext = pageElements
    ? formatElementsForLoopAnalysis(pageElements)
    : 'No page elements provided.';

  const prompt = `Generate a JavaScript condition for a web automation loop.
The script runs in browser context and must return a boolean.
Return true to CONTINUE the loop, false to EXIT.

Loop condition: ${description}

Page elements for reference:
${elementsContext}

CRITICAL RULES:
1. Output ONLY a single arrow function: () => { ... }
2. Return true if the loop should CONTINUE (more work to do)
3. Return false if the loop should EXIT (done/finished)
4. Use document.querySelector or document.querySelectorAll
5. Keep it SHORT - under 5 lines of logic

PATTERNS (copy exactly, just replace placeholders):

While element exists (continue while found):
() => document.querySelector('SELECTOR') !== null

Until element appears (exit when found):
() => document.querySelector('SELECTOR') === null

While items remain:
() => document.querySelectorAll('SELECTOR').length > 0

Until text appears (exit when text found):
() => !document.body.innerText.includes('TEXT')

While text exists (continue while text present):
() => document.body.innerText.includes('TEXT')

IMPORTANT:
- Use .toLowerCase().includes() for case-insensitive text matching
- Prefer generic selectors over brittle specific ones
- Do NOT use :has-text (Playwright-only, not native JS)

Output ONLY the arrow function. No markdown, no explanation.`;

  try {
    const response = await client.chat.completions.create({
      model: getDefaultModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 250,
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

  const prompt = `Generate a simple JavaScript Promise that waits for a condition.

Wait condition: ${description}

Page elements for reference:
${elementsContext}

CRITICAL RULES:
1. Output ONLY a single "new Promise(resolve => { ... })" expression
2. Do NOT create named functions, async IIFEs, or multiple Promises
3. Do NOT add conditions beyond what was explicitly requested
4. Keep it SHORT - under 5 lines of logic inside the Promise
5. Use the EXACT patterns below - just replace SELECTOR or TEXT

PATTERNS (copy exactly, just replace placeholders):

For waiting for element by selector:
new Promise(resolve => { const check = () => document.querySelector('SELECTOR') ? resolve() : setTimeout(check, 100); check(); })

For waiting for element to disappear:
new Promise(resolve => { const check = () => !document.querySelector('SELECTOR') ? resolve() : setTimeout(check, 100); check(); })

For waiting for text content in buttons/links:
new Promise(resolve => { const check = () => { const el = Array.from(document.querySelectorAll('button, a')).find(e => e.textContent?.toLowerCase().includes('TEXT')); el ? resolve() : setTimeout(check, 100); }; check(); })

For waiting by href pattern:
new Promise(resolve => { const check = () => document.querySelector('a[href*="/pattern/"]') ? resolve() : setTimeout(check, 100); check(); })

IMPORTANT:
- Use .toLowerCase().includes() for case-insensitive text matching
- Prefer generic selectors (a[href*="/path/"]) over specific aria-labels
- Do NOT use :has-text (Playwright-only, not native JS)
- Do NOT add timeouts, observers, or extra complexity unless absolutely necessary

Output ONLY the Promise expression. No markdown, no explanation, no wrapping.`;

  try {
    const response = await client.chat.completions.create({
      model: getDefaultModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 250,
    });

    const rawScript = response.choices[0]?.message?.content?.trim() || '';
    const script = cleanLLMScript(rawScript);

    // Strict validation - must be a simple inline Promise
    const isValidWaitScript = (s: string): boolean => {
      // Must start with 'new Promise'
      if (!s.startsWith('new Promise')) return false;
      // Reject async IIFEs and named functions (signs of over-complexity)
      if (s.includes('async ()') || s.includes('async function') || s.includes('function ')) return false;
      // Reject Promise.all (should be single condition)
      if (s.includes('Promise.all')) return false;
      // Reject multiple Promise constructions
      if ((s.match(/new Promise/g) || []).length > 1) return false;
      // Should be reasonably short (under 500 chars for simple wait)
      if (s.length > 500) return false;
      return true;
    };

    if (isValidWaitScript(script)) {
      return script;
    }

    console.warn('LLM generated overly complex wait script, using default');
    return getDefaultWaitForReadyScript(description, pageElements);
  } catch (error) {
    console.warn(`LLM call failed, using default script: ${error}`);
    return getDefaultWaitForReadyScript(description, pageElements);
  }
}

/**
 * Default waitForReady script when LLM fails.
 * Parses description to generate appropriate wait condition.
 */
function getDefaultWaitForReadyScript(description: string, pageElements?: ElementInfo[]): string {
  const lowerDesc = description.toLowerCase();

  // Pattern 1: Text-based matching (e.g., "button with text take test", "link containing submit")
  // Match patterns like: "button with text X", "button containing X", "text X appears"
  const textPatterns = [
    // "button with text take test", "at least one button with text X"
    /(?:button|link|element).*(?:with text|containing|says|labeled)\s+["']?(.+?)["']?$/i,
    // "text X appears", "content X shows"
    /(?:text|content)\s+["']?([^"']+)["']?\s+(?:appears|shows|visible)/i,
    // "'take test' button"
    /["']([^"']+)["']\s+(?:button|link|text)/i,
    // "button text X", "link text X"
    /(?:button|link)\s+text\s+["']?(.+?)["']?$/i,
  ];

  for (const pattern of textPatterns) {
    const match = description.match(pattern);
    if (match) {
      const searchText = match[1].trim().toLowerCase();
      return `new Promise(resolve => { const check = () => { const el = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(e => e.textContent?.toLowerCase().includes('${searchText}')); el ? resolve() : setTimeout(check, 100); }; check(); })`;
    }
  }

  // Pattern 2: Element disappears (e.g., "spinner disappears", "loading gone")
  if (lowerDesc.includes('disappear') || lowerDesc.includes('gone') || lowerDesc.includes('removed')) {
    const loadingKeywords = ['spinner', 'loading', 'skeleton', 'progress', 'loader'];
    const keyword = loadingKeywords.find(kw => lowerDesc.includes(kw));
    if (keyword) {
      // Try to find actual element from page
      const loadingElement = pageElements?.find(el => el.selector.toLowerCase().includes(keyword));
      const selector = loadingElement?.selector || `[class*="${keyword}"]`;
      return `new Promise(resolve => { const check = () => !document.querySelector('${selector}') ? resolve() : setTimeout(check, 100); check(); })`;
    }
  }

  // Pattern 3: Try to find loading indicators from page elements
  if (pageElements && pageElements.length > 0) {
    const loadingKeywords = ['spinner', 'loading', 'skeleton', 'progress', 'loader'];
    const loadingElement = pageElements.find(el => {
      const selector = el.selector.toLowerCase();
      return loadingKeywords.some(kw => selector.includes(kw));
    });

    if (loadingElement) {
      return `new Promise(resolve => { const check = () => !document.querySelector('${loadingElement.selector}') ? resolve() : setTimeout(check, 100); check(); })`;
    }
  }

  // Pattern 4: Explicit selector in description
  const selectorMatch = lowerDesc.match(/['"]([.#][^'"]+)['"]/);
  if (selectorMatch) {
    const selector = selectorMatch[1];
    return `new Promise(resolve => { const check = () => document.querySelector('${selector}') ? resolve() : setTimeout(check, 100); check(); })`;
  }

  // Pattern 5: Wait for interactive element from page elements
  if (pageElements && pageElements.length > 0) {
    const interactiveElement = pageElements.find(el =>
      ['button', 'input', 'a'].includes(el.tag.toLowerCase())
    );
    if (interactiveElement) {
      return `new Promise(resolve => { const check = () => document.querySelector('${interactiveElement.selector}') ? resolve() : setTimeout(check, 100); check(); })`;
    }
  }

  // Fallback: Generic wait for page load
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
