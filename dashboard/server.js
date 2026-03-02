const express = require('express');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const Orchestrator = require('./orchestrator');

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const BASE_BOARD_DIR = process.env.BOARD_DIR || path.resolve(__dirname, '..', '.agent-board');
const CONFIG_FILE = path.join(BASE_BOARD_DIR, 'config.json');
const PROJECTS_DIR = path.join(BASE_BOARD_DIR, 'projects');
const SCHEMA_FILE = path.join(BASE_BOARD_DIR, 'schema.json');
const PORT = process.env.PORT || 3456;

// Mutable context — all project-specific paths live here
const ctx = {
  projectName: null,
  projectDir: null,
  boardFile: null,
  blackboardFile: null,
  sprintFile: null,
  historyDir: null,
  logsDir: null,
};

function setActiveProject(name) {
  ctx.projectName = name;
  ctx.projectDir = path.join(PROJECTS_DIR, name);
  ctx.boardFile = path.join(ctx.projectDir, 'board.json');
  ctx.blackboardFile = path.join(ctx.projectDir, 'blackboard.md');
  ctx.sprintFile = path.join(ctx.projectDir, 'sprints', 'current.json');
  ctx.historyDir = path.join(ctx.projectDir, 'history');
  ctx.logsDir = path.join(ctx.projectDir, 'logs');
}

function migrateIfNeeded() {
  if (fs.existsSync(PROJECTS_DIR)) return; // already migrated
  const oldBoard = path.join(BASE_BOARD_DIR, 'board.json');
  if (!fs.existsSync(oldBoard)) return; // nothing to migrate

  // Read project name from existing board.json
  let name = 'MyProject';
  try {
    const board = JSON.parse(fs.readFileSync(oldBoard, 'utf-8'));
    if (board.project) name = board.project;
  } catch (e) { /* use default */ }

  const dest = path.join(PROJECTS_DIR, name);
  fs.mkdirSync(path.join(dest, 'sprints'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'history'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'logs'), { recursive: true });

  // Move project-specific files
  const filesToMove = [
    ['board.json', 'board.json'],
    ['blackboard.md', 'blackboard.md'],
  ];
  for (const [src, dst] of filesToMove) {
    const srcPath = path.join(BASE_BOARD_DIR, src);
    if (fs.existsSync(srcPath)) {
      fs.renameSync(srcPath, path.join(dest, dst));
    }
  }

  // Move sprints/current.json
  const oldSprint = path.join(BASE_BOARD_DIR, 'sprints', 'current.json');
  if (fs.existsSync(oldSprint)) {
    fs.renameSync(oldSprint, path.join(dest, 'sprints', 'current.json'));
    // Remove old sprints dir if empty
    try { fs.rmdirSync(path.join(BASE_BOARD_DIR, 'sprints')); } catch (e) { /* not empty */ }
  }

  // Move history files
  const oldHistory = path.join(BASE_BOARD_DIR, 'history');
  if (fs.existsSync(oldHistory)) {
    for (const f of fs.readdirSync(oldHistory)) {
      fs.renameSync(path.join(oldHistory, f), path.join(dest, 'history', f));
    }
    try { fs.rmdirSync(oldHistory); } catch (e) { /* not empty */ }
  }

  // Move logs
  const oldLogs = path.join(BASE_BOARD_DIR, 'logs');
  if (fs.existsSync(oldLogs)) {
    for (const f of fs.readdirSync(oldLogs)) {
      fs.renameSync(path.join(oldLogs, f), path.join(dest, 'logs', f));
    }
    try { fs.rmdirSync(oldLogs); } catch (e) { /* not empty */ }
  }

  // Write config
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ activeProject: name }, null, 2));
  console.log(`  [migrate] Moved existing board into projects/${name}/`);
}

function initActiveProject() {
  migrateIfNeeded();

  // Read config for last active project
  let activeName = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    activeName = cfg.activeProject;
  } catch (e) { /* no config yet */ }

  // If projects dir exists, pick active or first available
  if (fs.existsSync(PROJECTS_DIR)) {
    const projects = fs.readdirSync(PROJECTS_DIR).filter(f =>
      fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory()
    );
    if (activeName && projects.includes(activeName)) {
      setActiveProject(activeName);
    } else if (projects.length > 0) {
      setActiveProject(projects[0]);
    }
  }

  // If no project loaded, create a default scaffold
  if (!ctx.projectName) {
    const name = 'MyProject';
    scaffoldProject(name);
    setActiveProject(name);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ activeProject: name }, null, 2));
  }
}

