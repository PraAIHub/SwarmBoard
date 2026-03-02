# Agent Board Dashboard & Orchestrator

Live dashboard + automated agent orchestration for the multi-agent sprint coordination system. The dashboard is the single control center for the human — sprint lifecycle, agent management, ticket creation, PM chat, and real-time monitoring. Supports multiple independent projects with per-project agent isolation.

## Quick Start

```bash
cd dashboard
npm install
node server.js
# Open http://localhost:3456
```

### First Run Workflow

1. Open `http://localhost:3456` — you'll see the sprint board in "planning" state
2. Create a project: click **New Project** in the header, or use the **Chat** tab to describe your idea to the PM agent
3. (Optional) Click **Human Control** tab, then **New Ticket** to add tickets to backlog
4. Click **Start Sprint** (green button in header) — all groomed tickets auto-approve to dev-ready, auto-dispatch enables
5. Watch agents work — each agent card shows status, current ticket, and live output log
6. Click any agent card to expand its log preview; click **Stop** / **Start** to control individually
7. Switch to **Agent Logs** tab for real-time orchestrator feed (filterable by agent)
8. Click any ticket card for details, approval actions, or block actions
9. Need to stop one agent? Click **Stop** on its card. Others keep working.
10. Need to halt everything? Click **Halt Sprint**. All agents stop.
11. Sprint finishes (all tickets done) — **Sprint Review** button appears in header

### Alternative: Manual Terminals

If you prefer running agents interactively instead of via the orchestrator:

```bash
# Terminal 1 — PM Agent
claude
> /pm

# Terminal 2 — Dev Agent
claude
> /dev

# Terminal 3 — Reviewer Agent
claude
> /reviewer

# Terminal 4 — Test Agent
claude
> /test
```

The dashboard still works as a monitor in this mode — it watches `.agent-board/` files and auto-refreshes.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser: http://localhost:3456                              │
│  Sprint Board │ Blackboard │ Agent Logs │ Human Control │ Chat│
│  Project Switcher │ New Project │ Start Sprint               │
└─────────┬───────────────────────────────────────────────────┘
          │ SSE + REST API
┌─────────▼───────────────────────────────────────────────────┐
│  server.js (Express)                                         │
│  ├── Per-Project Orchestrators (Map<projectName, Orchestrator>)│
│  │   ├── orchFor(req) — resolves orchestrator from ?project= │
│  │   ├── Each Orchestrator(projectRoot, projectDir):          │
│  │   │   ├── Spawns agents via node-pty + launch-agent.py     │
│  │   │   ├── Auto-dispatch: detects available work, starts agents│
│  │   │   ├── Per-agent output buffering (last 50 lines)       │
│  │   │   ├── Git worktree isolation per agent run              │
│  │   │   └── Events → SSE broadcast with project tag          │
│  │   └── Cross-project rate limiting (account-level)          │
│  ├── PM Chat (claude -p per project, streamed via SSE)        │
│  ├── Project management (create, switch, list)                │
│  ├── File watcher (chokidar) on active project dir            │
│  └── REST API for human actions + agent control               │
└─────────┬──────────────────────────┬────────────────────────┘
          │ fs.read/write            │ spawns
