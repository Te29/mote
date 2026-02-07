<p align="center">
  <img src="public/header.png" alt="Mote" />
</p>

Mote is a lightweight browser automation agent framework powered by AI. It turns human workflows into reliable, repeatable automation pipelines through a **methodology-first agent design** — combining scripted steps with AI-assisted decisions across a clear `record → normalize → execute → validate` lifecycle. With varying levels of human oversight and LLMs orchestrated along predefined code paths, Mote is a practical starting point for experiencing what it means to **give AI a pair of hands**.

## Features

<table>
<tr>
<td width="50%">

### 🔄 Workflow & Automation

- Capture and reuse human workflows
- Execute browser automation with LLM assistance
- Learn and refine automation workflows over time
- Build and manage a preset library
- Optimize for repetitive tasks
- Choose different automation styles

### 👁️ Human Oversight & Control

- Allow human oversight and real-time intervention
- Maintain session state and progress, with pause/resume checkpoints

</td>
<td width="50%">

### 🌐 Web Interaction & Adaptability

- Adapt to website changes
- Handle complex modern websites

### 🛠️ Developer Experience & Integrations

- Provide clear CLI interface
- Provide a developer-friendly, configurable environment
- Work with multiple AI providers
- Provide trace logs for easy debugging
- Optimize token usage

</td>
</tr>
</table>

## Quick Start

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/Te29/mote.git
cd mote/mote
npm install
```

### 2. Configuration

Create your environment configuration:

```bash
cp .env.example .env
```

Edit `.env` and choose your LLM provider:

#### Option A: Local (Free & Private)
```env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
```

#### Option B: Cloud (OpenAI)
```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-key-here
```

### 3. Run

Start Mote:

```bash
npm start
```

That's it! Mote will launch a browser and guide you through creating your first automation workflow.

## Learn More

<details>
<summary><strong>Architecture Deep Dive</strong></summary>

### Architecture Deep Dive

Mote implements the **ReAct (Reason + Act)** paradigm, ensuring the agent doesn't blindly click around, but follows a structured loop:

**Perception → Reasoning → Action**

```

┌─────────────────────────────────────────────────────────────┐
│                           Mote                              │
│               (Playwright-based Orchestrator)               │
│       Entry Point · Lifecycle · State Management            │
└───────────────┬───────────────────────┬─────────────────────┘
                │                       ▲
                │  Observe              │
                ▼                       │
┌───────────────────────────────────┐   │ ┌─────────────────────────────────────┐
│           EYE LAYER               │   │ │      HUMAN-IN-THE-LOOP              │
│    (Perception & Cleansing)       │   │ │ (Safety Guard & Final Decision)     │
├───────────────────────────────────┤   │ ├─────────────────────────────────────┤
│ • Clean HTML Content Extraction   │   │ │ • Monitor & Observe Agent View      │
│ • Action Element Map              │   │ │ • Intervene & Correct Actions       │
│ • Markdown Conversion             │   │ │ • Join Decision-Making at Any Stage │
└──────────────────┬────────────────┘   │ └─────────────────────────────────────┘
                 ▲ │                    │
 Refinement Loop │ │ Perception Payload │
  (as needed)    │ ▼                    │
┌───────────────────────────────────┐   │
│           BRAIN LAYER             │   │
│       (Planning & Reasoning)      │   │
├───────────────────────────────────┤   │
│ • Intent Understanding            │   │
│ • Action Planning (Steps)         │   │
│ • Tool / Skill Selection          │   │
│ • Outcome Evaluation              │   │
│ • Self-Correction & Re-planning   │   │
└───────────────┬───────────────────┘   │
             ▲  │                       │
State Update │  │ Propose Plan          │
(Memory Feed)│  │                       │
             │  ▼                       │
┌───────────────────────────────────┐   │
│           HAND LAYER              │   │
│        (Action Execution)         │   │
├───────────────────────────────────┤   │
│ • Execute via Built-in Skills     │   │
│ • Real-time Status Reporting      │   │
│ • Step-by-Step Execution          │   │
│ • Continuous State Update         │   │
└───────────────┬───────────────────┘   │
                │                       │
                │  Execute / Save       │
                │                       │
                ▼                       │
┌───────────────────────────────────┐   │
│     Execution & Evidence Store    │   │
│   (Data Persistence & Security)   │   │
├───────────────────────────────────┤   │
│ • System Logs & Session Traces    │   │
│ • Visual Evidence (Screenshots)   │   │
│ • Execution Outputs (PDF/JSON)    │   │
│ • Memory (Execution Context)      │   │
└───────────────────────────────────┘   │
                │                       │
                │                       │
                └────────── Loop ───────┘
               （Next-session optimization）
