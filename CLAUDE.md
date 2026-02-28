# Multi-Agent Sprint Board

This project uses a **ticket-based multi-agent coordination system** with a sprint board, code review gates, branching workflow, and human interrupt controls.

## Architecture

```
.agent-board/
├── board.json          ← Single source of truth for all tickets
├── blackboard.md       ← Cross-cutting signals (findings, blockers, decisions)
├── schema.json         ← State machine, permissions, WIP limits, branching rules
├── history/            ← Append-only audit log of all state changes
└── sprints/
    └── current.json    ← Active sprint definition
```

## Agent Roles

Four agents coordinate through the board. Each runs in a separate Claude Code terminal.

| Agent    | Command     | Reads                            | Writes                          | Transitions                                         |
|----------|-------------|----------------------------------|---------------------------------|-----------------------------------------------------|
| PM       | `/pm`       | spec, board.json, blackboard.md  | board.json (create/groom)       | `new → groomed → dev-ready`                         |
| Dev      | `/dev`      | board.json, blackboard.md, code  | code on feature branch, board   | `dev-ready → in-dev → review-ready`                 |
| Reviewer | `/reviewer` | board.json, blackboard.md, PRs   | board.json, merges PRs          | `review-ready → in-review → test-ready` or `→ changes-requested` |
| Test     | `/test`     | board.json, blackboard.md, code  | test files, board.json          | `test-ready → in-test → done` or `→ bug ticket`    |

## Ticket State Machine

```
new → groomed → dev-ready → in-dev → review-ready → in-review → test-ready → in-test → done
                               │           │              │                        │
                           blocked     (branch)    changes-requested           bug (new ticket)
                                                         │
                                                      in-dev (same branch, fix feedback)
```

**Human can move ANY ticket to ANY status via the dashboard (full override authority).**
**Human can halt ALL agents via `/halt` or the dashboard Halt button.**
**Moving a ticket with an active agent will stop that agent first (with confirmation).**

## Branching Workflow

Every ticket gets its own branch. No direct commits to main.

```
main (protected)
├── feat/TICKET-001-fix-skeleton-crashes
├── feat/TICKET-002-magic-link-auth
├── fix/BUG-001-token-expiry
└── ...
```

- Dev agent creates branch when claiming a ticket
- Dev agent pushes commits to the branch, never to main
- Reviewer agent reviews the PR, merges to main on approval
- Test agent tests on main after merge
- If changes requested, dev agent fixes on the SAME branch

## Board Rules (ALL AGENTS MUST FOLLOW)

1. **Read blackboard.md FIRST** before picking any ticket — it may contain findings, blockers, or halt signals that change everything.
2. **Claim before working** — set `assignee` to your agent role before changing status.
3. **One ticket at a time** — WIP limit of 1 per lane. Finish or block before claiming another.
4. **Write history** — every status change appends to the ticket's `history` array AND creates a file in `.agent-board/history/`.
5. **Post signals** — if you discover something that affects other tickets or agents, append to `blackboard.md`.
6. **Never skip states** — a ticket must pass through every state in sequence.
7. **Bugs are new tickets** — when a test fails, create a new ticket with type `bug`. Link to parent.
8. **Human approval gates** — `groomed → dev-ready` requires human confirmation.
9. **Branch per ticket** — dev agent creates `feat/TICKET-XXX-title` branch. No direct main commits. The `branch` field MUST be written to the ticket in board.json when claiming.
10. **Reviewer merges** — only the reviewer agent or human can merge PRs to main.
11. **Halt means stop** — if a `[halt]` signal exists on the blackboard, do NOT pick new work. Save progress and wait.
12. **Session recovery** — if you find a ticket already assigned to you with a `branch` field, check out that branch and resume. Do NOT create a new branch.

## Session Recovery

Agents may crash, rate-limit, or lose context mid-work. The orchestrator handles this automatically:

1. When an agent exits, the orchestrator checks board.json for in-progress tickets (`in-dev`, `in-review`, `in-test`) assigned to that agent.
2. If found, the next invocation receives a **SESSION RECOVERY** prompt with the ticket ID, branch name, and instructions to resume.
3. The agent checks out the existing branch, reviews what's already done (`git log`, read code), and continues from where the previous session left off.
4. Reviewer and test agents also use the `branch` field to find the code to review/test.

**Key requirement:** The `branch` field in board.json is the recovery anchor. Agents MUST write it when claiming a ticket.

## Signal Protocol (Blackboard)

| Signal      | When to use                                                    |
|-------------|----------------------------------------------------------------|
| `finding`   | Discovered something that changes direction or affects tickets  |
| `decision`  | Resolved an open question                                      |
| `blocker`   | Cannot proceed — needs human input                             |
| `stuck`     | Degraded but working — may need help soon                      |
| `handoff`   | Passing context to the next agent                              |
| `available` | Ready for work, looking for tickets                            |
| `halt`      | EMERGENCY — all agents stop. Human-only signal.                |