┌─────────▼──────────────────┐  ┌───▼────────────────────────┐
│  .agent-board/              │  │  Claude Code Agents         │
│  config.json ← active proj │  │  claude -p (PM)             │
│  schema.json ← rules       │  │  claude -p (Dev)            │
│  projects/{name}/           │  │  claude -p (Reviewer)       │
│    board.json ← tickets    │  │  claude -p (Test)           │
│    blackboard.md ← signals │  │  claude -p (Chat PM)        │
│    chat.json ← chat history│  │  Each runs one cycle, exits │
│    history/ ← audit trail  │  │  (Chat runs per-message)    │
│    sprints/current.json     │  └────────────────────────────┘
└─────────────────────────────┘
```

## Multi-Project Support

Each project is fully isolated with its own board, blackboard, sprint state, agent logs, and chat history. The server maintains a `Map<projectName, Orchestrator>` — orchestrators are created lazily on first access. Projects can optionally configure a target git repository (`"repo"` in `board.json`) for code artifacts. The orchestrator clones the repo on first agent run and creates worktrees from the clone, with `.agent-board/` symlinked for shared board state. Auth uses the host machine's git credentials.

### Key behaviors

- **Project switching** changes the dashboard view context but does NOT stop agents on any project. Agents on other projects keep running.
- **Cross-project rate limiting** — when any agent on any project hits an API rate limit, ALL agents across ALL orchestrators are stopped (account-level limit shared across projects).
- **Project resolution** — all action endpoints accept a `?project=` query parameter or `project` in the request body. Falls back to the active project if not specified.
- **Auto-migration** — on first run, existing single-project data in `.agent-board/` is automatically migrated into `projects/{name}/`.

### Project data layout

```
.agent-board/
├── config.json              ← {"activeProject": "MyProject"}
├── schema.json              ← State machine rules (shared across all projects)
└── projects/
    ├── MyProject/
    │   ├── board.json
    │   ├── blackboard.md
    │   ├── chat.json
    │   ├── SPEC.md
    │   ├── history/
    │   ├── logs/
    │   └── sprints/current.json
    └── Another-Project/
        ├── board.json
        ├── ...
```

## PM Chat

The Chat tab provides a conversational interface with a PM agent. Each message spawns a `claude -p` process that streams its response back via SSE.

### Features

- **Design-first workflow** — the PM creates a design/architecture ticket (type "design") with a mermaid architecture diagram and tech stack as acceptance criteria before creating implementation tickets. Human must approve the design before backlog stories are generated.
- **Tech stack discussion** — the PM proactively discusses technology choices, presents options with rationale, and asks the user to confirm. The spec template includes a Technology Stack table, Architecture section with mermaid diagram, Data Model, and API Design.
- **Spec generation** — describe your idea; the PM generates a structured spec in a ` ```spec ` code block
- **Board actions** — the PM can suggest ticket operations as `ACTION:` lines that render as confirmation cards in the UI. The user must confirm before execution.
- **Project creation** — when a spec is generated, the UI offers a "Save as new project" button
- **Project-scoped** — each project has its own `chat.json` history file; switching projects switches chat context
- **Streaming** — responses stream in real-time via SSE `chat-response` events

### ACTION cards

The PM agent can output board actions in its responses:

```
ACTION: {"type":"move-ticket","ticketId":"TICKET-001","toStatus":"dev-ready","note":"Ready for development"}
ACTION: {"type":"create-ticket","title":"Add auth","priority":"high","description":"Implement JWT auth"}
```

These render as interactive cards in the chat UI. The user clicks "Confirm" to execute them via `POST /api/chat/action`.

## Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◈ SwarmBoard    Sprint v1 · Goal: ...          [Start Sprint] LIVE │
│ Project: [MyProject ▾]  [+ New Project]                            │
├─────────────────────────────────────────────────────────────────────┤
│ AGENTS (click to expand/collapse)                                   │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐           │
│ │ PM     │ │ ARCH   │ │ DEV    │ │ REV    │ │ QA     │           │
│ │ ● idle │ │ ○ wait │ │ ● run  │ │ ○ wait │ │ ○ wait │           │
│ │        │ │        │ │ →T-001 │ │        │ │        │           │
│ │        │ │[Start] │ │ [Stop] │ │[Start] │ │[Start] │           │
│ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘           │
├─────────────────────────────────────────────────────────────────────┤
│ Tabs: [Sprint Board] [Blackboard] [Agent Logs] [Human Control] [Chat]│
└─────────────────────────────────────────────────────────────────────┘
```

## Dashboard Tabs

### Sprint Board
- Swim-lane Kanban with all ticket statuses
- Color-coded by priority (critical=red, high=amber, medium=blue)
- Click any ticket for details + actions (shows which agent is working on it)
- Sprint progress bar + stats
- Blackboard summary panel

### Blackboard
- Live signal feed (findings, decisions, blockers)
- Raw blackboard view
- Signal type counts

### Agent Logs
- Real-time orchestrator log feed (scrolling, color-coded by level)
- Filter by agent role (All / PM / ARCH / DEV / REV / QA)
- Shows dispatch events, completions, errors, and auto-dispatch activity
- **stderr visible** — agent errors now surface in the log (prefixed with `[stderr]`)
- **Persistent** — logs are written to `.agent-board/projects/{name}/logs/{role}.log` as JSONL and restored on restart

### Human Control
- **New Ticket** — create tickets with title, type, priority, description (PM agent grooms in next cycle)
- **Auto-Dispatch toggle** — ON: agents auto-dispatched when work available; OFF: manual control only
- **Approve tickets** — one-click groomed → dev-ready
- **Approve all** — batch approve all groomed tickets
- **Move ticket** — move any ticket to any status via dropdown (human override)
- **Post signals** — finding, decision, blocker, stuck
- **Block ticket** — stop specific ticket with reason
- **Halt sprint** — emergency stop, all agents freeze
- **Resume sprint** — restore halted tickets to previous states
- **Reset sprint** — revert to planning state, all active tickets → groomed, stop all agents
- Interrupt level reference guide

### Chat
- Conversational PM agent interface
- Message input with streaming responses
- Spec detection and "Save as Project" button
- ACTION cards with confirm/dismiss buttons
- Per-project chat history (persisted in `chat.json`)
- Clear chat button

### Agent Safety on Ticket Move
When a human moves a ticket that has an active agent assigned:
1. The ticket modal shows a warning: "⚠ agent-name is assigned — moving will stop the agent"
2. A confirmation dialog appears before proceeding
3. If confirmed, the agent process is stopped via the orchestrator before the ticket status changes
4. The ticket's assignee is cleared when moving to unowned states (new, groomed, dev-ready, review-ready, test-ready, changes-requested)

## Agent Bar

Each agent card in the bar shows:
- **Status dot** — green (idle), amber with pulse (running), red (error/stopped), gray (waiting), red (blocked by halt)
- **Block reason** — when an agent can't start, the card shows why: halt signal active, WIP limit reached, or no available work
- **Spinner animation** when running
- **Current ticket** — ID, title, and status badge with lane color
- **Elapsed time** when running
- **Start / Stop / Restart** button depending on agent state
- **Click to expand** — shows last 10 lines of agent output
- **Section header** — collapsible, always shows running/idle/other summary

## Header Controls

- **Start Sprint** button (green) — visible when sprint is in `planning` state; auto-approves all groomed tickets and enables auto-dispatch
- **Reset Sprint** button — visible when sprint is `active` or `halted`; reverts all active tickets to groomed, stops agents
- **Sprint Active** badge — green dot with pulse when sprint is active
- **Auto ON/OFF** badge — toggles auto-dispatch; visible when sprint is active
- **Sprint Review** button (purple) — appears when all tickets are done
- **Project switcher** — dropdown to switch between projects
- **New Project** — create a new project with name and optional spec

## API Endpoints

All action endpoints accept `?project=` query parameter or `"project"` in the request body to target a specific project. Falls back to the active project if not specified.

### State & Events

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Full board state (includes agents, autoMode, orchestratorLog, project context) |
| GET | `/api/events` | SSE stream — real-time updates (all events include `project` field) |
| GET | `/api/agents` | Agent states + autoMode + last 50 log entries |
| GET | `/api/agents/:role/log` | Full log for a specific agent role |

### Sprint & Ticket Actions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/actions/start-sprint` | Start sprint: planning → active, auto-approve groomed tickets, enable dispatch |
| POST | `/api/actions/create-ticket` | Create new ticket `{title, type, priority, description}` |
| POST | `/api/actions/approve` | Approve ticket `{ticketId}` — groomed → dev-ready |
| POST | `/api/actions/block` | Block ticket `{ticketId, reason}` |
| POST | `/api/actions/move-ticket` | Move ticket to any status `{ticketId, toStatus, note?, stopAgent?}` |
| POST | `/api/actions/reprioritize` | Change priority `{ticketId, priority}` |
| POST | `/api/actions/halt` | Halt sprint `{reason}` — stops all orchestrator agents |
| POST | `/api/actions/resume` | Resume from halt — re-enables auto-dispatch |
| POST | `/api/actions/reset-sprint` | Reset sprint to planning, revert all active tickets → groomed, stop all agents |
| POST | `/api/actions/signal` | Post to blackboard `{type, title, detail, affects}` |
| POST | `/api/actions/clear-rate-limit` | Clear rate limit flag across ALL orchestrators |

