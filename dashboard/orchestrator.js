const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

class Orchestrator {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.boardPath = path.join(projectRoot, '.agent-board', 'board.json');
    this.blackboardPath = path.join(projectRoot, '.agent-board', 'blackboard.md');
    this.schemaPath = path.join(projectRoot, '.agent-board', 'schema.json');
    this.sprintPath = path.join(projectRoot, '.agent-board', 'sprints', 'current.json');

    // Agent process management
    this.agents = {
      'pm-agent':       { process: null, status: 'idle', current: null, label: 'PM',  pid: null },
      'dev-agent':      { process: null, status: 'idle', current: null, label: 'DEV', pid: null },
      'reviewer-agent': { process: null, status: 'idle', current: null, label: 'REV', pid: null },
      'test-agent':     { process: null, status: 'idle', current: null, label: 'QA',  pid: null },
    };

    this.listeners = [];
    this.autoMode = false;  // When true, orchestrator auto-dispatches agents
    this.log = [];

    // Per-agent output buffering (last 50 lines each)
    this.agentLogs = {
      'pm-agent': [],
      'dev-agent': [],
      'reviewer-agent': [],
      'test-agent': [],
    };

    // Rate limit detection
    this.rateLimitPattern = /out of (extra )?usage|rate.limit|usage.*resets/i;
    this.rateLimitState = { detected: false, resetInfo: null };

    // Log persistence directory
    this.logsDir = path.join(projectRoot, '.agent-board', 'logs');
    try { fs.mkdirSync(this.logsDir, { recursive: true }); } catch (e) { /* exists */ }

