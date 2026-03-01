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

function scaffoldProject(name, spec, displayName) {
  const dir = path.join(PROJECTS_DIR, name);
  fs.mkdirSync(path.join(dir, 'sprints'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({
    project: displayName || name,
    spec: spec || 'SPEC.md',
    tickets: [],
    nextId: 1
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'blackboard.md'), `# Blackboard — ${name}\n\nCross-cutting signals, findings, and decisions.\n`);
  fs.writeFileSync(path.join(dir, 'sprints', 'current.json'), JSON.stringify({
    sprint: 1,
    goal: '',
    status: 'planning',
    started: null,
    ended: null
  }, null, 2));
}

// ── Orchestrator ────────────────────────────────────────────────────────────
const orch = new Orchestrator(path.resolve(__dirname, '..'));

// Forward orchestrator events to SSE
orch.on('agent-update', data => broadcast('agent-update', data));
orch.on('agent-output', data => broadcast('agent-output', data));
orch.on('agent-blocked', data => broadcast('agent-blocked', data));
orch.on('mode-change', data => broadcast('mode-change', data));
orch.on('log', data => broadcast('orchestrator-log', data));
orch.on('board-change', data => broadcast('state-update', data));
orch.on('rate-limit', data => broadcast('rate-limit', data));

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

function getFullState() {
  const board = readJSON(ctx.boardFile);
  const schema = readJSON(SCHEMA_FILE);
  const sprint = readJSON(ctx.sprintFile);
  const blackboard = readText(ctx.blackboardFile);

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

  // Merge orchestrator agent states (real process info) over board-derived statuses
  const orchAgents = orch.getAgentStates();
  for (const a of agents) {
    const oa = orchAgents[a.role];
    if (oa) {
      // Orchestrator has authoritative process state
      if (oa.status !== 'idle' || oa.current) {
        a.status = oa.status === 'running' ? 'working' : oa.status;
        a.current = oa.current || a.current;
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
    activeProject: ctx.projectName,
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
  const { ticketId } = req.body;
  const board = readJSON(ctx.boardFile);
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

  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));
  writeHistory(ticketId, 'groomed', 'dev-ready', 'Approved by human via dashboard');
  res.json({ ok: true, ticket });
});

// Block ticket
app.post('/api/actions/block', (req, res) => {
  const { ticketId, reason } = req.body;
  const board = readJSON(ctx.boardFile);
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

  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));

  // Also post to blackboard
  const signal = `\n## [blocker] ${ticket.title} blocked — human — ${new Date().toISOString()}\n${reason || 'Blocked via dashboard'}\nAffects: ${ticketId}\n`;
  fs.appendFileSync(ctx.blackboardFile, signal);

  writeHistory(ticketId, prevStatus, 'blocked', `Blocked by human: ${reason}`);
  res.json({ ok: true, ticket });
});

// Halt sprint
app.post('/api/actions/halt', (req, res) => {
  const { reason } = req.body;
  const board = readJSON(ctx.boardFile);
  const sprint = readJSON(ctx.sprintFile);
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
  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));

  // Post halt signal
  const signal = `\n## [halt] SPRINT HALTED — human — ${new Date().toISOString()}\n${reason || 'Halted via dashboard'}\nAll agents must stop. Do not pick new work.\nAffects: ALL TICKETS\n`;
  fs.appendFileSync(ctx.blackboardFile, signal);

  // Update sprint status
  if (sprint) {
    sprint.status = 'halted';
    fs.writeFileSync(ctx.sprintFile, JSON.stringify(sprint, null, 2));
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
  const histFile = path.join(ctx.historyDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-sprint-halted.json`);
  fs.writeFileSync(histFile, JSON.stringify(haltHistory, null, 2));

  // Stop all orchestrator agents
  orch.stopAll();

  res.json({ ok: true, halted: haltedTickets, previousStates });
});

// Post signal to blackboard
app.post('/api/actions/signal', (req, res) => {
  const { type, title, detail, affects } = req.body;
  const signal = `\n## [${type}] ${title} — human — ${new Date().toISOString()}\n${detail || ''}\nAffects: ${affects || 'N/A'}\n`;
  fs.appendFileSync(ctx.blackboardFile, signal);
  res.json({ ok: true });
});

