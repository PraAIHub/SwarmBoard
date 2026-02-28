# Sprint Review — Demo & Acceptance Ceremony

This command generates a sprint review for the human to evaluate delivered work. **Human-led ceremony.**

## When to Run

When all sprint tickets are `done` (or the sprint timebox ends). Run before `/retro`.

## Your Task

Read all sprint data and present a comprehensive review to the human.

### Step 1: Gather data

Read these files:
- `.agent-board/board.json` — current state of all tickets
- `.agent-board/sprints/current.json` — sprint definition and goal
- `.agent-board/blackboard.md` — all signals posted during sprint
- `.agent-board/history/` — all state transitions

### Step 2: Present the Sprint Review

Generate this report:

```
SPRINT [name] REVIEW
════════════════════
Goal: [sprint goal from current.json]
Status: [how many tickets done vs total]

DELIVERED
─────────
For each ticket with status "done":
  ✅ TICKET-XXX — Title
     Acceptance criteria: X of Y met
     Dev: [dev-agent summary from dev_notes]
     Review: [passed/changes-requested count]
     Test: [pass/fail summary from test_cases]
     Branch: [branch name, now merged]

CARRIED OVER
────────────
For each ticket NOT done:
  🔄 TICKET-XXX — Title — current status
     Why: [reason from history or blocker signals]

BUGS FOUND
──────────
For each ticket with type "bug":
  🐛 BUG-XXX — Title — linked to TICKET-YYY
     Status: [current status]

BLACKBOARD SUMMARY
──────────────────
  Findings: [count] — [one-line each]
  Decisions: [count] — [one-line each]
  Blockers: [count] — [resolved/unresolved]

VELOCITY
────────
  Tickets completed: X of Y (Z%)
  Bugs found: N
  Review cycles: avg M per ticket
  Blockers resolved: K
```

### Step 3: Ask the human

After presenting the review, ask:
1. "Do you accept the delivered work?"
2. "Should carried-over tickets move to Sprint v2 or back to backlog?"
3. "Any tickets you want to reprioritize?"

### Step 4: Update sprint status

On human acceptance, update `.agent-board/sprints/current.json`:
- Set `status: "review"`
- Record the human's decisions in history

Do NOT close the sprint — that happens after `/retro`.
