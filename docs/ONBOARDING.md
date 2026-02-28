# SwarmBoard — Onboarding Guide

A step-by-step walkthrough for first-time users. By the end, you'll have a running sprint with AI agents building software from your spec.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+
- Git

## Step 1: Set Up Your Project

Clone or copy SwarmBoard into (or alongside) your project directory:

```bash
git clone https://github.com/PraAIHub/SwarmBoard.git
cd SwarmBoard
```

### Configure two things:

**1. Project name** — Edit `.agent-board/board.json`:
```json
{
  "project": "MyAwesomeApp",
  "spec": "SPEC.md",
  "tickets": [],
  "nextId": 1
}
```

**2. Project spec** — Write your requirements in `SPEC.md`. This is the most important file — the PM agent reads it to create tickets. See [Writing a Good Spec](#writing-a-good-spec) below.

## Step 2: Start the Dashboard

```bash
cd dashboard
npm install
node server.js
```

Open **http://localhost:3456**. You'll see:

```
┌──────────────────────────────────────────────────────┐
│ MyAwesomeApp          [Start Sprint]          planning│
├──────────────────────────────────────────────────────┤
│ AGENTS: [PM ○] [DEV ○] [REV ○] [QA ○]               │
├──────────────────────────────────────────────────────┤
│ Sprint Board (empty)                                  │
└──────────────────────────────────────────────────────┘
```

The board is empty because no tickets exist yet. That's normal.

## Step 3: Run the PM Agent

The PM agent reads your spec and creates tickets. You have two options:

### Option A: Via the Dashboard (recommended)

Click **Start Sprint**. The orchestrator spawns the PM agent automatically. It reads `SPEC.md`, creates tickets, and grooms them with acceptance criteria.

### Option B: Manually

Open a separate terminal in the SwarmBoard directory:

```bash
claude
> /pm
```

The PM agent will:
1. Read `blackboard.md` (empty — nothing to worry about)
2. Read your `SPEC.md`
3. Create tickets in `board.json` with status `new`
4. Groom each ticket: add acceptance criteria, test cases, priority, estimate
5. Move tickets to `groomed`

Watch the dashboard — tickets appear in real-time as the PM creates them.

## Step 4: Approve Tickets (Human Gate)

This is your first decision point. The PM has groomed tickets, but they won't move forward until you approve them.

**Review each ticket:**
- Does the acceptance criteria match your intent?
- Is the scope right? (Not too big, not too small)
- Are priorities correct?

**Approve tickets:**
- **One at a time:** Click a ticket card → click **Approve**
- **All at once:** Click **Approve All** in the Human Control tab (or use **Start Sprint** which does this automatically)

Approved tickets move from `groomed` → `dev-ready`.

> **Tip:** You don't have to approve everything. Leave low-priority tickets as `groomed` for a future sprint. Only approve what you want built now.

## Step 5: Watch Agents Work

Once tickets are `dev-ready` and auto-dispatch is ON, agents pick up work automatically:

```
Dev agent    → claims a dev-ready ticket → creates a branch → writes code → marks review-ready
Reviewer     → claims a review-ready ticket → reads the code → approves or requests changes
Test agent   → claims a test-ready ticket → writes tests → runs them → marks done or files bugs
```

### What you'll see on the dashboard:

- **Agent cards** light up green when running, show current ticket
- **Sprint Board** updates as tickets flow through lanes
- **Blackboard** shows agent signals (findings, handoffs)
- **Agent Logs** tab shows real-time output from each agent

### The review feedback loop

If the reviewer requests changes:
1. Ticket moves to `changes-requested` with specific review comments
2. Dev agent picks it back up on the **same branch**
3. Dev fixes exactly what was requested
4. Ticket goes back to `review-ready`
5. Reviewer checks the new commits

This loop continues until the reviewer approves.

## Step 6: Intervene When Needed

You don't have to just watch. You can intervene at any time:

| What you want | How to do it |
|---|---|
| Give agents info | Post a `finding` signal via the Blackboard tab |
| Change priorities | Click a ticket → Reprioritize |
| Block a ticket | Click a ticket → Block (with reason) |
| Override a review | Move the ticket yourself via "Move to" dropdown |
| Pull a ticket out | Move it back to `groomed` or `new` |
| Stop everything | Click **Halt Sprint** |

### Moving tickets with active agents

If you move a ticket that an agent is currently working on, the dashboard will:
1. Warn you: "DEV is working on this ticket"
2. Ask for confirmation
3. Stop the agent process before moving the ticket

This is safe — the agent's work is on a branch, so nothing is lost.

## Step 7: Sprint Review

When all tickets are `done` (or you've decided the sprint is over):

1. A **Sprint Review** button appears in the dashboard header
2. Or run `/review` in a Claude Code terminal

The review shows:
- What was delivered
- What was carried over
- Bugs found and fixed
- Cycle time and velocity

You accept or reject delivered work. Carried-over tickets go to the next sprint.

## Step 8: Retrospective

After the review, run `/retro` in a Claude Code terminal. The retro analyzes:

- How long tickets spent in each state
- How many review cycles each ticket needed
- Blocker duration
- Blackboard signal health

It proposes process improvements (WIP limit changes, schema tweaks). You approve or modify, then close the sprint.

---

## Writing a Good Spec

The quality of your spec directly determines the quality of the tickets the PM creates. Here's what works well:

### Do

- **Be specific about acceptance criteria** — "User can log in with email" is vague. "User enters email, receives a magic link, clicks it, and is authenticated with a session cookie" is actionable.
- **Include technical constraints** — "Use PostgreSQL", "Must work offline", "API response < 200ms". The dev agent needs these to make the right choices.
- **Mark priorities** — P0 (must have), P1 (should have), P2 (nice to have). The PM agent uses these.
- **Break features into independently deliverable chunks** — Each feature should be testable on its own.

### Don't

- **Don't write implementation details** — "Use a React context with useReducer" is too prescriptive. Say what you want, not how to build it. Let the dev agent decide the how.
- **Don't bundle unrelated features** — "Auth + Dashboard + API" as one feature creates a mega-ticket. Split them.
- **Don't leave ambiguity on purpose** — If you're unsure about a requirement, say so explicitly. The PM agent will flag it as a finding on the blackboard.

### Example

```markdown
# TaskTracker

## Overview
A simple task management app for small teams.

## Features

### F1 — User Authentication (P0)
- Users sign up with email + password
- Users log in and receive a JWT
- Sessions expire after 24 hours
- Acceptance criteria:
  - [ ] POST /auth/signup creates a user
  - [ ] POST /auth/login returns a JWT
  - [ ] Protected routes return 401 without valid JWT
  - [ ] Expired tokens are rejected

### F2 — Task CRUD (P0)
- Users create, read, update, and delete tasks
- Tasks have: title, description, status (todo/doing/done), due date
- Acceptance criteria:
  - [ ] CRUD endpoints for /tasks
  - [ ] Tasks are scoped to the authenticated user
  - [ ] Status transitions are validated

### F3 — Team Sharing (P1)
- Users can share tasks with other users
- Shared users can view but not edit
- Acceptance criteria:
  - [ ] POST /tasks/:id/share adds a viewer
  - [ ] Shared users see the task in their list
  - [ ] Shared users cannot modify the task
```

---

## Common Scenarios

### "The dev agent is stuck"

Check the blackboard — the agent may have posted a `stuck` or `blocker` signal. Common causes:
- Missing environment variables or API keys
- Unclear requirements (post a `finding` to clarify)
- Dependency on another ticket that isn't done yet

### "The reviewer keeps requesting changes"

This is normal for the first few tickets as the dev agent learns the codebase patterns. If it's looping:
- Check the review comments — are they actionable?
- Override: move the ticket to `test-ready` yourself if the code is good enough
- Post a `finding` on the blackboard with guidance

### "I want to change direction mid-sprint"

Use the interrupt levels:
1. **Small adjustment:** Post a `finding` to the blackboard
2. **Reprioritize:** Change ticket priorities in the dashboard
3. **Stop specific work:** Block a ticket with a reason
4. **Start over:** Click **Reset Sprint** — all tickets revert to `groomed`, agents stop

### "An agent crashed or got rate-limited"

The orchestrator handles this automatically:
1. It detects the agent exited
2. Checks `board.json` for in-progress tickets assigned to that agent
3. Spawns a new agent with a **session recovery** prompt
4. The new agent checks out the existing branch and continues

You don't need to do anything. The branch and board state are the recovery anchors.

### "I want to add a ticket mid-sprint"

Click **New Ticket** in the Human Control tab (or the PM agent can create one). The ticket starts as `new` → PM grooms it → you approve it → agents pick it up. No need to restart the sprint.

---

## What's Next

- Read the [Architecture doc](ARCHITECTURE.md) for deep technical details
- Read the [Dashboard README](../dashboard/README.md) for API endpoints and troubleshooting
- Read `CLAUDE.md` to understand the rules all agents follow