// Resume from halt
app.post('/api/actions/resume', (req, res) => {
  const board = readJSON(ctx.boardFile);
  const sprint = readJSON(ctx.sprintFile);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });

  // Find the most recent halt history to get previous states
  const histFiles = fs.readdirSync(ctx.historyDir).filter(f => f.includes('sprint-halted')).sort().reverse();
  let previousStates = {};
  if (histFiles.length > 0) {
    const haltData = readJSON(path.join(ctx.historyDir, histFiles[0]));
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
  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));

  if (sprint) {
    sprint.status = 'active';
    fs.writeFileSync(ctx.sprintFile, JSON.stringify(sprint, null, 2));
  }

  // Remove halt from blackboard
  let bb = readText(ctx.blackboardFile);
  bb = bb.replace(/\n## \[halt\][\s\S]*?(?=\n## \[|$)/g, '');
  fs.writeFileSync(ctx.blackboardFile, bb);

  // Clear rate limit flag and reset agent statuses
  orch.rateLimitState = { detected: false, resetInfo: null };
  for (const role of Object.keys(orch.agents)) {
    if (orch.agents[role].status === 'rate-limited' || orch.agents[role].status === 'stopped') {
      orch.agents[role].status = 'idle';
    }
  }

  // Resume does NOT auto-enable dispatch — user controls that separately

  res.json({ ok: true });
});

// Clear rate limit flag (without resuming halted tickets)
app.post('/api/actions/clear-rate-limit', (req, res) => {
  orch.rateLimitState = { detected: false, resetInfo: null };
  for (const role of Object.keys(orch.agents)) {
    if (orch.agents[role].status === 'rate-limited') {
      orch.agents[role].status = 'idle';
    }
  }
  orch.addLog('info', 'Rate limit cleared by human');
  orch.emit('agent-update', orch.getAgentStates());
  if (orch.autoMode) orch.evaluateAndDispatch();
  res.json({ ok: true });
});

// Move ticket to any valid status (human override)
app.post('/api/actions/move-ticket', (req, res) => {
  const { ticketId, toStatus, note } = req.body;
  if (!ticketId || !toStatus) return res.status(400).json({ error: 'ticketId and toStatus are required' });

  const board = readJSON(ctx.boardFile);
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
  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));
  writeHistory(ticketId, fromStatus, toStatus, note || 'Moved via dashboard');

  res.json({ ok: true, ticket });
});

// Reset sprint (back to planning)
app.post('/api/actions/reset-sprint', (req, res) => {
  const board = readJSON(ctx.boardFile);
  const sprint = readJSON(ctx.sprintFile);
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
      writeHistory(t.id, fromStatus, 'groomed', 'Reverted via sprint reset');
    }
  });
  board.last_updated = new Date().toISOString();
  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));

  sprint.status = 'planning';
  fs.writeFileSync(ctx.sprintFile, JSON.stringify(sprint, null, 2));

  orch.addLog('info', `Sprint reset to planning — ${reverted.length} tickets reverted to groomed`);
  res.json({ ok: true, reverted });
});

// Reprioritize
app.post('/api/actions/reprioritize', (req, res) => {
  const { ticketId, priority } = req.body;
  const board = readJSON(ctx.boardFile);
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
  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));
  res.json({ ok: true, ticket });
});

// ── Orchestrator Endpoints ──────────────────────────────────────────────────

// Start sprint: planning → active, auto-approve groomed tickets, enable dispatch
app.post('/api/actions/start-sprint', (req, res) => {
  const sprint = readJSON(ctx.sprintFile);
  if (!sprint) return res.status(500).json({ error: 'Cannot read sprint file' });
  if (sprint.status !== 'planning') return res.status(400).json({ error: `Sprint is ${sprint.status}, not planning` });

  // Move sprint to active
  sprint.status = 'active';
  fs.writeFileSync(ctx.sprintFile, JSON.stringify(sprint, null, 2));

  // Auto-approve all groomed tickets
  const board = readJSON(ctx.boardFile);
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
        writeHistory(t.id, 'groomed', 'dev-ready', 'Auto-approved via Start Sprint');
      }
    });
    board.last_updated = new Date().toISOString();
    fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));
  }

  // Enable auto-dispatch
  orch.startAutoMode();
  orch.addLog('success', `Sprint started — ${approved.length} tickets auto-approved`);

  res.json({ ok: true, approved });
});

// Start a specific agent (manual = true so it clears 'stopped' status)
app.post('/api/actions/agents/:role/start', async (req, res) => {
  const { role } = req.params;
  if (!orch.agents[role]) return res.status(404).json({ error: `Unknown agent role: ${role}` });

  const started = await orch.startAgent(role, { manual: true });
  res.json({ ok: started, agent: orch.getAgentStates()[role] });
});

