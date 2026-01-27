import * as fs from 'fs';
import * as path from 'path';

// Create log directory structure: data/log/
const LOG_DIR = path.join(process.cwd(), 'data', 'log');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Create unique log file for this session
const sessionTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `trace-${sessionTimestamp}.log`);

// Track call depth for indentation
let callDepth = 0;
const indent = () => '│  '.repeat(callDepth);

// Initialize log file with session header
fs.writeFileSync(LOG_FILE, `${'─'.repeat(60)}\n  SESSION: ${new Date().toISOString()}\n${'─'.repeat(60)}\n`);

function logToFile(message: string) {
  try {
    fs.appendFileSync(LOG_FILE, message + '\n');
  } catch (e) {
    // Ignore logging errors to prevent crash
  }
}

/**
 * Log LLM prompts to the trace file without truncation.
 * This captures the full system and user prompts sent to the LLM.
 */
export function logPromptToFile(label: string, prompt: string): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  try {
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ─── ${label} ───\n`);
    fs.appendFileSync(LOG_FILE, prompt + '\n');
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ─── END ${label} ───\n`);
  } catch (e) {
    // Ignore logging errors to prevent crash
  }
}

// Configuration for smart serialization
const SERIALIZE_CONFIG = {
  maxDepth: 4,
  maxStringLength: 200,
  maxArrayItems: 10,
  maxObjectKeys: 20,
};

/**
 * Detect and summarize known SDK objects to avoid verbose logging.
 */
function summarizeKnownObject(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;

  // OpenAI client detection - has chat.completions and _options with apiKey
  if (obj.chat?.completions && obj._options?.baseURL) {
    return `[OpenAI Client: ${obj._options.baseURL}]`;
  }

  // Playwright Browser
  if (obj._type === 'Browser' && obj._guid) {
    return `[Browser: ${obj._guid}]`;
  }

  // Playwright BrowserContext
  if (obj._type === 'BrowserContext' && obj._guid) {
    return `[BrowserContext: ${obj._guid}]`;
  }

  // Playwright Page
  if (obj._type === 'Page' && obj._guid) {
    return `[Page: ${obj._guid}]`;
  }

  return null;
}

/**
 * Safely stringify any value with smart truncation and SDK object detection.
 */
function safeStringify(obj: any): string {
  const seen = new WeakSet();

  function serialize(value: any, depth: number): any {
    // Handle primitives
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (typeof value === 'function') return '[Function]';
    if (typeof value === 'symbol') return value.toString();

    // Truncate long strings
    if (typeof value === 'string') {
      if (value.length > SERIALIZE_CONFIG.maxStringLength) {
        return value.slice(0, SERIALIZE_CONFIG.maxStringLength) + `... (${value.length} chars)`;
      }
      return value;
    }

    // Pass through numbers and booleans
    if (typeof value !== 'object') return value;

    // Check for known SDK objects first
    const summary = summarizeKnownObject(value);
    if (summary) return summary;

    // Handle circular references
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    // Max depth check
    if (depth >= SERIALIZE_CONFIG.maxDepth) {
      if (Array.isArray(value)) return `[Array: ${value.length} items]`;
      return `[Object: ${Object.keys(value).length} keys]`;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      const items = value.slice(0, SERIALIZE_CONFIG.maxArrayItems).map(v => serialize(v, depth + 1));
      if (value.length > SERIALIZE_CONFIG.maxArrayItems) {
        items.push(`... +${value.length - SERIALIZE_CONFIG.maxArrayItems} more`);
      }
      return items;
    }

    // Handle objects
    const keys = Object.keys(value);
    const result: Record<string, any> = {};
    const keysToProcess = keys.slice(0, SERIALIZE_CONFIG.maxObjectKeys);

    for (const key of keysToProcess) {
      // Skip internal/private properties that add noise
      if (key.startsWith('_') && key !== '_type' && key !== '_guid' && key !== '_options') {
        continue;
      }
      result[key] = serialize(value[key], depth + 1);
    }

    if (keys.length > SERIALIZE_CONFIG.maxObjectKeys) {
      result['...'] = `+${keys.length - SERIALIZE_CONFIG.maxObjectKeys} more keys`;
    }

    return result;
  }

  try {
    return JSON.stringify(serialize(obj, 0), null, 2);
  } catch (e) {
    return `[Serialization Error: ${e}]`;
  }
}

/**
 * Log a variable/object to the trace file with a descriptive label.
 * Use this to capture important state snapshots (config, plan, etc.)
 */
export function logVariable(label: string, value: any): void {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  try {
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ═══ ${label} ═══\n`);
    fs.appendFileSync(LOG_FILE, safeStringify(value) + '\n');
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ═══ END ${label} ═══\n`);
  } catch (e) {
    // Ignore logging errors to prevent crash
  }
}

export function createTraceProxy<T extends object>(target: T, moduleName: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const originalValue = Reflect.get(obj, prop, receiver);

      // Only intercept functions
      if (typeof originalValue === 'function') {
        return function (this: any, ...args: any[]) {
          const timestamp = new Date().toISOString().split('T')[1].slice(0, -1); // Remove trailing 'Z'
          const funcName = `${moduleName}.${String(prop)}`;
          const startTime = performance.now();

          // Console Log (Brief)
          console.log(`[TRACE][${timestamp}] ${indent()}┌─ ${funcName}`);

          // File Log (Detailed)
          logToFile(`[${timestamp}] ${indent()}┌─ ${funcName}`);
          if (args.length > 0) {
            logToFile(`[${timestamp}] ${indent()}│  args: ${safeStringify(args)}`);
          }

          callDepth++;

          // Execute original
          const result = originalValue.apply(this, args);

          // Helper to log return
          const logReturn = (val: any, isAsync: boolean) => {
            callDepth--;
            const duration = (performance.now() - startTime).toFixed(1);
            const asyncLabel = isAsync ? ' (async)' : '';

            console.log(`[TRACE][${timestamp}] ${indent()}└─ ${funcName}${asyncLabel} [${duration}ms]`);
            logToFile(`[${timestamp}] ${indent()}└─ ${funcName}${asyncLabel} [${duration}ms]`);
            if (val !== undefined) {
              logToFile(`[${timestamp}] ${indent()}   result: ${safeStringify(val)}`);
            }
          };

          // Log result (async vs sync)
          if (result instanceof Promise) {
            return result
              .then((val) => {
                logReturn(val, true);
                return val;
              })
              .catch((err) => {
                callDepth--;
                const duration = (performance.now() - startTime).toFixed(1);
                console.log(`[TRACE][${timestamp}] ${indent()}└─ ${funcName} ERROR [${duration}ms]`);
                logToFile(`[${timestamp}] ${indent()}└─ ${funcName} ERROR [${duration}ms]`);
                logToFile(`[${timestamp}] ${indent()}   error: ${err.stack || err.message}`);
                throw err;
              });
          } else {
            logReturn(result, false);
            return result;
          }
        };
      }

      return originalValue;
    }
  });
}


