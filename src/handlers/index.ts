/**
 * State machine handlers for agent execution.
 * Each handler takes a specific state and returns the next state.
 *
 * 8-State Design:
 *   SETUP → CYCLE_START → OBSERVE → REASON → ACT → CYCLE_END → WRAPUP → TERMINATED
 */

export { handleSetup } from './setup.js';
export { handleWrapup } from './wrapup.js';
export { handleCycleStart, handleCycleEnd } from './cycle.js';
export { handleObserve } from './observe.js';
export { handleReason } from './reason.js';
export { handleAct } from './act.js';

// Utilities
export { extractPageContext } from '../utils/handler-helpers.js';
