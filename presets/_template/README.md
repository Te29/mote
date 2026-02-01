# Preset Template

Copy this folder and customize it for your use case.

## Folder Structure

```
_template/
├── preset.json          (required) Main preset configuration
├── session-plan.json    (optional) Execution blueprint
├── prompts/             (optional) Step-specific prompts
│   ├── navigate.md
│   └── fill-form.md
└── README.md
```

## preset.json (Required)

Main configuration file:

| Field | Description |
|-------|-------------|
| `name` | Unique preset identifier |
| `description` | Human-readable description |
| `goal` | Task definition: name, description, successCriteria, context |
| `startUrl` | Initial URL to navigate to |
| `sessionPlanRef` | Reference to session-plan.json |
| `systemPromptRef` | Reference to custom system prompt file (optional) |
| `headless`, `slowMo`, `stealth` | Browser settings |
| `maxSteps`, `engagementMode` | Agent control |
| `tokenMarkdown`, `tokenElements` | Prompt token limits |

## session-plan.json (Optional)

Pre-defined execution blueprint:

| Field | Description |
|-------|-------------|
| `goalSummary` | High-level description |
| `cycleDescription` | What one cycle accomplishes |
| `numberOfCycles` | How many times to repeat (default: 1, use -1 for unlimited) |
| `setupSteps` | One-time initialization steps |
| `cyclePlan` | Main workflow with steps and loops |
| `wrapupSteps` | One-time cleanup steps |
| `verification` | JavaScript assertions for success check |

### Step Structure

```json
{
  "stepId": "unique-id",
  "description": "Human-readable description",
  "instruction": "Detailed instruction for LLM",
  "targetElementSelector": "CSS selector hint (optional)",
  "promptRef": "./prompts/step-prompt.md"
}
```

### Loop Structure

```json
{
  "type": "loop",
  "loop": {
    "loopId": "unique-id",
    "iterations": 3,
    "steps": [/* array of steps */]
  }
}
```

## Step Prompts (prompts/)

Step-specific prompts loaded via `promptRef`. These are **appended to the agent's identity section**.

**Template variables:**
- `{{instruction}}` - The step's instruction field
- `{{step}}` - Full step object
- `{{context.KEY}}` - Values from goal.context
- `{{goal}}` - Full goal object

**Format:**
```
You are specialized for [this step type].

**Step-Specific Rules:**
- Rule 1
- Rule 2

**Success:** What indicates completion.
**Failure:** When to report failure.
```

## Engagement Modes

| Mode | Description |
|------|-------------|
| `autonomous` | No human intervention |
| `minimal` | Confirm only terminal decisions |
| `standard` | Confirm cycle starts and terminals |
| `supervised` | Confirm every action |
| `full` | Full human oversight |

## Quick Start

1. Copy folder: `cp -r _template my-preset`
2. Edit `preset.json` with your configuration
3. (Optional) Add `session-plan.json` for structured execution
4. (Optional) Add step prompts in `prompts/`
5. Run: `mote --preset my-preset`
