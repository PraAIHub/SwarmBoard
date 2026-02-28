# HALT — Emergency Sprint Stop

This command immediately stops all agent activity. **Human-only command.**

## What It Does

1. Posts a `[halt]` signal to `.agent-board/blackboard.md`
2. Moves ALL in-progress tickets (`in-dev`, `in-review`, `in-test`) to `halted` status
3. Records the halt in `.agent-board/history/`
4. Updates `.agent-board/sprints/current.json` status to `halted`

## When to Use

- Something is fundamentally wrong — wrong approach, wrong scope, critical bug in production
- External event changes everything — stakeholder pivot, dependency failure, security incident
- You need all agents to stop and regroup before continuing

## Execution

When `/halt` is invoked, immediately do the following:

### Step 1: Post halt signal to blackboard

Append to `.agent-board/blackboard.md`:

```markdown
## [halt] SPRINT HALTED — human — <ISO timestamp>
Reason: <ask the human for the reason>
All agents must stop. Do not pick new work. Save progress to branches.
Affects: ALL TICKETS
```

### Step 2: Update all in-progress tickets

Read `.agent-board/board.json`. For every ticket with status `in-dev`, `in-review`, or `in-test`:
- Set `status: "halted"`
- Add history entry: `{ "from": "<previous>", "to": "halted", "by": "human", "at": "<timestamp>", "note": "Sprint halted: <reason>" }`

Do NOT touch tickets in `done`, `groomed`, or `dev-ready`.

### Step 3: Update sprint status

Set `.agent-board/sprints/current.json` status to `"halted"`.

### Step 4: Log to history

Create `.agent-board/history/<timestamp>-sprint-halted.json`:

```json
{
  "type": "halt",
  "by": "human",
  "at": "<ISO timestamp>",
  "reason": "<reason>",
  "tickets_halted": ["TICKET-XXX", "TICKET-YYY"],
  "previous_states": {
    "TICKET-XXX": "in-dev",
    "TICKET-YYY": "in-review"
  }
}
```

## Resuming After Halt

The human must explicitly resume. Use `/pm` or tell any Claude Code terminal:

```
Resume the sprint. Move halted tickets back to their previous states.
Remove the [halt] signal from the blackboard.
```

The halt history file preserves `previous_states` so tickets can be restored to where they were.

## Every Agent's Responsibility

ALL agent commands (pm, dev, reviewer, test) check for `[halt]` signals as their FIRST action. If a halt exists:
- Do NOT pick any work
- Do NOT make any transitions
- Report: "Sprint is halted. Waiting for human to resume."
