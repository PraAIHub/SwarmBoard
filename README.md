# SwarmBoard

A multi-agent sprint board framework for Claude Code. Four AI agents (PM, Dev, Reviewer, Test) coordinate through a shared ticket board to build software from a spec — with full human oversight via a web dashboard.

## Quick Start

```bash
# 1. Write your project spec
#    Edit SPEC.md with your project requirements

# 2. Set your project name
#    Edit .agent-board/board.json → "project": "YourProject"

# 3. Start the dashboard
cd dashboard && npm install && node server.js

# 4. Open http://localhost:3456
#    Click "Start Sprint" → PM agent creates tickets from your spec
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
├── SPEC.md                   ← Your project spec (read by PM agent)
├── .agent-board/
│   ├── board.json            ← Ticket board (single source of truth)
│   ├── blackboard.md         ← Agent signals
│   ├── schema.json           ← State machine + rules
│   ├── history/              ← Audit log
│   ├── logs/                 ← Agent output logs
│   └── sprints/current.json  ← Sprint metadata
├── .claude/
│   ├── commands/             ← Slash commands (/pm, /dev, etc.)
│   └── skills/               ← Agent skill definitions
├── dashboard/                ← Web dashboard + orchestrator
│   ├── server.js             ← Express server
│   ├── orchestrator.js       ← Agent dispatch engine
│   ├── launch-agent.py       ← Agent process launcher
│   └── public/index.html     ← Dashboard UI
└── docs/ARCHITECTURE.md      ← System architecture
```

## Using with Your Project

1. Clone or copy SwarmBoard into your project (or use it as a sibling directory)
2. Write your spec in `SPEC.md`
3. Update `board.json` with your project name
4. Start the dashboard and let the agents build

SwarmBoard is framework-agnostic — it works with any language, stack, or project type. The agents read your spec and adapt.

**First time?** Read the [Onboarding Guide](docs/ONBOARDING.md) for a detailed walkthrough.

## License

MIT