// Stop a specific agent
app.post('/api/actions/agents/:role/stop', (req, res) => {
  const { role } = req.params;
  if (!orch.agents[role]) return res.status(404).json({ error: `Unknown agent role: ${role}` });

  const stopped = orch.stopAgent(role);
  res.json({ ok: stopped, agent: orch.getAgentStates()[role] });
});

// Toggle auto-dispatch
app.post('/api/actions/dispatch/toggle', (req, res) => {
  if (orch.autoMode) {
    orch.stopAutoMode();
  } else {
    orch.startAutoMode();
  }
  res.json({ ok: true, autoMode: orch.autoMode });
});

// Get full agent log from disk
app.get('/api/agents/:role/log', (req, res) => {
  const { role } = req.params;
  const logFile = path.join(ctx.logsDir, `${role}.log`);
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
  res.json({
    agents: orch.getAgentStates(),
    autoMode: orch.autoMode,
    log: orch.log.slice(-50),
  });
});

// Create a new ticket
app.post('/api/actions/create-ticket', (req, res) => {
  const { title, type, priority, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const board = readJSON(ctx.boardFile);
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
  fs.writeFileSync(ctx.boardFile, JSON.stringify(board, null, 2));

  writeHistory(ticketId, 'none', 'new', 'Created via dashboard');
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
    return {
      name,
      displayName: board?.project || name,
      ticketCount: board?.tickets?.length || 0,
      sprintStatus: sprint?.status || 'unknown',
      active: name === ctx.projectName,
    };
  });
  res.json({ projects });
});

// Switch active project
app.post('/api/projects/switch', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const projectDir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: `Project "${name}" not found` });

  // Stop all agents before switching
  orch.stopAll();

  setActiveProject(name);
  orch.repoint(ctx.projectDir);
  startWatcher();

  // Persist to config
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ activeProject: name }, null, 2));

  orch.addLog('info', `Switched to project: ${name}`);
  const state = getFullState();
  broadcast('state-update', state);
  broadcast('project-switch', { name });
  res.json({ ok: true, activeProject: name });
});

// Create a new project
app.post('/api/projects/create', (req, res) => {
  const { name, spec, specContent } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Project name must be alphanumeric (spaces, dashes, underscores allowed)' });
  const slug = name.replace(/\s+/g, '-');
  const projectDir = path.join(PROJECTS_DIR, slug);
  if (fs.existsSync(projectDir)) return res.status(409).json({ error: `Project "${name}" already exists` });

  scaffoldProject(slug, spec, name);

  // If spec content was pasted or uploaded, save it as SPEC.md in the project folder
  if (specContent) {
    const specPath = path.join(projectDir, 'SPEC.md');
    fs.writeFileSync(specPath, specContent);
  }

  res.json({ ok: true, name: slug });
});

// ── PM Chat ─────────────────────────────────────────────────────────────────

let chatProcess = null; // Active claude -p process for chat

function getChatFile() {
  return path.join(ctx.projectDir, 'chat.json');
}