```

### Core Logic

**ReAct Loop**

Mote observes the page through the Analyzer, reasons via the Brain, and executes actions using Skills. This loop continues until the goal is achieved.

**Tree of Thoughts (ToT) Influence**

The Human-in-the-Loop acts as a manual *path evaluator*. When the agent reaches a complex decision branch, users can prune incorrect paths, guiding the agent toward the most efficient reasoning tree.

</details>

<details>
<summary><strong>Folder Structure</strong></summary>

```
mote/
├── src/
│   ├── mote.ts                  # Entry point: orchestrates the state machine
│   ├── browser.ts               # Playwright browser context management
│   ├── observe.ts               # Perception: page sweep, element extraction, markdown generation
│   ├── reason.ts                # Reasoning: LLM-based action planning
│   ├── prompt.ts                # System/user prompt templates for LLM
│   ├── interaction.ts           # Human-in-the-loop intervention system
│   │
│   ├── act/                     # Action execution layer
│   │   ├── act.ts               # executeAction: click, type, scroll, navigate, etc.
│   │   ├── helpers.ts           # humanMouseMove, humanType, humanDelay
│   │   └── element-resolution.ts # verifyOrResolve, fuzzyMatchElement
│   │
│   ├── handlers/                # State machine handlers
│   │   ├── setup.ts             # SETUP: initialization and setup steps
│   │   ├── cycle.ts             # CYCLE_START / CYCLE_END: cycle lifecycle
│   │   ├── observe.ts           # OBSERVE: page perception
│   │   ├── reason.ts            # REASON: blueprint execution and LLM reasoning
│   │   ├── act.ts               # ACT: action execution and pointer advancement
│   │   └── wrapup.ts            # WRAPUP: session finalization
│   │
│   ├── bootstrap/               # Session bootstrapping
│   │   ├── bootstrap.ts         # Initialize session from preset or goal
│   │   └── plan-preview.ts      # Preview session plan before execution
│   │
│   ├── config/                  # Configuration
│   │   ├── defaults.ts          # Default settings
│   │   └── resolver.ts          # Config resolution and merging
│   │
│   ├── recorder/                # Workflow recorder
│   │   ├── runtime.ts           # Recorder runtime loop
│   │   ├── page-observer.ts     # DOM observation and element tracking
│   │   ├── interceptor.ts       # Network/action interception
│   │   ├── llm-generator.ts     # Generate session plans from recordings
│   │   └── handlers/            # Recording state handlers
│   │
│   ├── runtime/                 # Agent runtime
│   │   ├── runtime.ts           # Runtime state and context management
│   │   └── result.ts            # Session result formatting
│   │
│   ├── types/                   # TypeScript type definitions
│   │   ├── actions.ts           # Action, StepPlan, SessionPlan types
│   │   ├── config.ts            # Configuration types
│   │   ├── context.ts           # AgentContext, RuntimeState
│   │   ├── page.ts              # PageState, Element types
│   │   ├── session.ts           # Session tracker, cycle management
│   │   ├── state-machine.ts     # State machine phase definitions
│   │   ├── services.ts          # Service interfaces
│   │   └── results.ts           # Result types
│   │
│   └── utils/                   # Utilities
│       ├── checkpoint.ts        # Session checkpoint save/restore
│       ├── debug.ts             # Debug logging helpers
│       ├── handler-helpers.ts   # Shared handler utilities
│       ├── preset.ts            # Preset loading, prompt rendering
│       └── verification.ts      # Script/LLM-based verification
│
├── presets/                     # Automation presets
│   ├── _template/               # Template for creating new presets
│   └── percipio-quiz-helper/    # Example: auto-complete quizzes
│       ├── preset.json          # Preset metadata and settings
│       ├── session-plan.json    # Step-by-step execution plan
│       └── prompts/             # Step-specific LLM prompts
│
├── tests/                       # Test suite (vitest)
├── data/                        # Session logs and traces
├── docs/                        # Documentation
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

</details>

<details>
<summary><strong>How do presets work</strong></summary>

*(Content to be added)*

</details>

## License

MIT License

This project is open-source under the MIT License.

You are free to use, modify, and distribute it — including for commercial purposes — as long as the original license is included.