    // Restore last 50 lines per agent from disk on startup
    for (const role of Object.keys(this.agents)) {
      const logFile = path.join(this.logsDir, `${role}.log`);
      try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim()).slice(-50);
        this.agentLogs[role] = lines.map(l => {
          try { return JSON.parse(l); } catch (e) { return { text: l, at: new Date().toISOString() }; }
        });
      } catch (e) { /* no previous log */ }
    }
  }

  // --- State Readers ---

  readBoard() {
    try {
      return JSON.parse(fs.readFileSync(this.boardPath, 'utf-8'));
    } catch (e) {
      return { project: 'Unknown', tickets: [] };
    }
  }

  readBlackboard() {
    try {
      return fs.readFileSync(this.blackboardPath, 'utf-8');
    } catch (e) {
      return '';
    }
  }

  readSchema() {
    try {
      return JSON.parse(fs.readFileSync(this.schemaPath, 'utf-8'));
    } catch (e) {
      return {};
    }
  }

  readSprint() {
    try {
      return JSON.parse(fs.readFileSync(this.sprintPath, 'utf-8'));
    } catch (e) {
      return { sprint: 'unknown', status: 'unknown' };
    }
  }

  isHalted() {
    const bb = this.readBlackboard();
    return bb.includes('[halt]');
  }

  // --- Board Analysis ---

  getTicketsByStatus(status) {
    const board = this.readBoard();
    return board.tickets.filter(t => t.status === status);
  }

  getAgentWork() {
    const board = this.readBoard();
    const work = {
      'pm-agent':       { available: [], resume: null, description: '' },
      'dev-agent':      { available: [], resume: null, description: '' },
      'reviewer-agent': { available: [], resume: null, description: '' },
      'test-agent':     { available: [], resume: null, description: '' },
    };

    const tickets = board.tickets || [];

    // Dev: check for in-progress work first (session recovery)
    const devInProgress = tickets.filter(t => t.status === 'in-dev' && t.assignee === 'dev-agent');
    const allInDev = tickets.filter(t => t.status === 'in-dev');
    const changesRequested = tickets.filter(t => t.status === 'changes-requested');
    const devReady = tickets.filter(t => t.status === 'dev-ready');
    if (devInProgress.length > 0) {
      // Resume in-progress ticket — not blocked, this IS the work
      work['dev-agent'].resume = devInProgress[0];
      work['dev-agent'].available = devInProgress;
      work['dev-agent'].description = `resuming ${devInProgress[0].id}`;
    } else if (allInDev.length > 0) {
      // WIP limit: a ticket is in-dev (possibly unassigned/stuck) — don't dispatch new work
      work['dev-agent'].blocked = true;
      work['dev-agent'].description = `blocked: ${allInDev[0].id} is in-dev`;
    } else {
      work['dev-agent'].available = [...changesRequested, ...devReady];
      work['dev-agent'].description = changesRequested.length > 0
        ? `${changesRequested.length} changes-requested, ${devReady.length} dev-ready`
        : `${devReady.length} dev-ready`;
    }

    // Reviewer: check for in-progress review first
    const inReview = tickets.filter(t => t.status === 'in-review' && t.assignee === 'reviewer-agent');
    const allInReview = tickets.filter(t => t.status === 'in-review');
    const reviewReady = tickets.filter(t => t.status === 'review-ready');
    if (inReview.length > 0) {
      work['reviewer-agent'].resume = inReview[0];
      work['reviewer-agent'].available = inReview;
      work['reviewer-agent'].description = `resuming review of ${inReview[0].id}`;
    } else if (allInReview.length > 0) {
      // WIP limit: a ticket is in-review — don't dispatch new work
      work['reviewer-agent'].blocked = true;
      work['reviewer-agent'].description = `blocked: ${allInReview[0].id} is in-review`;
    } else {
      work['reviewer-agent'].available = reviewReady;
      work['reviewer-agent'].description = `${reviewReady.length} review-ready`;
    }

    // Test: check for in-progress test first
    const inTest = tickets.filter(t => t.status === 'in-test' && t.assignee === 'test-agent');
    const allInTest = tickets.filter(t => t.status === 'in-test');
    const testReady = tickets.filter(t => t.status === 'test-ready');
    if (inTest.length > 0) {
      work['test-agent'].resume = inTest[0];
      work['test-agent'].available = inTest;
      work['test-agent'].description = `resuming test of ${inTest[0].id}`;
    } else if (allInTest.length > 0) {
      // WIP limit: a ticket is in-test — don't dispatch new work
      work['test-agent'].blocked = true;
      work['test-agent'].description = `blocked: ${allInTest[0].id} is in-test`;
    } else {
      work['test-agent'].available = testReady;
      work['test-agent'].description = `${testReady.length} test-ready`;
    }

    // PM: check if backlog needs grooming
    const newTickets = tickets.filter(t => t.status === 'new');
    work['pm-agent'].available = newTickets;
    work['pm-agent'].description = `${newTickets.length} need grooming`;

    return work;
  }

  // --- Agent Spawning ---

  getCommandContent(role) {
    const commandMap = {
      'pm-agent':       'pm.md',
      'dev-agent':      'dev.md',
      'reviewer-agent': 'reviewer.md',
      'test-agent':     'test.md',
    };
    const cmdFile = path.join(this.projectRoot, '.claude', 'commands', commandMap[role]);
    try {
      return fs.readFileSync(cmdFile, 'utf-8');
    } catch (e) {
      return `You are the ${role}. Read .agent-board/board.json and process tickets according to your role.`;
    }
  }

  buildPrompt(role) {
    const commandContent = this.getCommandContent(role);
    const work = this.getAgentWork()[role];
    const ticketList = work.available.map(t => `${t.id}: ${t.title} (${t.status}, ${t.priority}${t.branch ? ', branch: ' + t.branch : ''})`).join('\n');

    let resumeBlock = '';
    if (work.resume) {
      const t = work.resume;
      resumeBlock = `
SESSION RECOVERY — YOU HAVE UNFINISHED WORK:
Ticket: ${t.id} — ${t.title}
Status: ${t.status}
Branch: ${t.branch || 'unknown'}
Assignee: ${t.assignee}

This ticket was already claimed by you in a previous session. DO NOT create a new branch.
Instead: git checkout ${t.branch || 'feat/' + t.id} and continue where you left off.
Check what's already been done (git log, read the code) before making changes.
`;
    }

    let branchInstructions = '';
    if (role === 'dev-agent' && !work.resume) {
      branchInstructions = `
CRITICAL: Before creating a feature branch, ALWAYS run: git checkout main && git pull origin main first. Then create your branch from main. Never branch from another feature branch.`;
    }

    const board = this.readBoard();
    const projectName = board.project || 'SwarmBoard';
    const specPath = board.spec || 'SPEC.md';

    return `You are operating as ${role} in the ${projectName} project.
Spec location: ${specPath}

Follow these instructions exactly:

${commandContent}
${resumeBlock}
Current work available:
${ticketList || 'No tickets currently available for your role.'}

Execute one iteration of your loop: read the blackboard, pick the highest priority ticket available to you, do the work, update board.json and history, then stop.

IMPORTANT: Work in the project directory. Read real files. Make real changes. Commit to git if your role requires it.
${branchInstructions}`;
  }

  stripAnsi(text) {
    // Strip ANSI escape sequences and TTY control codes from script output
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\][^\x07]*\x07|\x1B\[\?[0-9;]*[a-zA-Z]|\r/g, '');
  }

  pushAgentLog(role, message) {
    const entry = { text: message, at: new Date().toISOString() };
    this.agentLogs[role].push(entry);
    if (this.agentLogs[role].length > 50) this.agentLogs[role].shift();
    // Persist to disk (append, one JSON object per line)
    try {
      const logFile = path.join(this.logsDir, `${role}.log`);
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (e) { /* best effort */ }
    this.emit('agent-output', { role, data: message });
  }

  async startAgent(role) {
    if (this.isHalted()) {
      this.addLog('warn', `Cannot start ${role} — sprint is HALTED`);
      this.pushAgentLog(role, `⛔ Cannot start — sprint is HALTED. Use Resume to clear the halt signal.`);
      this.agents[role].status = 'blocked';
      this.emit('agent-update', this.getAgentStates());
      this.emit('agent-blocked', { role, reason: 'halted' });
      return false;
    }

    if (this.agents[role].process) {
      this.addLog('warn', `${role} is already running (PID: ${this.agents[role].pid})`);
      return false;
    }

    const work = this.getAgentWork()[role];
    if (work.available.length === 0) {
      this.addLog('info', `${role} has no work available`);
      this.pushAgentLog(role, `ℹ No work available for ${role}.`);
      this.agents[role].status = 'idle';
      this.emit('agent-update', this.getAgentStates());
      return false;
    }

    if (work.blocked) {
      this.addLog('info', `${role} blocked by WIP limit`);
      this.pushAgentLog(role, `⏳ Blocked by WIP limit — another ticket is already in progress.`);
      this.agents[role].status = 'waiting';
      this.emit('agent-update', this.getAgentStates());
      return false;
    }

    const prompt = this.buildPrompt(role);
    const topTicket = work.available[0];

    this.addLog('info', `Starting ${role} → ${topTicket.id}: ${topTicket.title}`);
    this.agents[role].status = 'running';
    this.agents[role].current = topTicket.id;

    try {
      // claude -p requires a real TTY to produce output.
      // Use node-pty to spawn with a pseudo-terminal.
      // Write prompt to file, use launch-agent.py to read it safely
      // (avoids shell expansion of backticks and $ in prompts).
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      const promptFile = path.join(this.logsDir, `${role}-prompt.txt`);
      fs.writeFileSync(promptFile, prompt);
      const launcherPath = path.join(__dirname, 'launch-agent.py');

      const proc = pty.spawn('python3', [launcherPath, promptFile], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.projectRoot,
        env: cleanEnv,
      });

      this.agents[role].process = proc;
      this.agents[role].pid = proc.pid;

      let output = '';
      let rateLimitHits = 0;

      proc.onData((raw) => {
        const text = this.stripAnsi(raw);
        output += text;
        const lines = text.split('\n').filter(l => l.trim());
        for (const line of lines) {
          // Detect rate limit errors
          if (this.rateLimitPattern.test(line)) {
            rateLimitHits++;
            if (rateLimitHits === 1) {
              // First hit: log it, alert, and kill the process
              const resetMatch = line.match(/resets?\s+(.+)/i);
              const resetInfo = resetMatch ? resetMatch[1].trim() : 'unknown';
              this.rateLimitState = { detected: true, resetInfo, at: new Date().toISOString() };

              this.pushAgentLog(role, `⛔ RATE LIMITED — ${line.trim()}`);
              this.addLog('error', `${role} hit rate limit — ${resetInfo}. Stopping all agents.`);
              this.emit('rate-limit', { role, resetInfo, at: new Date().toISOString() });

              // Kill this agent — no point retrying
              try { proc.kill('SIGTERM'); } catch (e) { /* already dying */ }

              // Stop all other agents — rate limit is account-level
              for (const otherRole of Object.keys(this.agents)) {
                if (otherRole !== role && this.agents[otherRole].process) {
                  this.pushAgentLog(otherRole, `⛔ Stopped — account rate limit hit by ${role}`);
                  this.stopAgent(otherRole);
                }
              }
              this.agents[role].status = 'rate-limited';
              this.emit('agent-update', this.getAgentStates());
            }
            // Deduplicate: don't log subsequent identical rate limit lines
            return;
          }
          this.pushAgentLog(role, line);
        }
      });

      proc.onExit(({ exitCode }) => {
        this.agents[role].process = null;
        this.agents[role].pid = null;
        this.agents[role].current = null;

        // Preserve rate-limited status — don't reset to idle
        if (this.agents[role].status !== 'rate-limited') {
          this.agents[role].status = 'idle';
        }

        if (rateLimitHits > 0) {
          this.addLog('error', `${role} killed after rate limit (${rateLimitHits} retries suppressed)`);
        } else if (exitCode === 0) {
          this.addLog('success', `${role} completed task on ${topTicket.id}`);
        } else {
          this.addLog('error', `${role} exited with code ${exitCode}: ${output.slice(-200)}`);
        }

        this.emit('agent-update', this.getAgentStates());
        this.emit('board-change', this.getFullState());

        // In auto mode, check if there's more work after a delay
        if (this.autoMode) {
          setTimeout(() => this.evaluateAndDispatch(), 2000);
        }
      });

      this.emit('agent-update', this.getAgentStates());
      return true;

    } catch (err) {
      this.agents[role].status = 'error';
      this.addLog('error', `Failed to spawn ${role}: ${err.message}`);
      this.emit('agent-update', this.getAgentStates());
      return false;
    }
  }

  stopAgent(role) {
    const agent = this.agents[role];
    if (agent.process) {
      agent.process.kill('SIGTERM');
      this.addLog('warn', `Stopped ${role} (PID: ${agent.pid})`);
      agent.process = null;
      agent.pid = null;
      agent.current = null;
      agent.status = 'stopped';
      this.emit('agent-update', this.getAgentStates());
      return true;
    }
    return false;
  }

  stopAll() {
    Object.keys(this.agents).forEach(role => this.stopAgent(role));
    this.autoMode = false;
    this.addLog('warn', 'All agents stopped');
  }

  // --- Auto Orchestration ---

  evaluateAndDispatch() {
    if (!this.autoMode || this.isHalted() || this.rateLimitState.detected) return;

    const work = this.getAgentWork();
    const priority = ['dev-agent', 'reviewer-agent', 'test-agent', 'pm-agent'];

    for (const role of priority) {
      if (!this.agents[role].process && work[role].available.length > 0 && !work[role].blocked) {
        this.startAgent(role);
      }
    }
  }

  startAutoMode() {
    this.autoMode = true;
    this.addLog('info', 'Auto-orchestration ENABLED — agents will be dispatched automatically');
    this.emit('mode-change', { autoMode: true });
    this.evaluateAndDispatch();
  }

  stopAutoMode() {
    this.autoMode = false;
    this.addLog('info', 'Auto-orchestration DISABLED — manual control only');
    this.emit('mode-change', { autoMode: false });
  }

  // --- Board Mutations (Human Controls) ---

  approveTicket(ticketId) {
    const board = this.readBoard();
    const ticket = board.tickets.find(t => t.id === ticketId);
    if (!ticket) return { error: `Ticket ${ticketId} not found` };
    if (ticket.status !== 'groomed') return { error: `${ticketId} is ${ticket.status}, not groomed` };

    ticket.status = 'dev-ready';
    ticket.history.push({
      from: 'groomed',
      to: 'dev-ready',
      by: 'human',
      at: new Date().toISOString(),
      note: 'Approved by human via dashboard'
    });

    board.last_updated = new Date().toISOString();
    fs.writeFileSync(this.boardPath, JSON.stringify(board, null, 2));
    this.writeHistory(ticketId, 'groomed', 'dev-ready', 'human', 'Approved via dashboard');
    this.addLog('success', `Approved ${ticketId} → dev-ready`);
    return { success: true };
  }

  blockTicket(ticketId, reason) {
    const board = this.readBoard();
    const ticket = board.tickets.find(t => t.id === ticketId);
    if (!ticket) return { error: `Ticket ${ticketId} not found` };

    const prevStatus = ticket.status;
    ticket.status = 'blocked';
    ticket.history.push({
      from: prevStatus,
      to: 'blocked',
      by: 'human',
      at: new Date().toISOString(),
      note: `Blocked by human: ${reason}`
    });

    board.last_updated = new Date().toISOString();
    fs.writeFileSync(this.boardPath, JSON.stringify(board, null, 2));

    // Also post blocker to blackboard
    const signal = `\n## [blocker] ${reason} — human — ${new Date().toISOString()}\nAffects: ${ticketId}\n`;
    fs.appendFileSync(this.blackboardPath, signal);

    this.writeHistory(ticketId, prevStatus, 'blocked', 'human', `Blocked: ${reason}`);
    this.addLog('warn', `Blocked ${ticketId}: ${reason}`);
    return { success: true };
  }

  haltSprint(reason) {
    const board = this.readBoard();
    const halted = [];

    board.tickets.forEach(ticket => {
      if (['in-dev', 'in-review', 'in-test'].includes(ticket.status)) {
        const prev = ticket.status;
        ticket.status = 'halted';
        ticket.history.push({
          from: prev,
          to: 'halted',
          by: 'human',
          at: new Date().toISOString(),
          note: `Sprint halted: ${reason}`
        });
        halted.push({ id: ticket.id, previousStatus: prev });
      }
    });

    board.last_updated = new Date().toISOString();
    fs.writeFileSync(this.boardPath, JSON.stringify(board, null, 2));

    // Post halt signal
    const signal = `\n## [halt] SPRINT HALTED — human — ${new Date().toISOString()}\n${reason}\nAll agents must stop. Do not pick new work.\nAffects: ALL TICKETS\n`;
    fs.appendFileSync(this.blackboardPath, signal);

    // Update sprint status
    const sprint = this.readSprint();
    sprint.status = 'halted';
    fs.writeFileSync(this.sprintPath, JSON.stringify(sprint, null, 2));

    // Stop all agents
    this.stopAll();

    // Write halt history
    const historyEntry = {
      type: 'halt',
      by: 'human',
      at: new Date().toISOString(),
      reason,
      tickets_halted: halted.map(h => h.id),
      previous_states: Object.fromEntries(halted.map(h => [h.id, h.previousStatus]))
    };
    const historyPath = path.join(this.projectRoot, '.agent-board', 'history',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-sprint-halted.json`);
    fs.writeFileSync(historyPath, JSON.stringify(historyEntry, null, 2));

    this.addLog('error', `SPRINT HALTED: ${reason} — ${halted.length} tickets halted`);
    return { success: true, halted };
  }

  postSignal(type, title, detail, affects) {
    const signal = `\n## [${type}] ${title} — human — ${new Date().toISOString()}\n${detail}\nAffects: ${affects}\n`;
    fs.appendFileSync(this.blackboardPath, signal);
    this.addLog('info', `Signal posted: [${type}] ${title}`);
    return { success: true };
  }

  // --- Helpers ---

  writeHistory(ticketId, from, to, by, note) {
    const entry = { ticket: ticketId, from, to, by, at: new Date().toISOString(), note };
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${ticketId}-${to}.json`;
    const historyPath = path.join(this.projectRoot, '.agent-board', 'history', filename);
    fs.writeFileSync(historyPath, JSON.stringify(entry, null, 2));
  }

  getAgentLog(role) {
    return this.agentLogs[role] || [];
  }

  getAgentStates() {
    const result = {};
    for (const [role, agent] of Object.entries(this.agents)) {
      result[role] = {
        status: agent.status,
        current: agent.current,
        label: agent.label,
        pid: agent.pid,
        log: (this.agentLogs[role] || []).slice(-10),
      };
    }
    return result;
  }

  getFullState() {
    return {
      board: this.readBoard(),
      sprint: this.readSprint(),
      blackboard: this.readBlackboard(),
      agents: this.getAgentStates(),
      autoMode: this.autoMode,
      halted: this.isHalted(),
      rateLimited: this.rateLimitState,
      log: this.log.slice(-50),
      work: this.getAgentWork(),
    };
  }

  // --- Events ---

  addLog(level, message) {
    const entry = { level, message, at: new Date().toISOString() };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit('log', entry);
  }

  on(event, fn) {
    this.listeners.push({ event, fn });
  }

  emit(event, data) {
    this.listeners.filter(l => l.event === event).forEach(l => l.fn(data));
  }
}

module.exports = Orchestrator;
