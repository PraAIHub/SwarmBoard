const express = require('express');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const Orchestrator = require('./orchestrator');

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const BOARD_DIR = process.env.BOARD_DIR || path.resolve(__dirname, '..', '.agent-board');
const BOARD_FILE = path.join(BOARD_DIR, 'board.json');
const SCHEMA_FILE = path.join(BOARD_DIR, 'schema.json');
const BLACKBOARD_FILE = path.join(BOARD_DIR, 'blackboard.md');
const SPRINT_FILE = path.join(BOARD_DIR, 'sprints', 'current.json');
const HISTORY_DIR = path.join(BOARD_DIR, 'history');
const PORT = process.env.PORT || 3456;

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
  const board = readJSON(BOARD_FILE);
  const schema = readJSON(SCHEMA_FILE);
  const sprint = readJSON(SPRINT_FILE);
  const blackboard = readText(BLACKBOARD_FILE);
  
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
  const board = readJSON(BOARD_FILE);
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
  
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  writeHistory(ticketId, 'groomed', 'dev-ready', 'Approved by human via dashboard');
  res.json({ ok: true, ticket });
});

// Block ticket
app.post('/api/actions/block', (req, res) => {
  const { ticketId, reason } = req.body;
  const board = readJSON(BOARD_FILE);
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
  
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  
  // Also post to blackboard
  const signal = `\n## [blocker] ${ticket.title} blocked — human — ${new Date().toISOString()}\n${reason || 'Blocked via dashboard'}\nAffects: ${ticketId}\n`;
  fs.appendFileSync(BLACKBOARD_FILE, signal);
  
  writeHistory(ticketId, prevStatus, 'blocked', `Blocked by human: ${reason}`);
  res.json({ ok: true, ticket });
});

// Halt sprint
app.post('/api/actions/halt', (req, res) => {
  const { reason } = req.body;
  const board = readJSON(BOARD_FILE);
  const sprint = readJSON(SPRINT_FILE);
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
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  
  // Post halt signal
  const signal = `\n## [halt] SPRINT HALTED — human — ${new Date().toISOString()}\n${reason || 'Halted via dashboard'}\nAll agents must stop. Do not pick new work.\nAffects: ALL TICKETS\n`;
  fs.appendFileSync(BLACKBOARD_FILE, signal);
  
  // Update sprint status
  if (sprint) {
    sprint.status = 'halted';
    fs.writeFileSync(SPRINT_FILE, JSON.stringify(sprint, null, 2));
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
  const histFile = path.join(HISTORY_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-sprint-halted.json`);
  fs.writeFileSync(histFile, JSON.stringify(haltHistory, null, 2));
  
  // Stop all orchestrator agents
  orch.stopAll();

  res.json({ ok: true, halted: haltedTickets, previousStates });
});

// Post signal to blackboard
app.post('/api/actions/signal', (req, res) => {
  const { type, title, detail, affects } = req.body;
  const signal = `\n## [${type}] ${title} — human — ${new Date().toISOString()}\n${detail || ''}\nAffects: ${affects || 'N/A'}\n`;
  fs.appendFileSync(BLACKBOARD_FILE, signal);
  res.json({ ok: true });
});

// Resume from halt
app.post('/api/actions/resume', (req, res) => {
  const board = readJSON(BOARD_FILE);
  const sprint = readJSON(SPRINT_FILE);
  if (!board) return res.status(500).json({ error: 'Cannot read board.json' });
  
  // Find the most recent halt history to get previous states
  const histFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.includes('sprint-halted')).sort().reverse();
  let previousStates = {};
  if (histFiles.length > 0) {
    const haltData = readJSON(path.join(HISTORY_DIR, histFiles[0]));
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
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  
  if (sprint) {
    sprint.status = 'active';
    fs.writeFileSync(SPRINT_FILE, JSON.stringify(sprint, null, 2));
  }
  
  // Remove halt from blackboard
  let bb = readText(BLACKBOARD_FILE);
  bb = bb.replace(/\n## \[halt\][\s\S]*?(?=\n## \[|$)/g, '');
  fs.writeFileSync(BLACKBOARD_FILE, bb);

  // Re-enable auto-dispatch
  orch.startAutoMode();

  res.json({ ok: true });
});

// Move ticket to any valid status (human override)
app.post('/api/actions/move-ticket', (req, res) => {
  const { ticketId, toStatus, note } = req.body;
  if (!ticketId || !toStatus) return res.status(400).json({ error: 'ticketId and toStatus are required' });

  const board = readJSON(BOARD_FILE);
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
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  writeHistory(ticketId, fromStatus, toStatus, note || 'Moved via dashboard');

  res.json({ ok: true, ticket });
});

// Reset sprint (back to planning)
app.post('/api/actions/reset-sprint', (req, res) => {
  const board = readJSON(BOARD_FILE);
  const sprint = readJSON(SPRINT_FILE);
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
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));

  sprint.status = 'planning';
  fs.writeFileSync(SPRINT_FILE, JSON.stringify(sprint, null, 2));

  orch.addLog('info', `Sprint reset to planning — ${reverted.length} tickets reverted to groomed`);
  res.json({ ok: true, reverted });
});

// Reprioritize
app.post('/api/actions/reprioritize', (req, res) => {
  const { ticketId, priority } = req.body;
  const board = readJSON(BOARD_FILE);
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
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  res.json({ ok: true, ticket });
});

// ── Orchestrator Endpoints ──────────────────────────────────────────────────

// Start sprint: planning → active, auto-approve groomed tickets, enable dispatch
app.post('/api/actions/start-sprint', (req, res) => {
  const sprint = readJSON(SPRINT_FILE);
  if (!sprint) return res.status(500).json({ error: 'Cannot read sprint file' });
  if (sprint.status !== 'planning') return res.status(400).json({ error: `Sprint is ${sprint.status}, not planning` });

  // Move sprint to active
  sprint.status = 'active';
  fs.writeFileSync(SPRINT_FILE, JSON.stringify(sprint, null, 2));

  // Auto-approve all groomed tickets
  const board = readJSON(BOARD_FILE);
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
    fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
  }

  // Enable auto-dispatch
  orch.startAutoMode();
  orch.addLog('success', `Sprint started — ${approved.length} tickets auto-approved`);

  res.json({ ok: true, approved });
});

// Start a specific agent
app.post('/api/actions/agents/:role/start', async (req, res) => {
  const { role } = req.params;
  if (!orch.agents[role]) return res.status(404).json({ error: `Unknown agent role: ${role}` });

  const started = await orch.startAgent(role);
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
  const logFile = path.join(BOARD_DIR, 'logs', `${role}.log`);
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

  const board = readJSON(BOARD_FILE);
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
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));

  writeHistory(ticketId, 'none', 'new', 'Created via dashboard');
  orch.addLog('info', `New ticket created: ${ticketId} — ${title}`);

  res.json({ ok: true, ticket: newTicket });
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
  fs.writeFileSync(path.join(HISTORY_DIR, filename), JSON.stringify(entry, null, 2) + '\n');
}

// ── File Watcher ────────────────────────────────────────────────────────────
const watcher = chokidar.watch(BOARD_DIR, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300 },
});

watcher.on('all', (event, filepath) => {
  console.log(`[watch] ${event}: ${path.relative(BOARD_DIR, filepath)}`);
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
});

// ── Serve Dashboard ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  SwarmBoard Dashboard                         │');
  console.log(`  │  http://localhost:${PORT}                      │`);
  console.log('  │                                              │');
  console.log(`  │  Watching: ${path.relative(process.cwd(), BOARD_DIR).padEnd(33)}│`);
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