function scaffoldProject(name, spec, displayName, repoConfig) {
  const dir = path.join(PROJECTS_DIR, name);
  fs.mkdirSync(path.join(dir, 'sprints'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const boardData = {
    project: displayName || name,
    spec: spec || 'SPEC.md',
    tickets: [],
    nextId: 1,
  };
  if (repoConfig && repoConfig.url) {
    boardData.repo = {
      url: repoConfig.url,
      branch: repoConfig.branch || 'main',
      cloned: false,
    };
  }
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify(boardData, null, 2));
  fs.writeFileSync(path.join(dir, 'blackboard.md'), `# Blackboard — ${name}\n\nCross-cutting signals, findings, and decisions.\n`);
  fs.writeFileSync(path.join(dir, 'sprints', 'current.json'), JSON.stringify({
    sprint: 1,
    goal: '',
    status: 'planning',
    started: null,
    ended: null
  }, null, 2));
}

// ── Orchestrators (per-project) ──────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const orchestrators = new Map(); // Map<projectName, Orchestrator>

function sanitizeProjectName(name) {
  // Prevent path traversal — strip anything that isn't alphanumeric, dash, underscore, or space
  if (!name || typeof name !== 'string') return null;
  const clean = name.replace(/[^a-zA-Z0-9 _-]/g, '');
  if (!clean || clean !== name) return null; // reject if sanitization changed the input
  return clean;
}

function getOrCreateOrchestrator(projectName) {
  if (orchestrators.has(projectName)) return orchestrators.get(projectName);

  const projectDir = path.join(PROJECTS_DIR, projectName);
  // Safety: verify the resolved path is inside PROJECTS_DIR
  if (!path.resolve(projectDir).startsWith(path.resolve(PROJECTS_DIR))) {
    throw new Error(`Invalid project name: ${projectName}`);
  }
  const orch = new Orchestrator(PROJECT_ROOT, projectDir);

  // Forward orchestrator events to SSE with project tag
  orch.on('agent-update', data => broadcast('agent-update', { ...data, project: projectName }));
  orch.on('agent-output', data => broadcast('agent-output', { ...data, project: projectName }));
  orch.on('agent-blocked', data => broadcast('agent-blocked', { ...data, project: projectName }));
  orch.on('mode-change', data => broadcast('mode-change', { ...data, project: projectName }));
  orch.on('log', data => broadcast('orchestrator-log', { ...data, project: projectName }));
  orch.on('board-change', data => broadcast('state-update', { ...data, project: projectName }));
  orch.on('rate-limit', data => {
    broadcast('rate-limit', { ...data, project: projectName });
    // Cross-project rate limiting: stop ALL agents across ALL orchestrators
    for (const [otherName, otherOrch] of orchestrators) {
      if (otherName !== projectName) {
        otherOrch.stopAll();
        otherOrch.rateLimitState = { detected: true, resetInfo: data.resetInfo, at: data.at };
        otherOrch.addLog('error', `Rate limit detected on project "${projectName}" — stopping all agents (account-level limit)`);
      }
    }
  });

  orch.cleanupZombies();
  orchestrators.set(projectName, orch);
  return orch;
}

// Resolve orchestrator from request (query, body, or fallback to active project)
function orchFor(req) {
  const raw = req.query?.project || req.body?.project || ctx.projectName;
  const project = sanitizeProjectName(raw) || ctx.projectName;
  return getOrCreateOrchestrator(project);
}

// ── SSE Clients ─────────────────────────────────────────────────────────────
let sseClients = [];

function broadcast(event, data) {
  sseClients.forEach(res => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

// ── File Readers ────────────────────────────────────────────────────────────
function readJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function readText(filepath) {
  try {
    return fs.readFileSync(filepath, 'utf-8');
  } catch (e) {
    return '';
  }
}

function getFullState(projectName) {
  const pName = projectName || ctx.projectName;
  const pDir = path.join(PROJECTS_DIR, pName);
  const orch = getOrCreateOrchestrator(pName);
  const board = readJSON(path.join(pDir, 'board.json'));
  const schema = readJSON(SCHEMA_FILE);
  const sprint = readJSON(path.join(pDir, 'sprints', 'current.json'));
  const blackboard = readText(path.join(pDir, 'blackboard.md'));

  // Parse blackboard signals
  const signals = [];
  const signalRegex = /^## \[(\w+)\] (.+?) — (.+?) — (.+)$/gm;
  let match;
  while ((match = signalRegex.exec(blackboard)) !== null) {
    signals.push({ type: match[1], title: match[2], agent: match[3], time: match[4] });
  }

  // Derive agent statuses from board
  const agents = [
    { role: 'pm-agent', label: 'PM', status: 'idle', current: null },
    { role: 'dev-agent', label: 'DEV', status: 'waiting', current: null },
    { role: 'reviewer-agent', label: 'REV', status: 'waiting', current: null },
    { role: 'test-agent', label: 'QA', status: 'waiting', current: null },
  ];

  if (board && board.tickets) {
    board.tickets.forEach(t => {
      if (t.assignee) {
        const agent = agents.find(a => a.role === t.assignee);
        if (agent) {
          agent.status = t.status === 'blocked' || t.status === 'halted' ? 'blocked' : 'working';
          agent.current = t.id;
        }
      }
    });
  }

  // Check for halt
  const isHalted = blackboard.includes('[halt]');

  // Pipeline alerts: stages with work but no agent
  const alerts = [];
  if (board && board.tickets) {
    const devReady = board.tickets.filter(t => t.status === 'dev-ready' && !t.assignee);
    const reviewReady = board.tickets.filter(t => t.status === 'review-ready' && !t.assignee);
    const testReady = board.tickets.filter(t => t.status === 'test-ready' && !t.assignee);

    if (devReady.length > 0) alerts.push({ level: 'info', message: `${devReady.length} ticket(s) dev-ready — start /dev agent if not running` });
    if (reviewReady.length > 0) alerts.push({ level: 'warn', message: `${reviewReady.length} ticket(s) review-ready — start /reviewer agent if not running` });
    if (testReady.length > 0) alerts.push({ level: 'warn', message: `${testReady.length} ticket(s) test-ready — start /test agent if not running` });
    if (isHalted) alerts.push({ level: 'error', message: 'SPRINT HALTED — all agents should be stopped' });
  }

  // Merge orchestrator agent states (real process info) over board-derived statuses.
  // Orchestrator is the authoritative source for whether a process is actually running.
  const orchAgents = orch.getAgentStates();
  for (const a of agents) {
    const oa = orchAgents[a.role];
    if (oa) {
      if (oa.pid) {
        // Process is actually running — use orchestrator status
        a.status = oa.status === 'running' ? 'working' : oa.status;
        a.current = oa.current || a.current;
      } else if (oa.status === 'stopped' || oa.status === 'error' || oa.status === 'rate-limited' || oa.status === 'blocked') {
        // Explicit non-idle state from orchestrator overrides board-derived status
        a.status = oa.status;
      } else {
        // Process not running and orchestrator says idle — use board-derived status
        // but only if the board-derived status isn't "working" (stale assignee)
        if (a.status === 'working' && !oa.pid) {
          a.status = 'idle';
        }
      }
      a.pid = oa.pid;
      a.log = oa.log || [];
    }
  }

  return {
    board, schema, sprint, signals, agents, alerts, isHalted,
    rateLimited: orch.rateLimitState,
    raw_blackboard: blackboard,
    autoMode: orch.autoMode,
    orchestratorLog: orch.log.slice(-50),
    activeProject: pName,
    project: pName,
  };
}

// ── API Routes ──────────────────────────────────────────────────────────────

// Full state
app.get('/api/state', (req, res) => {
  res.json(getFullState());
});

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ── Human Actions ───────────────────────────────────────────────────────────

// Approve ticket (groomed → dev-ready)
app.post('/api/actions/approve', (req, res) => {
  const orch = orchFor(req);
  const { ticketId } = req.body;
  const board = readJSON(orch.boardPath);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  const ticket = board.tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: `Ticket ${ticketId} not found` });
  if (ticket.status !== 'groomed') return res.status(400).json({ error: `Ticket is ${ticket.status}, not groomed` });

  ticket.status = 'dev-ready';
  ticket.history.push({
    from: 'groomed',
    to: 'dev-ready',
    by: 'human',
    at: new Date().toISOString(),
    note: 'Approved by human via dashboard'
  });
  board.last_updated = new Date().toISOString();

  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));
  writeHistoryTo(orch.historyDir, ticketId, 'groomed', 'dev-ready', 'Approved by human via dashboard');
  res.json({ ok: true, ticket });
});

