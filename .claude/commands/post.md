# Post Signal — Blackboard Communication

Use `/post` to add a signal to the blackboard. This is for cross-cutting information that affects multiple tickets or agents.

## Usage

When invoked, ask the human (or determine from context):
1. **Signal type**: `finding` | `decision` | `blocker` | `stuck` | `handoff` | `available` | `halt`
2. **Title**: One-line summary
3. **Detail**: What was found/decided/blocked
4. **Affects**: Which tickets are impacted (if any)

## Format

Append to `.agent-board/blackboard.md`:

```markdown
## [TYPE] Title — AGENT-ROLE — YYYY-MM-DDTHH:MM
Detail of what was found/decided/blocked.
Affects: TICKET-XXX, TICKET-YYY
```

## Also log to history

Create `.agent-board/history/<timestamp>-signal-<type>.json`:

```json
{
  "type": "signal",
  "signal_type": "finding",
  "agent": "dev-agent",
  "at": "<ISO timestamp>",
  "title": "...",
  "detail": "...",
  "affects": ["TICKET-001"]
}
```

## Signal Reference

| Signal      | Use when... |
|-------------|-------------|
| `finding`   | You discovered something that changes direction |
| `decision`  | You and the human resolved an open question |
| `blocker`   | You cannot proceed — need human input |
| `stuck`     | Making slow progress, might need help |
| `handoff`   | Passing context to another agent |
| `available` | Ready for work, no tickets in your lane |
| `halt`      | **HUMAN ONLY** — emergency stop, all agents freeze. Use `/halt` command instead for full halt procedure. |