Format:
```markdown
## [signal-type] Title — agent-role — timestamp
Detail of what was found/decided/blocked.
Affects: TICKET-XXX, TICKET-YYY
```

## Human Interrupt Levels

| Level      | Action                        | How                                       |
|------------|-------------------------------|-------------------------------------------|
| **Nudge**  | Post `finding` to blackboard  | Agents adjust behavior next loop          |
| **Redirect** | Reprioritize a ticket       | Different ticket gets picked next         |
| **Block**  | Post `blocker` to blackboard  | Affected tickets can't be claimed         |
| **Override** | Force approve/block PR       | Human outranks reviewer agent             |
| **Recall** | Move ticket back to backlog   | Work paused, ticket exits sprint          |
| **Halt**   | Run `/halt`                   | ALL agents stop immediately               |

## Dashboard — Human Control Center

The dashboard at `http://localhost:3456` provides full control over the sprint:

```
┌─────────────────────────────────────────────────────────────────┐
│ ◈ SwarmBoard           [Start Sprint] [Reset Sprint] [Auto ON] │
├─────────────────────────────────────────────────────────────────┤
│ AGENTS: [PM ● idle] [DEV ● working] [REV ○ waiting] [QA ○]    │
├─────────────────────────────────────────────────────────────────┤
│ Tabs: [Sprint Board] [Blackboard] [Agent Logs] [Human Control] │
│                                                                 │
│  Sprint Board: Kanban swim lanes for all 11 ticket statuses     │
│  Click any ticket → modal with:                                 │
│    • Approve / Block quick actions                              │
│    • "Move to:" dropdown (ALL statuses) + Move button           │
│    • ⚠ Warning if agent is assigned (will stop agent)           │
│    • History, acceptance criteria, dev notes                     │
└─────────────────────────────────────────────────────────────────┘
```

### Dashboard Actions

| Action | What it does |
|---|---|
| **Start Sprint** | Bulk-approve all groomed tickets, enable auto-dispatch |
| **Reset Sprint** | Stop all agents, revert all active tickets → groomed, back to planning |
| **Approve** (per ticket) | Move a single groomed ticket to dev-ready |
| **Move to** (per ticket) | Move any ticket to any status (human override) |
| **Block** (per ticket) | Block a ticket with a reason |
| **Reprioritize** | Change ticket priority |
| **Create Ticket** | Add a new ticket from the dashboard |
| **Halt** | Emergency stop — all agents freeze |
| **Resume** | Restore halted tickets to previous state |

### Agent Safety

When moving a ticket that has an active agent assigned:
1. Dashboard shows warning: *"⚠ dev-agent is assigned — moving will stop the agent"*
2. Confirmation dialog: *"DEV is working on TICKET-015. Stop agent and move?"*
3. If confirmed → agent process stopped → ticket moved → assignee cleared
4. If declined → no change

## Sprint Lifecycle

```
planning → active → review → retro → closed
    │         │        │        │
 (human)   (human)  (human)  (human)
 approves  can       demos    evaluates
 scope     reset     work     process
```

## Sprint Ceremonies

| Ceremony      | Command    | Led by  | Purpose                                    |
|---------------|------------|---------|---------------------------------------------|
| Sprint Plan   | `/pm`      | Human   | Approve scope, move tickets to dev-ready    |
| Sprint Review | `/review`  | Human   | Demo delivered work, accept or reject       |
| Retrospective | `/retro`   | Human   | Evaluate process, adjust system for next sprint |

## Running Multiple Agents

### Option A: Orchestrator (recommended)

```bash
cd dashboard && npm install && node server.js
# Open http://localhost:3456
# Click: Start Sprint → Approve All → Toggle Auto-Dispatch
# Agents spawn automatically as work becomes available
```

### Option B: Manual Terminals

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

# Any terminal — Monitor
> /board

# Any terminal — Emergency Stop
> /halt
```

## Getting Started — Spec-Driven Workflow

SwarmBoard works with any project that has a spec. Here's how:

1. Write your project spec in `SPEC.md` (or any markdown file)
2. Set the spec path in `.agent-board/board.json` → `"spec"` field
3. Start the dashboard: `cd dashboard && node server.js`
4. The PM agent reads your spec, creates and grooms tickets
5. Approve tickets (or click **Start Sprint** to bulk-approve)
6. Dev, Reviewer, and Test agents pick up work automatically

The `"project"` field in `board.json` controls the dashboard header name. The `"spec"` field tells the PM agent where to find the project spec.