// Block ticket
app.post('/api/actions/block', (req, res) => {
  const orch = orchFor(req);
  const { ticketId, reason } = req.body;
  const board = readJSON(orch.boardPath);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  const ticket = board.tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: `Ticket ${ticketId} not found` });

  const prevStatus = ticket.status;
  ticket.status = 'blocked';
  ticket.history.push({
    from: prevStatus,
    to: 'blocked',
    by: 'human',
    at: new Date().toISOString(),
    note: `Blocked by human: ${reason || 'No reason given'}`
  });
  board.last_updated = new Date().toISOString();

  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));

  // Also post to blackboard
  const signal = `\n## [blocker] ${ticket.title} blocked — human — ${new Date().toISOString()}\n${reason || 'Blocked via dashboard'}\nAffects: ${ticketId}\n`;
  fs.appendFileSync(orch.blackboardPath, signal);

  writeHistoryTo(orch.historyDir, ticketId, prevStatus, 'blocked', `Blocked by human: ${reason}`);
  res.json({ ok: true, ticket });
});

// Halt sprint
app.post('/api/actions/halt', (req, res) => {
  const orch = orchFor(req);
  const { reason } = req.body;
  const board = readJSON(path.join(orch.projectDir, 'board.json'));
  const sprint = readJSON(path.join(orch.projectDir, 'sprints', 'current.json'));
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  const haltedTickets = [];
  const previousStates = {};

  board.tickets.forEach(t => {
    if (['in-dev', 'in-review', 'in-test', 'review-ready', 'test-ready'].includes(t.status)) {
      previousStates[t.id] = t.status;
      t.status = 'halted';
      t.history.push({
        from: previousStates[t.id],
        to: 'halted',
        by: 'human',
        at: new Date().toISOString(),
        note: `Sprint halted: ${reason || 'No reason given'}`
      });
      haltedTickets.push(t.id);
    }
  });
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));

  // Post halt signal
  const signal = `\n## [halt] SPRINT HALTED — human — ${new Date().toISOString()}\n${reason || 'Halted via dashboard'}\nAll agents must stop. Do not pick new work.\nAffects: ALL TICKETS\n`;
  fs.appendFileSync(orch.blackboardPath, signal);

  // Update sprint status
  if (sprint) {
    sprint.status = 'halted';
    fs.writeFileSync(orch.sprintPath, JSON.stringify(sprint, null, 2));
  }

  // History
  const haltHistory = {
    type: 'halt',
    by: 'human',
    at: new Date().toISOString(),
    reason: reason || 'Halted via dashboard',
    tickets_halted: haltedTickets,
    previous_states: previousStates
  };
  const histFile = path.join(orch.historyDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-sprint-halted.json`);
  fs.writeFileSync(histFile, JSON.stringify(haltHistory, null, 2));

  // Stop all orchestrator agents
  orch.stopAll();

  res.json({ ok: true, halted: haltedTickets, previousStates });
});

// Post signal to blackboard
app.post('/api/actions/signal', (req, res) => {
  const orch = orchFor(req);
  const { type, title, detail, affects } = req.body;
  const signal = `\n## [${type}] ${title} — human — ${new Date().toISOString()}\n${detail || ''}\nAffects: ${affects || 'N/A'}\n`;
  fs.appendFileSync(orch.blackboardPath, signal);
  res.json({ ok: true });
});

// Resume from halt
app.post('/api/actions/resume', (req, res) => {
  const orch = orchFor(req);
  const board = readJSON(orch.boardPath);
  const sprint = readJSON(orch.sprintPath);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  // Find the most recent halt history to get previous states
  const histFiles = fs.readdirSync(orch.historyDir).filter(f => f.includes('sprint-halted')).sort().reverse();
  let previousStates = {};
  if (histFiles.length > 0) {
    const haltData = readJSON(path.join(orch.historyDir, histFiles[0]));
    if (haltData) previousStates = haltData.previous_states || {};
  }

  board.tickets.forEach(t => {
    if (t.status === 'halted') {
      const restoreTo = previousStates[t.id] || 'dev-ready';
      t.status = restoreTo;
      t.history.push({
        from: 'halted',
        to: restoreTo,
        by: 'human',
        at: new Date().toISOString(),
        note: 'Sprint resumed by human via dashboard'
      });
    }
  });
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));

  if (sprint) {
    sprint.status = 'active';
    fs.writeFileSync(orch.sprintPath, JSON.stringify(sprint, null, 2));
  }

  // Remove halt from blackboard
  let bb = readText(orch.blackboardPath);
  bb = bb.replace(/\n## \[halt\][\s\S]*?(?=\n## \[|$)/g, '');
  fs.writeFileSync(orch.blackboardPath, bb);

  // Clear rate limit flag and reset agent statuses
  // Note: 'stopped' agents stay stopped — only manual start clears that
  orch.rateLimitState = { detected: false, resetInfo: null };
  for (const role of Object.keys(orch.agents)) {
    if (orch.agents[role].status === 'rate-limited') {
      orch.agents[role].status = 'idle';
    }
  }

  // Resume does NOT auto-enable dispatch — user controls that separately

  res.json({ ok: true });
});

