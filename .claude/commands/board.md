# Board View — Sprint Dashboard in Terminal

This command displays the current sprint board state. **Read-only view.** Use natural language in the same terminal to take actions.

## What It Shows

Read these files and render the board:

1. `.agent-board/sprints/current.json` — sprint name, status, goal
2. `.agent-board/board.json` — all tickets
3. `.agent-board/blackboard.md` — signals

## Rendering the Board

### Step 1: Check for halt

If blackboard.md contains a `[halt]` signal, show this FIRST in large text:

```
╔══════════════════════════════════════════════════╗
║  ⛔  SPRINT HALTED                               ║
║  Reason: <reason from halt signal>               ║
║  Tell me "resume sprint" to lift the halt.       ║
╚══════════════════════════════════════════════════╝
```

### Step 2: Sprint header

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  <project> — Sprint <name>              <STATUS>
  Goal: <goal>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Step 3: Agent status

Show each agent's current state by reading board.json assignee fields:

```
  AGENTS
  PM: idle    DEV: working → TICKET-001    REV: waiting    QA: waiting
```

Agent status is derived:
- If a ticket has `assignee: "dev-agent"` and is `in-dev` → DEV: working → TICKET-XXX
- If no ticket is assigned to an agent → that agent is `idle` or `waiting`

### Step 4: Swim lanes

Group tickets by status into columns. Show only lanes that have tickets OR are key pipeline stages.

Always show these lanes: BACKLOG (groomed), DEV READY, IN DEV, REVIEW, IN TEST, DONE

For each ticket in a lane, show:
```
  ┌─────────────────┐
  │ 001 ▲critical   │
  │ Fix skeleton     │
  │ ◆ dev-agent     │
  └─────────────────┘
```

Where:
- First line: ticket ID + priority indicator (▲critical ●high ○medium ·low)
- Second line: title (truncated to fit)
- Third line: type icon (◆feature ⚙tech-debt ●bug ◇spike) + assignee if any

Color guidance (if terminal supports it):
- critical = red, high = yellow, medium = blue, low = gray
- in-dev = yellow, done = green, blocked/halted = red

### Step 5: Dependency chain

Show which tickets are blocked by unfinished dependencies:

```
  DEPENDENCIES
  004 ← waiting on 002 (groomed), 006 (groomed)
  005 ← waiting on 004 (groomed), 006 (groomed)
  007 ← waiting on 005 (groomed)
```

Only show tickets whose dependencies are NOT yet `done`.

### Step 6: Blackboard summary

```
  BLACKBOARD
  5 findings · 1 decision · 0 blockers · 0 halt signals
  Latest: [handoff] Sprint v1 tickets groomed — awaiting approval (pm-agent, 19:00)
```

### Step 7: Sprint progress

```
  PROGRESS  ████░░░░░░░░░░░░░░░░  0 of 7 done (0%)
            1 in progress · 3 dev-ready · 3 backlog
```

### Step 8: Available actions reminder

```
  YOUR ACTIONS
  "Approve TICKET-XXX to dev-ready"     "Post a blocker on TICKET-XXX"
  "Reprioritize TICKET-XXX to critical" "/halt — stop everything"
  "/review — sprint review ceremony"    "/retro — retrospective"
```

## Important Notes

- This is a READ-ONLY display. Do not modify any files.
- After displaying the board, wait for the human's instructions.
- If the human gives an action (approve, block, reprioritize, etc.), execute it by modifying the appropriate files, then re-display the board.
- Keep the display compact — this is a terminal, not a web page.
