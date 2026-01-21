# Strategy-Centric Agent Architecture: Implementation Ideas

This is a significant architectural shift. Here's how to approach it:

---

## 1. Preset as First-Class Entity

**Current state:** Presets are optimization hints
**Target state:** Presets are the orchestration contract

### Key changes needed:

- **Preset becomes mandatory** - every task runs through a preset (even if it's a "discovery" preset)
- **Preset schema expands** to include all five concerns:
  - Reasoning scaffold (intent, constraints, assumptions)
  - Observation schema (what to extract, where, priority)
  - Action plan (sequence, preconditions, expected changes)
  - Validation rules (success/failure signals)
  - Fallback policy (when to bail, what to try next)

- **Preset registry** - named presets that can reference each other (e.g., `login-flow` → fallback to `generic-form-fill`)

---

## 2. Invert the Control Flow

**Current:** `prompt → reason → observe → act`
**Target:** `preset.execute(context)`

### The shift:

Instead of each module deciding what to do, the preset **tells** each module what to do:

```
preset.getReasoning()    → narrow, guided thinking
preset.getObservation()  → specific extraction plan
preset.getActions()      → scripted sequence
preset.getValidation()   → success criteria
preset.getFallback()     → recovery strategy
```

The modules become **executors**, not **deciders**.

---

## 3. Two Modes: Strategy vs Discovery

Make the distinction explicit:

| Mode | When | Behavior |
|------|------|----------|
| **Strategy** | Preset exists | Fast, narrow, deterministic |
| **Discovery** | No preset / fallback | Slow, broad, exploratory |

Discovery mode is literally a special preset called `discovery` that:
- Uses full HTML extraction
- Asks LLM to analyze structure
- Generates a new preset as output
- Is **expensive by design**

---

## 4. Validation as a Core Stage

Currently missing from the loop. Add it:

### Validation checks:
- **DOM signals** - element appeared/disappeared, URL changed
- **Content signals** - expected text present, error messages absent
- **State signals** - form submitted, modal closed

### Validation outcomes:
- `success` → continue to next action
- `partial` → log, maybe continue
- `failure` → trigger fallback

This makes the loop: `reason → observe → act → **validate** → (continue | fallback)`

---

## 5. Fallback as Explicit Policy

Not "retry 3 times and give up" but structured:

### Fallback ladder:
1. Retry same action (transient failure)
2. Try alternate selector from preset
3. Re-observe with broader scope
4. Drop to discovery mode
5. Record failure context for preset improvement
6. Surface to user

Each preset defines **where it enters this ladder** and **where it exits**.

---

## 6. Preset Learning Loop

The meta-goal: **discovery generates presets, presets get refined**

```
Discovery run
    ↓
Generate candidate preset
    ↓
Human review (optional)
    ↓
Strategy runs use preset
    ↓
Failures feed back to preset refinement
```

Store alongside presets:
- Success rate
- Common failure points
- Selector stability scores

---

## 7. Implementation Sequence

Suggested order:

1. **Expand preset schema** - add validation, fallback, reasoning fields
2. **Add validation stage** to the loop
3. **Create discovery preset** - formalize current "default" behavior
4. **Invert observe** - make it execute preset schema, not decide
5. **Invert reason** - make it apply preset scaffold, not freeform think
6. **Invert act** - make it execute preset sequence
7. **Build fallback ladder** - explicit, configurable
8. **Add preset refinement** - learning from failures

---

## 8. Key Design Questions to Resolve

- **Preset storage:** File-based? Database? In-memory registry?
- **Preset composition:** Can presets inherit/extend others?
- **Preset versioning:** How to handle site changes breaking presets?
- **Confidence thresholds:** When does strategy mode admit defeat?
- **Human-in-loop:** Where can users intervene/override?

---

## Summary

The core insight: **default logic is recovery infrastructure, not the happy path.**

The happy path is preset-driven, narrow, fast, and auditable. Discovery mode is the expensive, slow, intelligent fallback—used to *generate* presets, not to *be* the agent.

This inverts the typical "smart agent" design into a "smart strategy, dumb executor" model. Much more reliable.