// Clear rate limit flag (without resuming halted tickets) — clears ALL orchestrators
app.post('/api/actions/clear-rate-limit', (req, res) => {
  for (const [, o] of orchestrators) {
    o.rateLimitState = { detected: false, resetInfo: null };
    for (const role of Object.keys(o.agents)) {
      if (o.agents[role].status === 'rate-limited') {
        o.agents[role].status = 'idle';
      }
    }
    o.addLog('info', 'Rate limit cleared by human');
    o.emit('agent-update', o.getAgentStates());
    if (o.autoMode) o.evaluateAndDispatch();
  }
  res.json({ ok: true });
});

// Move ticket to any valid status (human override)
app.post('/api/actions/move-ticket', (req, res) => {
  const orch = orchFor(req);
  const { ticketId, toStatus, note } = req.body;
  if (!ticketId || !toStatus) return res.status(400).json({ error: 'ticketId and toStatus are required' });

  const board = readJSON(orch.boardPath);
  const schema = readJSON(SCHEMA_FILE);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });
  if (!schema) return res.status(500).json({ error: 'Cannot read schema.json' });

  const ticket = board.tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: `Ticket ${ticketId} not found` });

  if (!schema.valid_statuses.includes(toStatus)) {
    return res.status(400).json({ error: `Invalid status: ${toStatus}` });
  }

  const fromStatus = ticket.status;
  const { stopAgent: shouldStopAgent } = req.body;

  // If an agent is actively working on this ticket, stop it first
  if (ticket.assignee && shouldStopAgent) {
    orch.stopAgent(ticket.assignee);
    orch.addLog('info', `Stopped ${ticket.assignee} — human moved ${ticketId} from ${fromStatus} to ${toStatus}`);
  }

  // Human has full override — can move to any valid status
  ticket.status = toStatus;
  if (['new', 'groomed', 'dev-ready', 'review-ready', 'test-ready', 'changes-requested'].includes(toStatus)) {
    ticket.assignee = null;
  }
  ticket.history.push({
    from: fromStatus,
    to: toStatus,
    by: 'human',
    at: new Date().toISOString(),
    note: note || 'Moved via dashboard'
  });
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));
  writeHistoryTo(orch.historyDir, ticketId, fromStatus, toStatus, note || 'Moved via dashboard');

  res.json({ ok: true, ticket });
});

// Reset sprint (back to planning)
app.post('/api/actions/reset-sprint', (req, res) => {
  const orch = orchFor(req);
  const board = readJSON(orch.boardPath);
  const sprint = readJSON(orch.sprintPath);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });
  if (!sprint) return res.status(500).json({ error: 'Cannot read sprint file' });

  orch.stopAll();

  const reverted = [];
  const revertableStatuses = [
    'dev-ready', 'in-dev', 'review-ready', 'in-review',
    'test-ready', 'in-test', 'changes-requested'
  ];
  board.tickets.forEach(t => {
    if (revertableStatuses.includes(t.status)) {
      const fromStatus = t.status;
      t.status = 'groomed';
      t.assignee = null;
      t.history.push({
        from: fromStatus,
        to: 'groomed',
        by: 'human',
        at: new Date().toISOString(),
        note: 'Reverted via sprint reset'
      });
      reverted.push(t.id);
      writeHistoryTo(orch.historyDir, t.id, fromStatus, 'groomed', 'Reverted via sprint reset');
    }
  });
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));

  sprint.status = 'planning';
  fs.writeFileSync(orch.sprintPath, JSON.stringify(sprint, null, 2));

  orch.addLog('info', `Sprint reset to planning — ${reverted.length} tickets reverted to groomed`);
  res.json({ ok: true, reverted });
});

// Reprioritize
app.post('/api/actions/reprioritize', (req, res) => {
  const orch = orchFor(req);
  const { ticketId, priority } = req.body;
  const board = readJSON(orch.boardPath);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  const ticket = board.tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: `Ticket ${ticketId} not found` });

  const prev = ticket.priority;
  ticket.priority = priority;
  ticket.history.push({
    from: prev,
    to: priority,
    by: 'human',
    at: new Date().toISOString(),
    note: `Priority changed from ${prev} to ${priority} via dashboard`
  });
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));
  res.json({ ok: true, ticket });
});

// ── Orchestrator Endpoints ──────────────────────────────────────────────────

// Start sprint: planning → active, auto-approve groomed tickets, enable dispatch
app.post('/api/actions/start-sprint', (req, res) => {
  const orch = orchFor(req);
  const sprint = readJSON(orch.sprintPath);
  if (!sprint) return res.status(500).json({ error: 'Cannot read sprint file' });
  if (sprint.status !== 'planning') return res.status(400).json({ error: `Sprint is ${sprint.status}, not planning` });

  // Move sprint to active
  sprint.status = 'active';
  fs.writeFileSync(orch.sprintPath, JSON.stringify(sprint, null, 2));

  // Auto-approve all groomed tickets
  const board = readJSON(orch.boardPath);
  const approved = [];
  if (board) {
    board.tickets.forEach(t => {
      if (t.status === 'groomed') {
        t.status = 'dev-ready';
        t.history.push({
          from: 'groomed',
          to: 'dev-ready',
          by: 'human',
          at: new Date().toISOString(),
          note: 'Auto-approved via Start Sprint'
        });
        approved.push(t.id);
        writeHistoryTo(orch.historyDir, t.id, 'groomed', 'dev-ready', 'Auto-approved via Start Sprint');
      }
    });
    board.last_updated = new Date().toISOString();
    fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));
  }

  // Enable auto-dispatch
  orch.startAutoMode();
  orch.addLog('success', `Sprint started — ${approved.length} tickets auto-approved`);

  res.json({ ok: true, approved });
});

