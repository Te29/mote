# Mote

---

Mote is a lightweight browser automation agent framework powered by AI, designed to turn human workflows into reliable, repeatable automation pipelines.

Rather than relying on end-to-end black-box autonomy, Mote adopts a methodology-first agent design. It combines scripted steps with AI-assisted decisions through a clear lifecycle:
**record → normalize → execute → validate**.

The system also supports varying levels of human oversight, allowing LLMs to be orchestrated along predefined code paths.

Mote is a practical and approachable starting point for experiencing what it means to *give AI a pair of hands*.

---

## Features

**Workflow & Automation**

- Capture and reuse human workflows
- Execute browser automation with LLM assistance
- Learn and refine automation workflows over time
- Build and manage a preset library
- Optimize for repetitive tasks
- Choose different automation styles

**Human Oversight & Control**

- Allow human oversight and real-time intervention
- Maintain session state and progress, with pause/resume checkpoints

**Web Interaction & Adaptability**

- Adapt to website changes
- Handle complex modern websites

**Developer Experience & Integrations**

- Provide clear CLI interface
- Provide a developer-friendly, configurable environment
- Work with multiple AI providers
- Provide trace logs for easy debugging
- Optimize token usage

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/Te29/mote.git
cd mote/mote
npm install

# Configure your LLM
cp .env.example .env
```

Edit `.env` with your preferred LLM provider:

**Option A: Local (Free & Private)**
```env
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
```

**Option B: Cloud (OpenAI)**
```env
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-key-here
```

```bash
# Run
npm start
```

---

## 📚 Learn More

<details>
<summary><strong>LLM Configuration Guide</strong></summary>

### LLM Configuration Guide

*(Content to be added)*

</details>

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

### Folder Structure

```
mote/
├── src/
│   ├── core/                    # THE ORCHESTRATOR
│   │   ├── Mote.ts              # Entry point: coordinates Perception -> Reasoning -> Execution
│   │   ├── SessionManager.ts    # Manages browser context and lifecycle
│   │   └── StateStore.ts        # Tracks short-term memory and task progress
│   │
│   ├── perception/              # THE "EYE" LAYER
│   │   ├── Crawler.ts           # Playwright wrapper for page navigation
│   │   ├── Cleaner.ts           # Logic to strip scripts, styles, and hidden junk
│   │   ├── Mapper.ts            # Assigns numerical IDs [1] to interactive elements
│   │   └── Marketer.ts          # Formats cleaned HTML + Map into LLM-friendly Markdown
│   │
│   ├── reasoning/               # THE "BRAIN" LAYER
│   │   ├── Planner.ts           # The ReAct Loop (Think -> Act -> Observe)
│   │   ├── ModelProvider.ts     # Interface for Ollama, OpenAI, or Anthropic
│   │   ├── PromptEngine.ts      # Template manager for System and User prompts
│   │   └── Evaluator.ts         # Self-correction logic: "Did the action work?"
│   │
│   ├── execution/               # THE "HAND" LAYER
│   │   ├── tools/               # Atomic "Verbs" (Internal)
│   │   │   ├── ClickTool.ts     # Locates by ID and clicks
│   │   │   ├── InputTool.ts     # Handles typing and form filling
│   │   │   └── ScrollTool.ts    # Handles page movement
│   │   └── skills/              # Domain-specific "Personas" (External)
│   │       ├── BaseSkill.ts     # Abstract class defining the Skill contract
│   │       ├── JobSkill.ts      # Logic for LinkedIn/Indeed workflows
│   │       └── ResearchSkill.ts # Logic for deep-diving documentation
│   │
│   ├── common/                  # THE "NERVOUS SYSTEM"
│   │   ├── types/               # Centralized TypeScript Interfaces
│   │   │   ├── perception.ts    # Payload definitions
│   │   │   └── reasoning.ts     # Action/Thought definitions
│   │   ├── Logger.ts            # Console logs + Trace recording
│   │   ├── Constants.ts         # Default timeouts, URLs, and configs
│   │   └── Utils.ts             # Small, pure helper functions
│   │
│   └── index.ts                 # Main library export
│
├── data/                        # LOCAL STORAGE (Privacy-First)
│   ├── evidence/                # Screenshots and session traces
│   └── logs/                    # Execution history (JSON/Text)
│
├── examples/                    # EDUCATIONAL BOILERPLATE
│   ├── basic-search.ts          # Simple tutorial
│   └── job-hunting-demo.ts      # Multi-step skill demo
│
├── tests/                       # TEST SUITE
│   ├── unit/                    # Testing individual Layers
│   └── integration/             # Testing full ReAct loops
│
├── .env.example                 # Template for LLM API keys
├── .gitignore                   # Ignores /data and node_modules
├── package.json                 # Project dependencies
├── tsconfig.json                # TypeScript configuration
└── README.md                    # The "Mote" philosophy and setup guide
```

</details>

<details>
<summary><strong>How do presets work</strong></summary>

### How do presets work

*(Content to be added)*

</details>

---

## 📄 License

MIT License

This project is open-source under the MIT License.

You are free to use, modify, and distribute it — including for commercial purposes — as long as the original license is included.
