# SwarmBoard Product Backlog

> Stories and epics for SwarmBoard **itself** as a product.
> Per-project sprint tickets live in `.agent-board/projects/{name}/board.json`.
> This file tracks the product roadmap for SwarmBoard development.

---

## Epic: Deploy Agents

**Status:** Planned
**Priority:** High

Automated deployment agents that execute artifacts created by dev agents.

### STORY-001: DB Deploy Agent
- **As a** user running a project with database requirements
- **I want** an agent that automatically executes DDL/migrations after the dev agent creates them
- **So that** database setup doesn't require manual intervention

**Acceptance Criteria:**
- `db-deploy-agent` role added to orchestrator with its own command file
- Triggers after dev creates migration artifacts and marks DB ticket done
- Executes migrations against configured target database
- Rolls back on failure and posts blocker signal
- Dashboard shows DB Deploy agent status

**Notes:** Currently artifacts are created by dev, deployment is manual. See MEMORY.md for workflow details.

### STORY-002: Code Deploy Agent
- **As a** user with a completed sprint
- **I want** an agent that handles deployment after tests pass
- **So that** shipping to production is automated

**Acceptance Criteria:**
- `code-deploy-agent` role added to orchestrator
- Triggers after all tickets are done and tests pass
- Runs configurable deploy scripts (push to prod, docker build, etc.)
- Posts deployment status to blackboard

**Implementation Notes:**
- Add agents to `orchestrator.js` definitions
- Create command files: `.claude/commands/db-deploy.md`, `code-deploy.md`
- Update `schema.json` with permissions
- Add to dashboard agent status bar

---

## Epic: GitHub OAuth Integration

**Status:** Done (MVP)
**Priority:** High
**Completed:** 2026-03-03

OAuth-based GitHub authentication for repo access. Replaces reliance on host machine git credentials.

### STORY-003: GitHub OAuth for Repo Connection (DONE)
- **As a** user connecting a private GitHub repo
- **I want** to authenticate via OAuth instead of configuring SSH keys
- **So that** repo setup is one-click from the dashboard

**Delivered:**
- `dashboard/auth.js` — Passport GitHub OAuth strategy, encrypted token storage
- `dashboard/server.js` — Auth routes, GitHub API proxy (repo list), status endpoints
- `dashboard/orchestrator.js` — `GIT_ASKPASS` mechanism for token-based git auth
- `dashboard/public/index.html` — Connect/disconnect UI, repo picker, header indicator
- Token encrypted at rest (AES-256-GCM), never in URLs or agent env

---

## Epic: Cloud SaaS Platform

**Status:** Backlog (parked — focus on shipping products with SwarmBoard first)
**Priority:** Future
**Decision:** 2026-03-03 — Build products first to validate patterns, then build SaaS

The long-term vision: SwarmBoard as a hosted multi-tenant platform where teams sign up, connect repos, and run AI agent sprints. Monetized via usage-based or tiered pricing.

### STORY-004: Auth & User Management
- **As a** new user
- **I want** to sign up / log in via GitHub OAuth
- **So that** I can access my projects securely

**Acceptance Criteria:**
- GitHub OAuth doubles as login (not just repo connection)
- User model in Postgres (id, github_id, username, email, plan, created_at)
- Session management with secure cookies
- Dashboard gated behind authentication middleware

### STORY-005: Database Migration (Files to Postgres)
- **As a** platform operator
- **I want** all project data stored in Postgres instead of flat files
- **So that** the system scales to multiple tenants reliably

**Acceptance Criteria:**
- Schema: users, projects, tickets, ticket_history, sprints, signals, secrets
- Migration script from existing file-based format
- Orchestrator reads/writes via DB adapter (not fs)
- Blackboard stored as structured signals table, not markdown

**Key Tables:**
```
users (id, github_id, username, email, plan, created_at)
projects (id, owner_id, name, spec, repo_url, repo_branch, created_at)
tickets (id, project_id, title, status, priority, type, assignee, branch, ...)
ticket_history (id, ticket_id, from_status, to_status, by, note, created_at)
sprints (id, project_id, number, goal, status, started_at, ended_at)
signals (id, project_id, type, title, detail, affects, by, created_at)
```

### STORY-006: Cloud Agent Execution
- **As a** platform user
- **I want** agents to run in the cloud (not on my machine)
- **So that** I don't need Claude CLI installed locally

**Acceptance Criteria:**
- Job queue (BullMQ + Redis) replaces `node-pty` subprocess spawning
- Worker nodes call Claude API directly instead of shelling out to `claude -p`
- Git operations sandboxed per tenant (isolated temp dirs or containers)
- Agent output streamed to dashboard via SSE (same UX as local)

**Architecture Decision:** Replace `node-pty` → `claude -p` with direct Anthropic API calls. Worker processes handle prompt construction, tool use loop, and git operations.

### STORY-007: Tenant Isolation
- **As a** user
- **I want** to only see my own projects
- **So that** my data is private

**Acceptance Criteria:**
- All API routes scoped by authenticated user
- Projects belong to a user (or org)
- No cross-tenant data leakage in queries, SSE, or agent execution
- Git repos cloned into user-scoped directories

### STORY-008: Billing & Monetization
- **As a** platform operator
- **I want** to charge users based on usage
- **So that** the platform is financially sustainable

**Acceptance Criteria:**
- Stripe integration for subscriptions and usage billing
- Usage metering: agent-minutes, API calls, storage
- Tier system: Free (1 project, limited agents), Pro (unlimited), Team (per-seat)
- Usage dashboard for users to see their consumption
- Billing portal for plan management

**Pricing Considerations:**
- Primary cost driver: Claude API usage per agent run
- Pass-through or absorb into tier pricing
- Free tier as acquisition funnel

### STORY-009: Team & Org Features
- **As a** team lead
- **I want** to invite team members to my projects
- **So that** we can collaborate on sprints

**Acceptance Criteria:**
- Org model: users can create orgs, invite members
- Roles: admin, pm, developer, viewer
- Org-level billing (one bill for the team)
- Project-level access control

### STORY-010: Deployment Infrastructure
- **As a** platform operator
- **I want** SwarmBoard SaaS deployed reliably
- **So that** users have a stable experience

**Candidates:** Railway, Fly.io, Render, or AWS ECS
- Postgres (managed): Neon, Supabase, or RDS
- Redis: Upstash or ElastiCache
- Domain + SSL + CDN
- CI/CD pipeline for deployments

---

## Epic: Open Source Enhancements

**Status:** Ongoing
**Priority:** Medium

Improvements to the self-hosted open-source version.

### STORY-011: Architect Agent Improvements
- Validate API contracts, not just tickets
- Auto-generate sequence diagrams from design tickets
- Cross-reference with existing codebase patterns

### STORY-012: Dashboard UX Polish
- Keyboard shortcuts for common actions
- Dark/light theme toggle
- Mobile-responsive layout
- Drag-and-drop ticket reordering

---

## Prioritization Notes

**Now:** Ship products using SwarmBoard to validate the tool and build case studies.
**Next:** Deploy agents (STORY-001, 002) to complete the automation loop.
**Later:** Cloud SaaS (STORY-004 through 010) once patterns are proven.