### Agent Control

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/actions/agents/:role/start` | Start a specific agent (e.g., `dev-agent`, `pm-agent`) |
| POST | `/api/actions/agents/:role/stop` | Stop a specific agent |
| POST | `/api/actions/dispatch/toggle` | Toggle auto-dispatch mode on/off |

### Project Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects with agent counts, display names, active status |
| POST | `/api/projects/switch` | Switch active project `{name}` — does NOT stop agents on other projects |
| POST | `/api/projects/create` | Create new project `{name, spec?, specContent?}` — scaffolds board, blackboard, sprint |
| GET | `/api/projects/repo` | Get target repo configuration for the active project |
| POST | `/api/projects/repo` | Set target repo configuration `{url, branch?}` — orchestrator clones on first agent run |

### PM Chat

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chat/history` | Get chat history for a project `?project=` |
| POST | `/api/chat/send` | Send chat message `{message}` — streams response via SSE `chat-response` events |
| POST | `/api/chat/clear` | Clear chat history and kill active chat process `{project?}` |
| POST | `/api/chat/action` | Execute a confirmed chat ACTION `{action}` — supports `move-ticket` and `create-ticket` types |
| POST | `/api/chat/save-spec` | Save spec from chat `{spec, projectName?}` — optionally creates a new project |

### SSE Event Types

All SSE events include a `project` field for client-side filtering:

| Event | Description |
|-------|-------------|
| `state-update` | Board state changed (tickets, sprint, blackboard) |
| `agent-update` | Agent status changed (running, idle, stopped, etc.) |
| `agent-output` | New agent log output available |
| `agent-blocked` | Agent blocked (halted, WIP limit) |
| `orchestrator-log` | Orchestrator log entry |
| `mode-change` | Auto-dispatch toggled |
| `rate-limit` | Rate limit detected — all agents stopping |
| `chat-response` | Chat PM response chunk `{chunk, done, hasSpec?, spec?, error?}` |
| `project-switch` | Active project changed |

## File Watcher

The server uses `chokidar` to watch the active project's directory. Any file change triggers:
1. Re-read full state
2. Broadcast via SSE to all connected browsers
3. Console alerts for pipeline bottlenecks
4. Orchestrator `evaluateAndDispatch()` when auto-mode is on

Pipeline alerts fire when:
- Tickets are `dev-ready` but no dev agent is working
- Tickets are `review-ready` but no reviewer is active
- Tickets are `test-ready` but no test agent is active
- Sprint is halted

## Orchestrator Module (orchestrator.js)

The `Orchestrator` class manages agent lifecycle for a single project. Each project gets its own instance.