// Start a specific agent (manual = true so it clears 'stopped' status)
app.post('/api/actions/agents/:role/start', async (req, res) => {
  const orch = orchFor(req);
  const { role } = req.params;
  if (!orch.agents[role]) return res.status(404).json({ error: `Unknown agent role: ${role}` });

  const started = await orch.startAgent(role, { manual: true });
  res.json({ ok: started, agent: orch.getAgentStates()[role] });
});

// Stop a specific agent
app.post('/api/actions/agents/:role/stop', (req, res) => {
  const orch = orchFor(req);
  const { role } = req.params;
  if (!orch.agents[role]) return res.status(404).json({ error: `Unknown agent role: ${role}` });

  const stopped = orch.stopAgent(role);
  res.json({ ok: stopped, agent: orch.getAgentStates()[role] });
});

// Toggle auto-dispatch
app.post('/api/actions/dispatch/toggle', (req, res) => {
  const orch = orchFor(req);
  if (orch.autoMode) {
    orch.stopAutoMode();
  } else {
    orch.startAutoMode();
  }
  res.json({ ok: true, autoMode: orch.autoMode });
});

// Get full agent log from disk
app.get('/api/agents/:role/log', (req, res) => {
  const orch = orchFor(req);
  const { role } = req.params;
  const logFile = path.join(orch.logsDir, `${role}.log`);
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch (e) { return { text: l, at: new Date().toISOString() }; }
    });
    res.json({ role, lines, total: lines.length });
  } catch (e) {
    res.json({ role, lines: [], total: 0 });
  }
});

// Get agent states
app.get('/api/agents', (req, res) => {
  const orch = orchFor(req);
  res.json({
    agents: orch.getAgentStates(),
    autoMode: orch.autoMode,
    log: orch.log.slice(-50),
  });
});

// Create a new ticket
app.post('/api/actions/create-ticket', (req, res) => {
  const orch = orchFor(req);
  const { title, type, priority, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const board = readJSON(orch.boardPath);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  // Generate next ticket ID
  const existingIds = board.tickets.map(t => {
    const m = t.id.match(/TICKET-(\d+)/);
    return m ? parseInt(m[1]) : 0;
  });
  const nextNum = Math.max(0, ...existingIds) + 1;
  const ticketId = `TICKET-${String(nextNum).padStart(3, '0')}`;

  const newTicket = {
    id: ticketId,
    title: title,
    type: type || 'feature',
    priority: priority || 'medium',
    status: 'new',
    complexity: 'M',
    description: description || '',
    acceptance_criteria: [],
    dev_notes: '',
    depends_on: [],
    assignee: null,
    history: [{
      from: null,
      to: 'new',
      by: 'human',
      at: new Date().toISOString(),
      note: 'Created via dashboard'
    }]
  };

  board.tickets.push(newTicket);
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));

  writeHistoryTo(orch.historyDir, ticketId, 'none', 'new', 'Created via dashboard');
  orch.addLog('info', `New ticket created: ${ticketId} — ${title}`);

  res.json({ ok: true, ticket: newTicket });
});

// ── Project Management Endpoints ─────────────────────────────────────────────

// List all projects
app.get('/api/projects', (req, res) => {
  if (!fs.existsSync(PROJECTS_DIR)) return res.json({ projects: [] });
  const dirs = fs.readdirSync(PROJECTS_DIR).filter(f =>
    fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory()
  );
  const projects = dirs.map(name => {
    const boardPath = path.join(PROJECTS_DIR, name, 'board.json');
    const sprintPath = path.join(PROJECTS_DIR, name, 'sprints', 'current.json');
    const board = readJSON(boardPath);
    const sprint = readJSON(sprintPath);
    // Include live agent info if orchestrator exists
    const orch = orchestrators.get(name);
    const activeAgents = orch
      ? Object.values(orch.agents).filter(a => a.process).length
      : 0;
    return {
      name,
      displayName: board?.project || name,
      ticketCount: board?.tickets?.length || 0,
      sprintStatus: sprint?.status || 'unknown',
      active: name === ctx.projectName,
      activeAgents,
      autoMode: orch?.autoMode || false,
    };
  });
  res.json({ projects });
});

// Switch active project (UI context only — does NOT stop agents on any project)
app.post('/api/projects/switch', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const projectDir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: `Project "${name}" not found` });

  setActiveProject(name);
  getOrCreateOrchestrator(name); // ensure orchestrator exists
  startWatcher();

  // Persist to config
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ activeProject: name }, null, 2));

  const state = getFullState(name);
  broadcast('state-update', { ...state, project: name });
  broadcast('project-switch', { name });
  res.json({ ok: true, activeProject: name });
});

// Create a new project
app.post('/api/projects/create', (req, res) => {
  const { name, spec, specContent, repoUrl, repoBranch } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Project name must be alphanumeric (spaces, dashes, underscores allowed)' });
  const slug = name.replace(/\s+/g, '-');
  const projectDir = path.join(PROJECTS_DIR, slug);
  if (fs.existsSync(projectDir)) return res.status(409).json({ error: `Project "${name}" already exists` });

  const repoConfig = repoUrl ? { url: repoUrl.trim(), branch: (repoBranch || 'main').trim() } : null;
  scaffoldProject(slug, spec, name, repoConfig);

  // If spec content was pasted or uploaded, save it as SPEC.md in the project folder
  if (specContent) {
    const specPath = path.join(projectDir, 'SPEC.md');
    fs.writeFileSync(specPath, specContent);
  }

  res.json({ ok: true, name: slug });
});