function readChatHistory() {
  try {
    return JSON.parse(fs.readFileSync(getChatFile(), 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveChatHistory(messages) {
  fs.writeFileSync(getChatFile(), JSON.stringify(messages, null, 2));
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

function buildChatPrompt(history, newMessage) {
  const board = readJSON(ctx.boardFile);
  const projectName = board?.project || ctx.projectName || 'Unknown';
  const existingSpec = board?.spec || 'SPEC.md';
  let specContent = '';
  const specPath = path.join(ctx.projectDir, existingSpec);
  if (fs.existsSync(specPath)) {
    try { specContent = fs.readFileSync(specPath, 'utf-8'); } catch (e) { /* ignore */ }
  }

  let prompt = `You are a PM agent helping design a project spec. You are having an interactive conversation with a human to understand their project idea and help them create a structured SPEC.md.

The user may be working on the current project "${projectName}" OR describing an entirely new project idea. Pay attention to what they say — if they mention a new idea or a different project name, help them spec THAT project, not the current one.

Your responsibilities:
- Ask clarifying questions about the project scope, features, and requirements
- Help organize ideas into a clear spec structure
- When the user is ready, generate a complete SPEC.md with sections: Overview, Goals, Architecture, Features (with acceptance criteria), Tech Stack, and Non-Goals
- Keep responses concise and focused
- Use markdown formatting in your responses

When you generate the final spec, output it in a markdown code block tagged as \`\`\`spec so the system can detect it. Also include a project name suggestion on a separate line before the spec block like: PROJECT_NAME: My New Project
`;

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
  res.json({ messages: readChatHistory() });
});

// Clear chat history
app.post('/api/chat/clear', (req, res) => {
  if (chatProcess) {
    try { chatProcess.kill(); } catch (e) { /* ignore */ }
    chatProcess = null;
  }
  saveChatHistory([]);
  res.json({ ok: true });
});

// Send chat message — streams response via SSE
app.post('/api/chat/send', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  if (chatProcess) {
    try { chatProcess.kill(); } catch (e) { /* ignore */ }
    chatProcess = null;
  }

  const history = readChatHistory();
  history.push({ role: 'user', text: message.trim(), at: new Date().toISOString() });
  saveChatHistory(history);

  const prompt = buildChatPrompt(history.slice(0, -1), message.trim());
  const promptFile = path.join(ctx.logsDir, 'chat-prompt.txt');
  fs.writeFileSync(promptFile, prompt);

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const launcherPath = path.join(__dirname, 'launch-chat.py');
  const proc = pty.spawn('python3', [launcherPath, promptFile], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: path.resolve(__dirname, '..'),
    env: cleanEnv,
  });

  chatProcess = proc;
  let fullResponse = '';

  proc.onData((raw) => {
    const text = stripAnsi(raw);
    fullResponse += text;
    broadcast('chat-response', { chunk: text, done: false });
  });

  proc.onExit(({ exitCode }) => {
    chatProcess = null;
    const cleanResponse = cleanFinalResponse(fullResponse);
    if (cleanResponse) {
      history.push({ role: 'pm', text: cleanResponse, at: new Date().toISOString() });
      saveChatHistory(history);

      const specMatch = cleanResponse.match(/```spec\n([\s\S]*?)```/);
      if (specMatch) {
        const nameMatch = cleanResponse.match(/PROJECT_NAME:\s*(.+)/);
        const suggestedName = nameMatch ? nameMatch[1].trim() : null;
        broadcast('chat-response', { chunk: '', done: true, hasSpec: true, spec: specMatch[1], suggestedName });
      } else {
        broadcast('chat-response', { chunk: '', done: true });
      }
    } else {
      broadcast('chat-response', { chunk: '', done: true, error: exitCode !== 0 });
    }
  });

  res.json({ ok: true, streaming: true });
});

// Save spec from chat — optionally creates a new project
app.post('/api/chat/save-spec', (req, res) => {
  const { spec, projectName: newProjectName } = req.body;
  if (!spec) return res.status(400).json({ error: 'Spec content is required' });

  let targetDir = ctx.projectDir;

  if (newProjectName && newProjectName.trim()) {
    const name = newProjectName.trim();
    if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return res.status(400).json({ error: 'Invalid project name' });
    const slug = name.replace(/\s+/g, '-');
    const projectDir = path.join(PROJECTS_DIR, slug);
    if (!fs.existsSync(projectDir)) {
      scaffoldProject(slug, 'SPEC.md', name);
    }
    targetDir = projectDir;

    orch.stopAll();
    setActiveProject(slug);
    orch.repoint(ctx.projectDir);
    startWatcher();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ activeProject: slug }, null, 2));
    broadcast('project-switch', { name: slug });
  }

  const specPath = path.join(targetDir, 'SPEC.md');
  fs.writeFileSync(specPath, spec);

  const board = readJSON(path.join(targetDir, 'board.json'));
  if (board) {
    board.spec = 'SPEC.md';
    fs.writeFileSync(path.join(targetDir, 'board.json'), JSON.stringify(board, null, 2));
  }

  res.json({ ok: true, project: ctx.projectName });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function writeHistory(ticketId, from, to, note) {
  const entry = {
    ticket: ticketId,
    from, to,
    by: 'human',
    at: new Date().toISOString(),
    note
  };
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${ticketId}-${to}.json`;
  fs.writeFileSync(path.join(ctx.historyDir, filename), JSON.stringify(entry, null, 2) + '\n');
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
      const state = getFullState();
      broadcast('state-update', state);

      // Log pipeline alerts
      state.alerts.forEach(a => {
        if (a.level === 'warn' || a.level === 'error') {
          console.log(`[ALERT] ${a.message}`);
        }
      });

      // In auto mode, check if there's new work to dispatch
      if (orch.autoMode) {
        orch.evaluateAndDispatch();
      }
    }, 30000);  // 30s debounce on file watch
  });
}

// ── Serve Dashboard ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Start ───────────────────────────────────────────────────────────────────

// Initialize project context, migrate if needed, start watcher
initActiveProject();
orch.repoint(ctx.projectDir);
orch.cleanupZombies();
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