```javascript
const Orchestrator = require('./orchestrator');

// Per-project: projectRoot is the git repo root, projectDir is the project's data directory
const orch = new Orchestrator(
  '/path/to/your-project',                          // projectRoot (git repo)
  '/path/to/your-project/.agent-board/projects/foo'  // projectDir (project data)
);

// Project identity
orch.projectName;  // "foo" (derived from projectDir basename)

// Manual dispatch
await orch.startAgent('dev-agent');
orch.stopAgent('dev-agent');

// Auto mode — dispatches agents when work is available
orch.startAutoMode();
orch.stopAutoMode();

// Per-agent logs (in-memory, restored from disk on startup)
const log = orch.getAgentLog('dev-agent');  // Last 50 output lines
// Logs persist to {projectDir}/logs/dev-agent.log (JSONL format)

// Agent states (includes last 10 log lines per agent)
const states = orch.getAgentStates();

// Emergency stop
orch.haltSprint('Wrong approach');
orch.stopAll();  // Stop all agent processes

// Zombie cleanup (called automatically on creation)
orch.cleanupZombies();  // Resets agents stuck in working state without a process
```

### How server.js Uses Orchestrators

- `orchestrators` Map stores one Orchestrator per project
- `getOrCreateOrchestrator(name)` lazily creates orchestrators
- `orchFor(req)` resolves the orchestrator from `?project=`, body, or active project
- All orchestrator events are forwarded to SSE with a `project` tag for client-side filtering
- Rate limit events trigger cross-project shutdown via the orchestrators Map
- File watcher triggers `orch.evaluateAndDispatch()` when auto-dispatch is on

**Note:** Auto-mode uses `claude -p` which runs single iterations. Each agent executes one loop (read board → pick ticket → do work → update board) then exits. The orchestrator re-dispatches when new work appears.

## Troubleshooting

### Agent shows "No output yet" or stuck at "working"

**Most common cause: halt signal still on blackboard.** The orchestrator checks `blackboard.md` for `[halt]` before starting any agent. If found, the agent won't spawn.

- Check the agent card log — it now shows the specific reason (halt, WIP limit, no work)
- Click **Resume Sprint** in the halt banner to clear the signal and re-enable dispatch

### Agent errors aren't visible

Agent stderr is now surfaced in the dashboard log prefixed with `[stderr]`. Check:
- The agent card's expanded log (click to expand)
- The **Agent Logs** tab (filter by the specific agent)
- The raw log file: `.agent-board/projects/{name}/logs/{role}.log`

### Logs lost after restart

Logs now persist to `.agent-board/projects/{name}/logs/` as JSONL files (one JSON object per line). On restart, the last 50 lines per agent are restored. To view raw logs:

```bash
# Tail a specific agent's log
tail -f .agent-board/projects/MyProject/logs/dev-agent.log | jq .

# View all agent logs for a project
ls .agent-board/projects/MyProject/logs/
```

### Agent blocked but no clear reason

The agent card now shows why it can't start:
- **"sprint is HALTED"** — halt signal on blackboard; use Resume
- **"No work available"** — no tickets in this agent's lane
- **"Blocked by WIP limit"** — another ticket is already in-progress for this lane (limit: 1)

### Agents on wrong project

All action endpoints accept `?project=` to target a specific project. The dashboard sends the active project automatically. If agents are running on a different project than expected:
- Check the project switcher in the header
- Use `GET /api/projects` to see which projects have running agents
- Switching projects doesn't stop agents — use Stop buttons to control agents explicitly

### Sprint stuck at "halted" after restart

The sprint status persists in `.agent-board/projects/{name}/sprints/current.json`. If the server was killed mid-halt, the blackboard may still contain the `[halt]` signal. Either:
- Click **Resume Sprint** in the dashboard
- Or manually remove the `[halt]` section from the project's `blackboard.md` and set `"status": "active"` in `sprints/current.json`

## Getting Started — Spec-Driven Workflow

SwarmBoard works with any project that has a spec:

1. Start the dashboard: `cd dashboard && node server.js`
2. Create a project via the **New Project** button or **PM Chat**
3. Add your spec — paste into `SPEC.md` in the project directory, or let PM Chat generate one
4. Click **Start Sprint** — the PM agent reads your spec and creates tickets
5. Approve tickets (or use **Start Sprint** to bulk-approve)
6. Dev, Reviewer, and Test agents pick up work automatically

The `"project"` field in `board.json` controls the dashboard header name. The `"spec"` field tells the PM agent where to find the project spec.