// Set or update repo config for a project
app.post('/api/projects/repo', (req, res) => {
  const { repoUrl, repoBranch } = req.body;
  const orch = orchFor(req);
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  const board = orch.readBoard();
  board.repo = {
    url: repoUrl.trim(),
    branch: (repoBranch || 'main').trim(),
    cloned: false,
  };
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(orch.boardPath, JSON.stringify(board, null, 2));

  orch.addLog('info', `Repo configured: ${repoUrl}`);
  res.json({ ok: true, repo: board.repo });
});

// Get repo config for a project
app.get('/api/projects/repo', (req, res) => {
  const orch = orchFor(req);
  const board = orch.readBoard();
  res.json({ repo: board.repo || null, project: orch.projectName });
});

// ── PM Chat ─────────────────────────────────────────────────────────────────

const chatProcesses = new Map(); // Map<projectName, pty process> — per-project chat processes

function getChatFile(project) {
  const pName = sanitizeProjectName(project) || ctx.projectName;
  const pDir = path.join(PROJECTS_DIR, pName);
  return path.join(pDir, 'chat.json');
}

function readChatHistory(project) {
  try {
    return JSON.parse(fs.readFileSync(getChatFile(project), 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveChatHistory(messages, project) {
  fs.writeFileSync(getChatFile(project), JSON.stringify(messages, null, 2));
}

function stripAnsi(text) {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\(B/g, '')
    .replace(/\x1B[=>]/g, '')
    .replace(/\x1B\[[\x20-\x3F]*[\x40-\x7E]/g, '')
    .replace(/\r/g, '');
}

function cleanFinalResponse(text) {
  return stripAnsi(text)
    .replace(/\x1B.*$/s, '')
    .replace(/\[<[a-zA-Z]?$/s, '')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

function buildChatPrompt(history, newMessage, targetProject) {
  const pName = targetProject || ctx.projectName;
  const pDir = path.join(PROJECTS_DIR, pName);
  const board = readJSON(path.join(pDir, 'board.json'));
  const projectName = board?.project || pName || 'Unknown';
  const existingSpec = board?.spec || 'SPEC.md';
  let specContent = '';
  const specPath = path.join(pDir, existingSpec);
  if (fs.existsSync(specPath)) {
    try { specContent = fs.readFileSync(specPath, 'utf-8'); } catch (e) { /* ignore */ }
  }

  // Build ticket summary for board context
  const tickets = board?.tickets || [];
  let ticketSummary = '';
  if (tickets.length > 0) {
    ticketSummary = '\nCurrent board tickets:\n';
    tickets.forEach(t => {
      ticketSummary += `- ${t.id}: ${t.title} [${t.status}] (${t.priority})${t.assignee ? ' assigned:' + t.assignee : ''}\n`;
    });
  }

  let prompt = `You are a PM agent helping manage the project "${projectName}". You are having an interactive conversation with a human.

Your responsibilities:
- Help design and refine project specs
- Help organize ideas into a clear spec structure
- Answer questions about the board, tickets, and sprint status
- Suggest ticket actions when appropriate (move tickets, create tickets)
- Keep responses concise and focused
- Use markdown formatting in your responses

TECHNOLOGY & ARCHITECTURE DISCUSSION:
When helping design a new project or refine a spec, you MUST proactively discuss technology choices:
- Ask what kind of application (web app, API, CLI, mobile, full-stack, etc.)
- Discuss which layers are needed (UI, API, service, database) — not all projects need all
- For each layer, recommend a tech stack with rationale (e.g., "React for UI because..." or "FastAPI for backend because...")
- Present 2-3 options when there are genuine trade-offs, with pros/cons
- Ask the user to confirm or override your recommendations
- If the user has preferences (e.g., "I want to use Go"), respect them and adapt the architecture
- Document ALL technology decisions in the spec under a "## Technology Stack" section

SPEC STRUCTURE:
When generating a spec, follow this structure:
\`\`\`
# Project Name

## Overview
Brief description of what the project does and who it's for.

## Technology Stack
| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React + TypeScript | ... |
| Backend | Node.js + Express | ... |
| Database | PostgreSQL | ... |
| Deployment | Docker | ... |

## Architecture
High-level architecture description and key components.

Include a mermaid diagram showing major components and data flow:
\\\`\\\`\\\`mermaid
graph TB
  subgraph "Frontend"
    UI[React App]
  end
  subgraph "Backend"
    API[Express API]
    DB[(PostgreSQL)]
  end
  UI -->|REST| API
  API --> DB
\\\`\\\`\\\`

## Features
### Feature 1: Title
Description and acceptance criteria.

### Feature 2: Title
Description and acceptance criteria.

## Data Model
Key entities and relationships (if database is needed).

## API Design
Key endpoints (if API layer exists).

## Non-Functional Requirements
Performance, security, scalability considerations.
\`\`\`

DESIGN-FIRST WORKFLOW:
When creating a new project spec, follow this phased approach:
1. **Discovery** — Ask about the project idea, goals, users, constraints
2. **Technology Discussion** — Discuss and agree on tech stack with rationale
3. **Architecture Design** — Present an architecture diagram (mermaid) showing components, layers, and data flow. Ask the human to approve the architecture BEFORE moving on.
4. **Feature Definition** — Once architecture is approved, define features with acceptance criteria
5. **Spec Generation** — Output the complete spec in a \`\`\`spec block

IMPORTANT: Do NOT skip the architecture discussion. The human must approve the high-level design before you generate tickets. This prevents wasted work from building on a wrong foundation.

When you generate a spec, output it in a markdown code block tagged as \`\`\`spec so the system can detect it. Also include a project name suggestion on a separate line before the spec block like: PROJECT_NAME: My New Project

GIT REPOSITORY:
If the user wants agents to push code to their own repository, ask for:
- Git repo URL (HTTPS or SSH, e.g., https://github.com/user/repo.git)
- Default branch name (usually "main")
The system will handle authentication separately. Include the repo URL in the spec if provided:
REPO_URL: https://github.com/user/repo.git
REPO_BRANCH: main

BOARD ACTIONS:
You can suggest board actions that the user can confirm. Output them on their own line in this exact format:
ACTION: {"type":"move-ticket","project":"${pName}","ticketId":"TICKET-001","toStatus":"dev-ready","note":"Reason for move"}
ACTION: {"type":"create-ticket","project":"${pName}","title":"Ticket title","priority":"high","description":"Details"}

Rules for actions:
- Always explain WHY you're suggesting an action before outputting the ACTION line
- For destructive actions (blocking, halting), always ask the user to confirm first
- You can suggest multiple actions in one response
- The user will see a confirmation button — the action only executes when they confirm
${ticketSummary}`;

  if (specContent) {
    prompt += `\nThe current project already has an existing spec:\n\`\`\`\n${specContent.substring(0, 3000)}\n\`\`\`\n\nThe user may want to refine this spec OR start something new.\n`;
  }

  if (history.length > 0) {
    prompt += '\nConversation so far:\n';
    for (const msg of history) {
      const role = msg.role === 'user' ? 'Human' : 'PM';
      prompt += `${role}: ${msg.text}\n\n`;
    }
  }

  prompt += `Human: ${newMessage}\n\nRespond as the PM agent. Be helpful and concise.`;
  return prompt;
}

// Get chat history
app.get('/api/chat/history', (req, res) => {
  const project = req.query.project || ctx.projectName;
  res.json({ messages: readChatHistory(project), project });
});

// Clear chat history
app.post('/api/chat/clear', (req, res) => {
  const project = req.body.project || ctx.projectName;
  const existing = chatProcesses.get(project);
  if (existing) {
    try { existing.kill(); } catch (e) { /* ignore */ }
    chatProcesses.delete(project);
  }
  saveChatHistory([], project);
  res.json({ ok: true });
});

// Send chat message — streams response via SSE
app.post('/api/chat/send', (req, res) => {
  const { message } = req.body;
  const project = req.body.project || ctx.projectName;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  // Kill any existing chat process for THIS project only
  const existingProc = chatProcesses.get(project);
  if (existingProc) {
    try { existingProc.kill(); } catch (e) { /* ignore */ }
    chatProcesses.delete(project);
  }

  const history = readChatHistory(project);
  history.push({ role: 'user', text: message.trim(), at: new Date().toISOString() });
  saveChatHistory(history, project);

  const pDir = path.join(PROJECTS_DIR, project);
  const logsDir = path.join(pDir, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) { /* exists */ }

  const prompt = buildChatPrompt(history.slice(0, -1), message.trim(), project);
  const promptFile = path.join(logsDir, 'chat-prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const launcherPath = path.join(__dirname, 'launch-chat.py');
  const proc = pty.spawn('python3', [launcherPath, promptFile], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: PROJECT_ROOT,
    env: cleanEnv,
  });

  chatProcesses.set(project, proc);
  let fullResponse = '';

  proc.onData((raw) => {
    const text = stripAnsi(raw);
    fullResponse += text;
    broadcast('chat-response', { project, chunk: text, done: false });
  });

  proc.onExit(({ exitCode }) => {
    chatProcesses.delete(project);
    const cleanResponse = cleanFinalResponse(fullResponse);
    if (cleanResponse) {
      history.push({ role: 'pm', text: cleanResponse, at: new Date().toISOString() });
      saveChatHistory(history, project);

      const specMatch = cleanResponse.match(/```spec\n([\s\S]*?)```/);
      if (specMatch) {
        const nameMatch = cleanResponse.match(/PROJECT_NAME:\s*(.+)/);
        const suggestedName = nameMatch ? nameMatch[1].trim() : null;
        broadcast('chat-response', { project, chunk: '', done: true, hasSpec: true, spec: specMatch[1], suggestedName });
      } else {
        broadcast('chat-response', { project, chunk: '', done: true });
      }
    } else {
      broadcast('chat-response', { project, chunk: '', done: true, error: exitCode !== 0 });
    }
  });

  res.json({ ok: true, streaming: true });
});

// Execute a confirmed chat action (move-ticket, create-ticket)
app.post('/api/chat/action', (req, res) => {
  const { action } = req.body;
  if (!action || !action.type) return res.status(400).json({ error: 'Action with type is required' });

  const project = sanitizeProjectName(action.project) || ctx.projectName;
  const pDir = path.join(PROJECTS_DIR, project);
  const boardPath = path.join(pDir, 'board.json');
  const historyDir = path.join(pDir, 'history');
  const board = readJSON(boardPath);
  if (!board) return res.status(500).json({ error: `Cannot read board for project "${project}"` });

  if (action.type === 'move-ticket') {
    const ticket = board.tickets.find(t => t.id === action.ticketId);
    if (!ticket) return res.status(404).json({ error: `Ticket ${action.ticketId} not found` });

    const fromStatus = ticket.status;
    ticket.status = action.toStatus;
    if (['new', 'groomed', 'dev-ready', 'review-ready', 'test-ready', 'changes-requested'].includes(action.toStatus)) {
      ticket.assignee = null;
    }
    ticket.history.push({
      from: fromStatus,
      to: action.toStatus,
      by: 'human-via-chat',
      at: new Date().toISOString(),
      note: action.note || 'Moved via PM chat action'
    });
    board.last_updated = new Date().toISOString();
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
    writeHistoryTo(historyDir, action.ticketId, fromStatus, action.toStatus, action.note || 'Moved via PM chat action');
    res.json({ ok: true, ticket });

  } else if (action.type === 'create-ticket') {
    const existingIds = board.tickets.map(t => {
      const m = t.id.match(/TICKET-(\d+)/);
      return m ? parseInt(m[1]) : 0;
    });
    const nextNum = Math.max(0, ...existingIds) + 1;
    const ticketId = `TICKET-${String(nextNum).padStart(3, '0')}`;

    const newTicket = {
      id: ticketId,
      title: action.title || 'Untitled',
      type: action.ticketType || 'feature',
      priority: action.priority || 'medium',
      status: 'new',
      complexity: 'M',
      description: action.description || '',
      acceptance_criteria: [],
      dev_notes: '',
      depends_on: [],
      assignee: null,
      history: [{
        from: null,
        to: 'new',
        by: 'human-via-chat',
        at: new Date().toISOString(),
        note: 'Created via PM chat action'
      }]
    };

    board.tickets.push(newTicket);
    board.last_updated = new Date().toISOString();
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
    writeHistoryTo(historyDir, ticketId, 'none', 'new', 'Created via PM chat action');
    res.json({ ok: true, ticket: newTicket });

  } else {
    res.status(400).json({ error: `Unknown action type: ${action.type}` });
  }
});

// Save spec from chat — optionally creates a new project
app.post('/api/chat/save-spec', (req, res) => {
  const { spec, projectName: newProjectName, repoUrl, repoBranch } = req.body;
  if (!spec) return res.status(400).json({ error: 'Spec content is required' });

  // Parse REPO_URL and REPO_BRANCH from spec text (PM chat may embed them)
  let detectedRepoUrl = repoUrl || null;
  let detectedRepoBranch = repoBranch || null;
  const repoUrlMatch = spec.match(/^REPO_URL:\s*(.+)$/m);
  const repoBranchMatch = spec.match(/^REPO_BRANCH:\s*(.+)$/m);
  if (repoUrlMatch && !detectedRepoUrl) detectedRepoUrl = repoUrlMatch[1].trim();
  if (repoBranchMatch && !detectedRepoBranch) detectedRepoBranch = repoBranchMatch[1].trim();

  // Clean REPO_URL/REPO_BRANCH lines from the spec content before saving
  let cleanSpec = spec
    .replace(/^REPO_URL:\s*.+$/m, '')
    .replace(/^REPO_BRANCH:\s*.+$/m, '')
    .replace(/^\n{3,}/gm, '\n\n')
    .trim();

  let targetDir = ctx.projectDir;

  if (newProjectName && newProjectName.trim()) {
    const name = newProjectName.trim();
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Invalid project name' });
    const slug = name.replace(/\s+/g, '-');
    const projectDir = path.join(PROJECTS_DIR, slug);
    const repoConfig = detectedRepoUrl ? { url: detectedRepoUrl, branch: detectedRepoBranch || 'main' } : null;
    if (!fs.existsSync(projectDir)) {
      scaffoldProject(slug, 'SPEC.md', name, repoConfig);
    }
    targetDir = projectDir;

    setActiveProject(slug);
    getOrCreateOrchestrator(slug);
    startWatcher();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ activeProject: slug }, null, 2));
    broadcast('project-switch', { name: slug });
  }

  const specPath = path.join(targetDir, 'SPEC.md');
  fs.writeFileSync(specPath, cleanSpec);

  const board = readJSON(path.join(targetDir, 'board.json'));
  if (board) {
    board.spec = 'SPEC.md';
    // Update repo config if detected from spec or passed explicitly
    if (detectedRepoUrl) {
      board.repo = {
        url: detectedRepoUrl,
        branch: detectedRepoBranch || board.repo?.branch || 'main',
        cloned: board.repo?.cloned || false,
      };
    }
    fs.writeFileSync(path.join(targetDir, 'board.json'), JSON.stringify(board, null, 2));
  }

  res.json({ ok: true, project: ctx.projectName, repo: detectedRepoUrl || null });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function writeHistoryTo(historyDir, ticketId, from, to, note) {
  const entry = {
    ticket: ticketId,
    from, to,
    by: 'human',
    at: new Date().toISOString(),
    note
  };
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${ticketId}-${to}.json`;
  fs.writeFileSync(path.join(historyDir, filename), JSON.stringify(entry, null, 2) + '\n');
}

// ── File Watcher ────────────────────────────────────────────────────────────
let watcher = null;

function startWatcher() {
  if (watcher) { watcher.close(); }
  watcher = chokidar.watch(ctx.projectDir, {
    persistent: true,
    ignoreInitial: true,
    ignored: ['**/logs/**', '**/*.log'],  // Agent logs handled via SSE, not file watch
    awaitWriteFinish: { stabilityThreshold: 500 },
  });

  // Debounce file-watch broadcasts — coalesce rapid file changes into one update
  let watchDebounce = null;
  watcher.on('all', (event, filepath) => {
    console.log(`[watch] ${event}: ${path.relative(ctx.projectDir, filepath)}`);
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      const state = getFullState(ctx.projectName);
      broadcast('state-update', { ...state, project: ctx.projectName });

      // Log pipeline alerts
      state.alerts.forEach(a => {
        if (a.level === 'warn' || a.level === 'error') {
          console.log(`[ALERT] ${a.message}`);
        }
      });

      // In auto mode, check if there's new work to dispatch
      const watchOrch = orchestrators.get(ctx.projectName);
      if (watchOrch && watchOrch.autoMode) {
        watchOrch.evaluateAndDispatch();
      }
    }, 30000);  // 30s debounce on file watch
  });
}

// ── Serve Dashboard ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Start ───────────────────────────────────────────────────────────────────

// Initialize project context, migrate if needed, start watcher
initActiveProject();
getOrCreateOrchestrator(ctx.projectName);
startWatcher();

app.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  SwarmBoard Dashboard                         │');
  console.log(`  │  http://localhost:${PORT}                      │`);
  console.log('  │                                              │');
  console.log(`  │  Project: ${(ctx.projectName || '').padEnd(35)}│`);
  console.log(`  │  Watching: ${path.relative(process.cwd(), ctx.projectDir).padEnd(33)}│`);
  console.log('  │  Agents coordinate via board.json            │');
  console.log('  │  You control via this dashboard              │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');

  // Initial state check
  const state = getFullState();
  if (state.alerts.length > 0) {
    console.log('  Current alerts:');
    state.alerts.forEach(a => console.log(`    ${a.level === 'error' ? '🛑' : '⚠️ '} ${a.message}`));
    console.log('');
  }
});
