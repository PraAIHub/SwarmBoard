# Sprint Retrospective — Process Improvement Ceremony

This command analyzes the sprint process and proposes improvements. **Human-led ceremony.**

## When to Run

After `/review` (sprint review), before starting the next sprint.

## Your Task

Analyze how the sprint was EXECUTED (not what was built — that's `/review`'s job). Focus on the coordination system, agent performance, and process gaps.

### Step 1: Gather data

Read these files:
- `.agent-board/board.json` — final state of all tickets
- `.agent-board/blackboard.md` — all signals
- `.agent-board/history/` — every state transition with timestamps
- `.agent-board/schema.json` — current rules

### Step 2: Analyze patterns

Compute these metrics from the history files:

**Cycle Time**: For each completed ticket, measure time from `dev-ready` to `done`. Flag any ticket that took 3x longer than average.

**Review Cycles**: For each ticket, count how many times it went `in-review` → `changes-requested` → `in-dev` → `review-ready`. More than 2 cycles suggests unclear acceptance criteria or dev-reviewer misalignment.

**Blocker Duration**: For each blocker signal, measure time from posted to resolved. Long blockers mean the human wasn't available or the problem was poorly defined.

**Blackboard Health**: Count signals by type. Too many `stuck` signals means tickets were poorly scoped. Too many `finding` signals late in the sprint means the PM agent missed things during grooming.

**Dependency Accuracy**: Did the dependency chain hold? Were any tickets blocked by dependencies that weren't declared?

### Step 3: Present the Retrospective

```
SPRINT [name] RETROSPECTIVE
════════════════════════════

WHAT WORKED
───────────
- [specific observations backed by data]
- Example: "Dependency chain was correct — no ticket started before deps were done"
- Example: "Blackboard findings caught 3 issues before dev started"

WHAT DIDN'T WORK
─────────────────
- [specific observations backed by data]
- Example: "TICKET-005 was estimated medium but took 3x average — should have been split"
- Example: "Reviewer requested changes 3 times on TICKET-002 — acceptance criteria were ambiguous"

METRICS
───────
  Avg cycle time (dev-ready → done): X hours
  Avg review cycles per ticket: Y
  Blockers: Z total, avg resolution time: N hours
  Blackboard signals: A findings, B decisions, C blockers

PROCESS CHANGES PROPOSED
────────────────────────
Based on the analysis, propose specific changes. Examples:
- "Add complexity: x-large for tickets estimated >8 hours. Auto-split into sub-tickets."
- "PM agent should verify external dependencies (API keys, credentials) during grooming"
- "Add preflight step: verify all config/env vars exist before sprint starts"
- "Increase WIP limit to 2 for in-dev if tickets are small"
- "Decrease review strictness for tech-debt tickets (faster throughput)"

SCHEMA CHANGES
──────────────
If process changes require schema.json updates, list them:
- Example: "Add 'x-large' to valid complexity values"
- Example: "Change wip_limits.in-dev from 1 to 2"
```

### Step 4: Ask the human

1. "Which process changes do you approve?"
2. "Should I update schema.json with the approved changes?"
3. "Any other observations or changes you want to make?"

### Step 5: Apply approved changes

On human approval:
- Update `schema.json` with any approved rule changes
- Update `.agent-board/sprints/current.json` status to `"closed"`
- Archive the sprint: copy `current.json` to `.agent-board/sprints/v1-closed.json`
- Create fresh `current.json` for the next sprint
- Post a `decision` to blackboard with the retro outcomes
- Log everything to history
