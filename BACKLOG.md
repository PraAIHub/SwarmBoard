# SwarmBoard Product Backlog

Items here are for human planning only — NOT for agents to pick up.

---

## Completed

| ID | Title | Status |
|----|-------|--------|
| BACKLOG-001 | Configurable Multi-Agent System with PM Chat Dashboard | Done |
| BACKLOG-002 | Multi-Project Support with Project Dropdown | Done |
| BACKLOG-003 | PM Agent Interview Flow for New Project Creation | Done |

---

## BACKLOG-004: Codified Context — Three-Tier Memory Architecture

**Priority:** High
**Status:** Research Complete — Ready for Design
**Inspired by:** [Codified Context: A Three-Tier Infrastructure for AI-Agent Development](https://arxiv.org/abs/2602.20478) (Vasilopoulos, 2026)

### Problem Statement

SwarmBoard agents have strong coordination infrastructure (ticket state machine, blackboard signals, human oversight) but **weak knowledge infrastructure**. Agents lose coherence across sessions, forget project conventions, and repeat known mistakes. Our current context payload per agent is ~700 lines of static instructions — the paper demonstrates that a 108K-line system required ~26,200 lines (24.2% of codebase) of codified context to maintain consistency.

### Research Summary

The paper documents a three-tier memory architecture built during construction of a 108,000-line C# distributed system across 283 sessions over 70 days. Key results:
- 29% reduction in median agent runtime
- 17% reduction in output token consumption
- 6 autonomous turns per human prompt
- 1,478 MCP retrieval calls across 218 sessions
- Primary failure mode: specification staleness (outdated docs mislead agents)

### The Gap: SwarmBoard vs Codified Context

| Dimension | Codified Context (Paper) | SwarmBoard (Current) |
|-----------|--------------------------|----------------------|
| Hot memory (always loaded) | Constitution ~660 lines | CLAUDE.md ~226 lines + command file ~100 lines |
| Warm memory (per-task) | 19 specialist agents ~9,300 lines | 4 generalist agents ~448 lines total |
| Cold memory (on-demand) | 34 spec docs ~16,250 lines via MCP | board.json + blackboard.md (full read every time) |
| Knowledge-to-code ratio | 24.2% | ~0.7% |
| Agent routing | Trigger tables (file pattern → specialist) | Fixed 4 roles, no domain routing |
| Convention memory | Constitution encodes all conventions | None — lost between sessions |
| Knowledge gap detection | Null retrieval triggers spec creation | None |
| Retrieval mechanism | MCP server with 5 search tools | Direct file reads (everything loaded) |

### What We Have That They Don't

- Multi-agent coordination with state machine handoffs
- Real-time dashboard with human override (their dashboard is read-only)
- Code review pipeline (Reviewer agent as merge gate)
- Session recovery via branch field as anchor
- Multi-project isolation with cross-project rate limiting
- PM Chat with conversational spec design

### What They Have That We Need

1. **Convention Memory** — persistent, failure-driven documentation that agents trust as ground truth
2. **Domain-Expert Routing** — trigger tables that map file patterns to specialist context
3. **Selective Retrieval** — agents query relevant context, not everything at once
4. **Knowledge Gap Detection** — null retrieval results surface undocumented subsystems
5. **Staleness Detection** — awareness that outdated specs mislead agents

---

## BACKLOG-005: Per-Project Convention Memory

**Priority:** High
**Status:** Planning
**Parent:** BACKLOG-004

### Description

Add a per-project `conventions.md` file that agents append to when they discover project-specific patterns. This file is loaded alongside the command file at agent startup. Conventions graduate from blackboard signals into permanent knowledge.

### Key Insight from Paper

> "Every spec emerged from a real failure. They didn't design docs upfront. When an agent made a mistake, they codified the correction so it never needed re-explanation."

This is the "failure-driven documentation" pattern — documentation as load-bearing infrastructure.

### Requirements

1. **Convention file** — `projects/{name}/conventions.md` per project
2. **Auto-loaded** — Orchestrator injects convention content into agent prompt alongside command file
3. **Agent-writable** — Agents can append new conventions when they discover patterns
4. **Structured format** — Each convention has: category, rule, reason, discovered-by, date
5. **Size guard** — Cap at ~200 lines; when exceeded, agents consolidate or human prunes
6. **Graduation path** — Blackboard `[decision]` signals can be promoted to conventions via dashboard action

### What Gets Codified

- Naming conventions discovered from existing code
- Error handling patterns (e.g., "all API routes need error middleware")
- Architecture decisions (e.g., "use repository pattern for data access")
- Known failure modes and their fixes
- Build/test commands specific to the project
- Dependency constraints (e.g., "don't upgrade library X past v2")

### Convention Format

```markdown
## [category] Rule Title — discovered-by — date
**Rule:** One-line convention statement
**Reason:** Why this matters
**Example:** Code snippet or file reference
```

---

## BACKLOG-006: Domain Spec Directory with Selective Injection

**Priority:** High
**Status:** Planning
**Parent:** BACKLOG-004

### Description

Add a `specs/` directory per project containing subsystem-specific documentation. When an agent claims a ticket, the orchestrator identifies relevant specs based on ticket metadata (file paths, tags, subsystem) and injects only those specs into the prompt — not the entire knowledge base.

### Key Insight from Paper

> Their 34 spec docs totaled ~16,250 lines. Loading all of them every session would exhaust the context window. Instead, agents query via MCP and retrieve only what's relevant. The top spec (dungeon-generation.md) was 1,286 lines alone.

### Requirements

1. **Spec directory** — `projects/{name}/specs/` with one markdown file per subsystem
2. **Spec index** — `specs/index.json` mapping subsystem names to file patterns, tags, and spec files
3. **Selective injection** — Orchestrator reads ticket metadata + spec index, injects matching specs into prompt
4. **Agent can request specs** — Agent can read specs from disk during session (current behavior, just organized)
5. **Spec creation from failures** — When agents post `[finding]` signals about undocumented areas, dashboard offers "Create spec" action
6. **Size tracking** — Dashboard shows spec coverage: documented vs undocumented subsystems

### Spec Index Format

```json
{
  "subsystems": {
    "auth": {
      "patterns": ["src/auth/**", "src/middleware/auth*"],
      "tags": ["authentication", "JWT", "session"],
      "spec": "auth-system.md"
    },
    "api": {
      "patterns": ["src/routes/**", "src/controllers/**"],
      "tags": ["REST", "endpoints", "middleware"],
      "spec": "api-conventions.md"
    }
  }
}
```

---

## BACKLOG-007: Trigger Table — Domain-Expert Routing

**Priority:** Medium
**Status:** Planning
**Parent:** BACKLOG-004

### Description

Extend `schema.json` with a `domain_routing` section that maps file patterns to context documents and optional specialist instructions. When a Dev agent claims a ticket that will touch `auth/` files, the orchestrator auto-injects auth-specific conventions and known issues.

### Key Insight from Paper

> Their constitution contains trigger tables: file pattern → specialist agent. When modifying networking files, the network-protocol-designer (with 915 lines of embedded domain knowledge) is auto-invoked. Over 50% of each specialist's content is domain knowledge, not behavioral instructions.

### Requirements

1. **Trigger table in schema** — `domain_routing` section mapping file globs to context docs
2. **Ticket-based matching** — Match against ticket description, acceptance criteria, and `files_affected` field
3. **Context injection** — Matched documents appended to agent prompt
4. **Cascading** — Multiple matches allowed (a ticket touching auth + API gets both specs)
5. **Opt-in per project** — Only active when specs exist; zero overhead for simple projects

### Design Decision: Specialists vs Context Injection

The paper uses 19 separate specialist agents. We should NOT do this — our coordination model (4 roles with state machine handoffs) is stronger. Instead, keep 4 generalist agents but **inject domain-specific context** per ticket. This gives us specialist knowledge without coordination complexity.

---

## BACKLOG-008: Knowledge Gap Detection

**Priority:** Medium
**Status:** Planning
**Parent:** BACKLOG-004

### Description

When an agent works on files with no matching spec in the domain routing table, auto-post a `[finding]` signal to the blackboard: "No specification found for subsystem X — consider creating one." Dashboard surfaces these as a "Documentation Gaps" panel.

### Key Insight from Paper

> Case Study 3: A null retrieval result from the MCP server revealed an undocumented subsystem (the drop system). This triggered spec creation from source code analysis, touching 14 files during subsequent refactor.

### Requirements

1. **Gap detection** — After agent claims ticket, orchestrator checks if any file patterns match spec index
2. **Auto-signal** — If no match, post `[finding]` to blackboard with affected files
3. **Dashboard panel** — "Documentation Gaps" section in Human Control tab showing undocumented subsystems
4. **Create spec action** — One-click "Create Spec Template" button that scaffolds a spec file for the gap
5. **Coverage metric** — Track % of source files covered by specs

---

## BACKLOG-009: Convention Graduation from Blackboard

**Priority:** Medium
**Status:** Planning
**Parent:** BACKLOG-005

### Description

Add a mechanism to graduate blackboard `[decision]` and `[finding]` signals into permanent convention entries. In the dashboard, each blackboard signal gets a "Promote to Convention" button. The `/retro` ceremony can also auto-extract recurring patterns into conventions.

### Requirements

1. **Dashboard action** — "Promote to Convention" button on `[decision]` and `[finding]` signals
2. **Auto-extract in retro** — `/retro` analyzes blackboard history and suggests conventions to codify
3. **Dedup check** — Before adding, check if a similar convention already exists
4. **Convention review** — Human reviews promoted conventions before they're committed

---

## BACKLOG-010: Knowledge-to-Code Ratio Tracking

**Priority:** Low
**Status:** Planning
**Parent:** BACKLOG-004

### Description

Track and display the knowledge-to-code ratio as a project health metric. The paper found 24.2% for a complex distributed system. This metric helps teams know when they're under-documenting.

### Requirements

1. **Metric calculation** — Count lines in: conventions.md + specs/ + CLAUDE.md + command files vs project source code
2. **Dashboard display** — Show ratio in sprint board header or Human Control tab
3. **Threshold alerts** — Configurable warning when ratio drops below a project-set minimum
4. **Historical tracking** — Track ratio over sprints to see if knowledge keeps pace with code

---

## BACKLOG-011: MCP Retrieval Server for Cold Memory

**Priority:** Low
**Status:** Research
**Parent:** BACKLOG-004

### Description

Build a lightweight MCP server that indexes the project's specs, conventions, and architectural docs. Agents call `find_relevant_context(task)` instead of reading everything. This is the paper's Tier 3 solution — only needed when projects grow large enough that selective injection (BACKLOG-006) hits file-count limits.

### Key Insight from Paper

> Their MCP server (~1,600 lines Python) provides 5 search tools. Current implementation uses keyword substring matching. 1,478 retrieval calls across 218 sessions. Future direction: embedding-based retrieval replacing keyword matching.

### Requirements

1. **MCP server** — Lightweight Python or Node service indexing `specs/` and `conventions.md`
2. **Search tools** — `list_subsystems()`, `find_relevant_context(task)`, `search_docs(query)`, `suggest_spec(files)`
3. **Keyword matching** (v1) — Simple substring matching (paper's current approach)
4. **Embedding-based** (v2) — Semantic search for better recall
5. **Integration** — Agents invoke via MCP tool calls during session

### When to Build

This is NOT needed for most projects. Build it when:
- `specs/` directory exceeds 30+ documents
- Selective injection (BACKLOG-006) starts consuming too much prompt context
- Projects reach 50K+ lines of code

---

## BACKLOG-012: Specification Staleness Detection

**Priority:** Low
**Status:** Planning
**Parent:** BACKLOG-004

### Description

Detect when specs are outdated relative to the code they describe. The paper's primary failure mode was agents following stale specifications that referenced deprecated code paths.

### Requirements

1. **Timestamp tracking** — Record when each spec was last updated vs when its matching files were last modified
2. **Staleness warning** — If spec is older than matching code by N commits, flag it in dashboard
3. **Agent warning** — When an agent loads a potentially stale spec, include a caveat in the prompt
4. **Auto-refresh prompt** — After significant refactors, suggest spec updates as part of the Dev agent's workflow

---

## Priority Summary

| Priority | Items | Theme |
|----------|-------|-------|
| **High** | BACKLOG-004, 005, 006 | Foundation: convention memory + domain specs |
| **Medium** | BACKLOG-007, 008, 009 | Routing, gap detection, graduation |
| **Low** | BACKLOG-010, 011, 012 | Metrics, MCP server, staleness (scale-dependent) |

### Recommended Implementation Order

```
BACKLOG-005 (Convention Memory)        ← Start here. Highest impact, lowest effort.
    ↓
BACKLOG-006 (Domain Spec Directory)    ← Adds structure for growing projects.
    ↓
BACKLOG-009 (Convention Graduation)    ← Connects blackboard → conventions.
    ↓
BACKLOG-007 (Trigger Table Routing)    ← Auto-injects relevant context.
    ↓
BACKLOG-008 (Knowledge Gap Detection)  ← Surfaces missing documentation.
    ↓
BACKLOG-010 (K:C Ratio Tracking)       ← Health metric for knowledge infra.
    ↓
BACKLOG-012 (Staleness Detection)      ← Prevents stale spec failures.
    ↓
BACKLOG-011 (MCP Retrieval Server)     ← Only at scale (50K+ LOC projects).
```
