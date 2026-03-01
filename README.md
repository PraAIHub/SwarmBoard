# SwarmBoard

A multi-agent sprint board framework for Claude Code. Four AI agents (PM, Dev, Reviewer, Test) coordinate through a shared ticket board to build software from a spec — with full human oversight via a web dashboard.

## Quick Start

```bash
# 1. Start the dashboard
cd dashboard && npm install && node server.js

# 2. Open http://localhost:3456

# 3. Create a project:
#    Option A: Click "New Project" in the dashboard header
#    Option B: Open the Chat tab and describe your idea to the PM agent
#              — it will generate a spec and create the project for you

# 4. Add your spec:
#    Paste into SPEC.md, or let PM Chat generate one from a conversation

# 5. Click "Start Sprint" → PM agent creates tickets from your spec
#    Approve tickets → Dev/Reviewer/Test agents pick up work automatically
```

## How It Works

SwarmBoard uses a ticket-based state machine with four specialized agents:

| Agent | Role | What it does |
|---|---|---|
| **PM** | Planner | Reads your spec, creates tickets, grooms acceptance criteria |
| **Dev** | Builder | Claims tickets, creates feature branches, writes code |
| **Reviewer** | Gatekeeper | Reviews PRs, requests changes or merges to main |
| **Test** | QA | Runs tests against acceptance criteria, files bug tickets |

Agents communicate through:
- **board.json** — ticket states, assignments, history
- **blackboard.md** — cross-cutting signals (findings, blockers, decisions)
- **Git branches** — one branch per ticket, PRs for review

## Dashboard

The web dashboard at `http://localhost:3456` gives you full control:

- **Sprint Board** — Kanban view of all ticket states
- **Blackboard** — Real-time agent signals and findings
- **Agent Logs** — Live output from each agent
- **Human Controls** — Approve, block, move, halt, override
- **PM Chat** — Conversational interface with the PM agent for spec design, ticket actions, and project creation

### Human Override

You can move any ticket to any state, halt all agents instantly, or override any agent decision. The dashboard warns you when an action will interrupt a working agent.

## Running Agents

### Orchestrator (recommended)

The dashboard auto-dispatches agents as work becomes available. Just start the server and click "Start Sprint".

### Manual

Open separate Claude Code terminals:

```bash
# Terminal 1 — PM
claude → /pm

# Terminal 2 — Dev
claude → /dev

# Terminal 3 — Reviewer
claude → /reviewer

# Terminal 4 — Test
claude → /test
```

## Project Structure

```
SwarmBoard/
├── CLAUDE.md                 ← Agent instructions (read by all agents)
├── SPEC.md                   ← Default project spec
├── .agent-board/
│   ├── config.json           ← Active project selection
│   ├── schema.json           ← State machine + rules (shared)
│   └── projects/             ← Per-project data (isolated)
│       └── {project-name}/
│           ├── board.json        ← Ticket board
│           ├── blackboard.md     ← Agent signals
│           ├── chat.json         ← PM Chat history
│           ├── SPEC.md           ← Project spec (optional)
│           ├── history/          ← Audit log
│           ├── logs/             ← Agent output logs
│           └── sprints/
│               └── current.json  ← Sprint metadata
├── .claude/
│   ├── commands/             ← Slash commands (/pm, /dev, etc.)
│   └── skills/               ← Agent skill definitions
├── dashboard/                ← Web dashboard + orchestrator
│   ├── server.js             ← Express server + chat + project management
│   ├── orchestrator.js       ← Per-project agent dispatch engine
│   ├── launch-agent.py       ← Agent process launcher
│   ├── launch-chat.py        ← PM Chat process launcher
│   └── public/index.html     ← Dashboard UI
└── docs/ARCHITECTURE.md      ← System architecture
```

## Multi-Project Support

SwarmBoard supports multiple independent projects, each with its own agents, board, and sprint state. Projects are isolated — switching the active project in the dashboard doesn't stop agents running on other projects.

- **Create projects** via the dashboard header or PM Chat
- **Switch projects** with the project switcher dropdown — agents on other projects keep running
- **Independent agents** — each project gets its own Orchestrator instance with separate PM, Dev, Reviewer, and Test agents
- **Cross-project rate limiting** — if one project's agent hits an API rate limit, all agents across all projects are stopped (account-level limit)

## PM Chat

The Chat tab provides a conversational interface with a PM agent powered by Claude:

- **Spec generation** — describe your project idea and the PM generates a structured spec
- **Board actions** — the PM can suggest ticket moves and creation as ACTION cards that you confirm before execution
- **Project creation** — generate a spec from chat, then save it as a new project with one click
- **Project-scoped** — each project has its own chat history

## Using with Your Project

1. Clone or copy SwarmBoard into your project (or use it as a sibling directory)
2. Start the dashboard: `cd dashboard && npm install && node server.js`
3. Create a project via the dashboard or PM Chat, and provide your spec
4. Start the sprint and let the agents build

SwarmBoard is framework-agnostic — it works with any language, stack, or project type. The agents read your spec and adapt.

**First time?** Read the [Onboarding Guide](docs/ONBOARDING.md) for a detailed walkthrough.

## License

MIT
