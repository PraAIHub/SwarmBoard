const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class Orchestrator {
  constructor(projectRoot, projectDir) {
    this.projectRoot = projectRoot;
    this.projectDir = projectDir;
    this.boardPath = path.join(projectDir, 'board.json');
    this.blackboardPath = path.join(projectDir, 'blackboard.md');
    this.schemaPath = path.join(projectRoot, '.agent-board', 'schema.json');
    this.sprintPath = path.join(projectDir, 'sprints', 'current.json');

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
    // Only match actual rate limit rejections, NOT allowed_warning events
    this.rateLimitPattern = /out of (extra )?usage|usage.*resets|"status"\s*:\s*"(rejected|exceeded|blocked)"/i;
    this.rateLimitState = { detected: false, resetInfo: null };

    // Log and history persistence directories
    this.logsDir = path.join(projectDir, 'logs');
    this.historyDir = path.join(projectDir, 'history');
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

  // Detect and clean up zombie agent states on startup.
  // If an agent is marked working/running but has no process, reset it.
  // Also clean up any stale worktrees from previous runs.
  cleanupZombies() {
    for (const [role, agent] of Object.entries(this.agents)) {
      if ((agent.status === 'working' || agent.status === 'running') && !agent.process) {
        this.addLog('warn', `${role} was marked ${agent.status} but has no process — resetting to idle`);
        this.pushAgentLog(role, `⚠ Zombie state detected — reset to idle on server startup`);
        agent.status = 'idle';
        agent.current = null;
        agent.pid = null;
        agent.worktree = null;
      }
    }
    // Prune stale worktrees left from crashed sessions
    try {
      execSync('git worktree prune', { cwd: this.projectRoot, stdio: 'pipe' });
    } catch (e) { /* best effort */ }
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

  get projectName() {
    return path.basename(this.projectDir);
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

    // PM: check if backlog needs grooming or if backlog is empty (need to create tickets from spec)
    const newTickets = tickets.filter(t => t.status === 'new');
    if (newTickets.length > 0) {
      work['pm-agent'].available = newTickets;
      work['pm-agent'].description = `${newTickets.length} need grooming`;
    } else if (tickets.length === 0) {
      // Empty backlog — PM needs to read spec and create tickets
      work['pm-agent'].available = [{ id: 'BACKLOG-EMPTY', title: 'Create tickets from spec', status: 'new', priority: 'critical' }];
      work['pm-agent'].description = 'empty backlog — need to create tickets from spec';
    } else {
      work['pm-agent'].available = [];
      work['pm-agent'].description = 'no new tickets to groom';
    }

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
CRITICAL: You are running in a git worktree that starts from main (HEAD). Create your feature branch directly from the current commit — do NOT try to checkout main (it's checked out in the main working tree). Use: git checkout -b feat/TICKET-XXX-title`;
    }

    const board = this.readBoard();
    const projectName = board.project || 'SwarmBoard';
    const specPath = board.spec || 'SPEC.md';
    const repo = board.repo || null;

    let repoContext = '';
    if (repo && repo.url) {
      repoContext = `
TARGET REPOSITORY: ${repo.url} (branch: ${repo.branch || 'main'})
You are working in a clone of the target repository, NOT the SwarmBoard repo.
All code artifacts (source code, tests, configs) go into this repo.
Board artifacts (.agent-board/) are symlinked — do NOT modify them directly in the worktree.
Push your feature branches to this repo's remote origin.`;
    }

    return `You are operating as ${role} in the ${projectName} project.
Spec location: ${specPath}${repoContext}

Follow these instructions exactly:

${commandContent}
${resumeBlock}
Current work available:
${ticketList || 'No tickets currently available for your role.'}

IMPORTANT — OUTPUT FORMAT FOR REAL-TIME VISIBILITY:
Before doing ANY work, you MUST first output your plan as a numbered list so the human can see what you're about to do. Use this exact format:

=== PLAN ===
1. [First thing you will do]
2. [Second thing you will do]
3. [Third thing you will do]
... (as many steps as needed)
=== END PLAN ===

Then execute each step ONE AT A TIME. Before starting each step, print:

>>> STEP N: [description]

After completing each step, print:

<<< STEP N: DONE — [brief result summary]

If a step fails, print:

<<< STEP N: FAILED — [what went wrong]

This lets the human monitor your progress in real-time via the dashboard logs.

Execute one iteration of your loop: read the blackboard, pick the highest priority ticket available to you, do the work, update board.json and history, then stop.

IMPORTANT: Work in the project directory. Read real files. Make real changes. Commit to git if your role requires it.
${branchInstructions}

CRITICAL RESTRICTION: NEVER read, modify, create, or delete any files inside the dashboard/ directory. The dashboard/ directory contains the orchestrator and UI code that manages you. Modifying it could break the system. This applies to ALL agents, ALL roles, ALL circumstances. If a ticket seems to require dashboard changes, skip it and post a blocker signal.`;
  }

  stripAnsi(text) {
    // Strip ANSI escape sequences and TTY control codes from script output
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\][^\x07]*\x07|\x1B\[\?[0-9;]*[a-zA-Z]|\r/g, '');
  }

  generateRunId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `run-${ts}-${rand}`;
  }

  pushAgentLog(role, message, meta = {}) {
    const runId = this.agents[role].runId || null;
    const entry = { text: message, at: new Date().toISOString(), role, runId, ...meta };
    this.agentLogs[role].push(entry);
    if (this.agentLogs[role].length > 50) this.agentLogs[role].shift();
    // Persist to disk (append, one JSON object per line)
    try {
      const logFile = path.join(this.logsDir, `${role}.log`);
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (e) { /* best effort */ }
    // Debounce SSE emission — batch log lines into 500ms windows
    if (!this._logFlushTimers) this._logFlushTimers = {};
    if (!this._logFlushTimers[role]) {
      this._logFlushTimers[role] = setTimeout(() => {
        this._logFlushTimers[role] = null;
        this.emit('agent-output', { role });
      }, 3000);
    }
  }

  // --- Target Repo Management ---

  getRepoConfig() {
    const board = this.readBoard();
    return board.repo || null;
  }

  /**
   * Get the git root directory for worktrees. If the project has a configured
   * external repo, use the cloned repo. Otherwise use the SwarmBoard project root.
   */
  getGitRoot() {
    const repo = this.getRepoConfig();
    if (repo && repo.url) {
      return path.join(this.projectDir, 'repo');
    }
    return this.projectRoot;
  }

  /**
   * Ensure the target repo is cloned. Called before creating worktrees.
   * Returns the repo directory path, or null if clone failed.
   */
  ensureRepoCloned() {
    const repo = this.getRepoConfig();
    if (!repo || !repo.url) return this.projectRoot; // no external repo configured

    const repoDir = path.join(this.projectDir, 'repo');
    if (fs.existsSync(path.join(repoDir, '.git'))) {
      // Repo already cloned — pull latest
      try {
        execSync(`git pull --ff-only`, { cwd: repoDir, stdio: 'pipe', timeout: 30000 });
        this.addLog('info', `Pulled latest from ${repo.url}`);
      } catch (e) {
        this.addLog('warn', `Could not pull latest: ${e.message}`);
      }
      return repoDir;
    }

    // Clone the repo
    try {
      this.addLog('info', `Cloning repo: ${repo.url} → ${repoDir}`);
      execSync(`git clone "${repo.url}" "${repoDir}"`, {
        cwd: this.projectDir,
        stdio: 'pipe',
        timeout: 120000,
      });

      // Checkout the configured branch if not default
      if (repo.branch && repo.branch !== 'main') {
        try {
          execSync(`git checkout "${repo.branch}"`, { cwd: repoDir, stdio: 'pipe' });
        } catch (e) {
          // Branch may not exist yet — create it
          execSync(`git checkout -b "${repo.branch}"`, { cwd: repoDir, stdio: 'pipe' });
        }
      }

      // Mark as cloned in board.json
      const board = this.readBoard();
      if (board.repo) {
        board.repo.cloned = true;
        board.repo.clonedAt = new Date().toISOString();
        board.last_updated = new Date().toISOString();
        fs.writeFileSync(this.boardPath, JSON.stringify(board, null, 2));
      }

      this.addLog('info', `Repo cloned successfully: ${repo.url}`);
      return repoDir;
    } catch (err) {
      this.addLog('error', `Failed to clone repo ${repo.url}: ${err.message}`);
      return null;
    }
  }

  // --- Git Worktree Isolation ---

  createWorktree(role, runId) {
    const repo = this.getRepoConfig();
    const gitRoot = repo && repo.url ? this.ensureRepoCloned() : this.projectRoot;
    if (!gitRoot) return null; // clone failed

    const worktreeDir = path.join(gitRoot === this.projectRoot
      ? path.join(this.projectRoot, '.claude', 'worktrees')
      : path.join(this.projectDir, 'worktrees'));
    fs.mkdirSync(worktreeDir, { recursive: true });

    const wtName = `${role}-${runId}`;
    const wtPath = path.join(worktreeDir, wtName);
    const branchName = `worktree-${wtName}`;

    try {
      execSync(`git worktree add "${wtPath}" -b "${branchName}" HEAD`, {
        cwd: gitRoot,
        stdio: 'pipe',
      });

      // Symlink .agent-board/ into worktree so agents share board state
      const wtBoard = path.join(wtPath, '.agent-board');
      const mainBoard = path.join(this.projectRoot, '.agent-board');
      try {
        fs.rmSync(wtBoard, { recursive: true, force: true });
        fs.symlinkSync(mainBoard, wtBoard, 'dir');
      } catch (e) {
        this.addLog('warn', `Could not symlink .agent-board in worktree: ${e.message}`);
      }

      this.addLog('info', `Created worktree for ${role}: ${wtPath} (repo: ${repo ? repo.url : 'swarmboard'})`);
      return wtPath;
    } catch (err) {
      this.addLog('error', `Failed to create worktree for ${role}: ${err.message}`);
      return null;
    }
  }

  removeWorktree(role, wtPath) {
    if (!wtPath) return;
    const repo = this.getRepoConfig();
    const gitRoot = repo && repo.url
      ? path.join(this.projectDir, 'repo')
      : this.projectRoot;

    try {
      // Get the branch name before removing
      const branchName = execSync(`git -C "${wtPath}" rev-parse --abbrev-ref HEAD`, {
        stdio: 'pipe',
      }).toString().trim();

      execSync(`git worktree remove "${wtPath}" --force`, {
        cwd: gitRoot,
        stdio: 'pipe',
      });

      // Clean up the temporary branch
      if (branchName.startsWith('worktree-')) {
        try {
          execSync(`git branch -D "${branchName}"`, {
            cwd: gitRoot,
            stdio: 'pipe',
          });
        } catch (e) { /* branch may already be gone */ }
      }

      this.addLog('info', `Removed worktree for ${role}: ${wtPath}`);
    } catch (err) {
      this.addLog('error', `Failed to remove worktree for ${role}: ${err.message}`);
    }
  }

  async startAgent(role, { manual = false } = {}) {
    // If manually stopped, only a manual start (dashboard button) can clear it
    if (this.agents[role].status === 'stopped' && !manual) {
      return false;
    }

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
    const runId = this.generateRunId();

    this.addLog('info', `Starting ${role} [${runId}] → ${topTicket.id}: ${topTicket.title}`);
    this.agents[role].status = 'running';
    this.agents[role].current = topTicket.id;
    this.agents[role].runId = runId;
    this.agents[role].startedAt = new Date().toISOString();

    // Audit: session start
    this.pushAgentLog(role, `═══ AGENT SESSION START ═══`, {
      event: 'session-start',
      ticket: topTicket.id,
      ticketTitle: topTicket.title,
      ticketStatus: topTicket.status,
      ticketPriority: topTicket.priority,
      project: this.readBoard().project || 'unknown',
      branch: topTicket.branch || null,
      isResume: !!work.resume,
    });

    try {
      // Create an isolated git worktree so agents don't affect the main working tree
      const worktreePath = this.createWorktree(role, runId);
      if (!worktreePath) {
        this.agents[role].status = 'error';
        this.addLog('error', `Cannot start ${role} — worktree creation failed`);
        this.emit('agent-update', this.getAgentStates());
        return false;
      }
      this.agents[role].worktree = worktreePath;

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
        cwd: worktreePath,
        env: cleanEnv,
      });

      this.agents[role].process = proc;
      this.agents[role].pid = proc.pid;

      let output = '';
      let rateLimitHits = 0;
      let lineBuf = '';  // Buffer for incomplete lines from PTY chunks

      proc.onData((raw) => {
        const text = this.stripAnsi(raw);
        output += text;

        // Buffer lines — PTY sends arbitrary chunks, not full lines
        lineBuf += text;
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop(); // Keep incomplete trailing chunk

        for (const rawLine of parts) {
          const line = rawLine.trim();
          if (!line) continue;

          // Detect rate limit errors (works on both raw and parsed text)
          if (this.rateLimitPattern.test(line)) {
            rateLimitHits++;
            if (rateLimitHits === 1) {
              const resetMatch = line.match(/resets?\s+(.+)/i);
              const resetInfo = resetMatch ? resetMatch[1].trim() : 'unknown';
              this.rateLimitState = { detected: true, resetInfo, at: new Date().toISOString() };

              this.pushAgentLog(role, `⛔ RATE LIMITED — ${line}`);
              this.addLog('error', `${role} hit rate limit — ${resetInfo}. Stopping all agents.`);
              this.emit('rate-limit', { role, resetInfo, at: new Date().toISOString() });

              try { proc.kill('SIGTERM'); } catch (e) { /* already dying */ }
              for (const otherRole of Object.keys(this.agents)) {
                if (otherRole !== role && this.agents[otherRole].process) {
                  this.pushAgentLog(otherRole, `⛔ Stopped — account rate limit hit by ${role}`);
                  this.stopAgent(otherRole);
                }
              }
              this.agents[role].status = 'rate-limited';
              this.emit('agent-update', this.getAgentStates());
            }
            return;
          }

          // Try to parse as stream-json from claude
          let obj;
          try { obj = JSON.parse(line); } catch (e) {
            // Not JSON — emit as raw text (fallback)
            this.pushAgentLog(role, line);
            continue;
          }

          const msgType = obj.type || '';

          // Assistant message blocks (full message)
          if (msgType === 'assistant' && obj.message) {
            for (const block of (obj.message.content || [])) {
              if (block.type === 'text' && block.text) {
                for (const tl of block.text.split('\n').filter(l => l.trim())) {
                  this.pushAgentLog(role, tl);
                }
              }
            }
          }

          // Streaming text deltas
          else if (msgType === 'content_block_delta') {
            const delta = obj.delta || {};
            if (delta.type === 'text_delta' && delta.text) {
              for (const tl of delta.text.split('\n').filter(l => l.trim())) {
                this.pushAgentLog(role, tl);
              }
            }
          }

          // Tool use — show what the agent is doing
          else if (msgType === 'tool_use') {
            const name = obj.name || obj.tool || 'unknown';
            const inp = obj.input || {};
            if (name === 'Read') {
              this.pushAgentLog(role, `[tool] Reading: ${inp.file_path || '?'}`);
            } else if (name === 'Write') {
              this.pushAgentLog(role, `[tool] Writing: ${inp.file_path || '?'}`);
            } else if (name === 'Edit') {
              this.pushAgentLog(role, `[tool] Editing: ${inp.file_path || '?'}`);
            } else if (name === 'Bash') {
              this.pushAgentLog(role, `[tool] Bash: ${String(inp.command || '?').slice(0, 80)}`);
            } else if (name === 'Grep') {
              this.pushAgentLog(role, `[tool] Grep: ${inp.pattern || '?'}`);
            } else if (name === 'Glob') {
              this.pushAgentLog(role, `[tool] Glob: ${inp.pattern || '?'}`);
            } else {
              this.pushAgentLog(role, `[tool] ${name}`);
            }
          }

          // Final result
          else if (msgType === 'result') {
            for (const block of (obj.content || [])) {
              if (block.type === 'text' && block.text) {
                for (const tl of block.text.split('\n').filter(l => l.trim())) {
                  this.pushAgentLog(role, tl);
                }
              }
            }
          }

          // System/init messages — skip silently
          // else: ignore unknown types
        }
      });

      proc.onExit(({ exitCode }) => {
        const startedAt = this.agents[role].startedAt;
        const duration = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : null;
        const exitStatus = rateLimitHits > 0 ? 'rate-limited'
          : exitCode === 0 ? 'success' : `error (code ${exitCode})`;

        // Audit: session end
        this.pushAgentLog(role, `═══ AGENT SESSION END ═══`, {
          event: 'session-end',
          ticket: topTicket.id,
          exitCode,
          exitStatus,
          durationSec: duration,
          rateLimitHits,
        });

        // Clean up the worktree after agent exits
        const wtPath = this.agents[role].worktree;
        if (wtPath) {
          this.removeWorktree(role, wtPath);
        }

        this.agents[role].process = null;
        this.agents[role].pid = null;
        this.agents[role].current = null;
        this.agents[role].runId = null;
        this.agents[role].startedAt = null;
        this.agents[role].worktree = null;

        // Preserve rate-limited and stopped statuses — don't reset to idle
        if (this.agents[role].status !== 'rate-limited' && this.agents[role].status !== 'stopped') {
          this.agents[role].status = 'idle';
        }

        if (rateLimitHits > 0) {
          this.addLog('error', `${role} killed after rate limit (${rateLimitHits} retries suppressed)`);
        } else if (exitCode === 0) {
          this.addLog('success', `${role} completed task on ${topTicket.id} (${duration}s)`);
        } else {
          this.addLog('error', `${role} exited with code ${exitCode} after ${duration}s: ${output.slice(-200)}`);
        }

        this.emit('agent-update', this.getAgentStates());
        this.emit('board-change', this.getFullState());

        // In auto mode, check if there's more work after a delay
        // But NOT if the agent was manually stopped
        if (this.autoMode && this.agents[role].status !== 'stopped') {
          setTimeout(() => this.evaluateAndDispatch(), 2000);
        }
      });

      this.emit('agent-update', this.getAgentStates());
      return true;

    } catch (err) {
      // Clean up worktree if spawn failed
      const wtPath = this.agents[role].worktree;
      if (wtPath) {
        this.removeWorktree(role, wtPath);
        this.agents[role].worktree = null;
      }
      this.agents[role].status = 'error';
      this.addLog('error', `Failed to spawn ${role}: ${err.message}`);
      this.emit('agent-update', this.getAgentStates());
      return false;
    }
  }

  stopAgent(role) {
    const agent = this.agents[role];
    if (agent.process) {
      const pid = agent.pid;
      // SIGTERM first, then SIGKILL after 3s if still alive
      agent.process.kill('SIGTERM');
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (e) { /* already dead */ }
      }, 3000);
      // Also kill the entire process group to catch child processes (claude spawns subprocesses)
      try { process.kill(-pid, 'SIGTERM'); } catch (e) { /* no process group */ }
      this.addLog('warn', `Stopped ${role} (PID: ${pid})`);
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
      if (this.agents[role].status === 'stopped') continue;
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
    // Poll for new work every 10s while auto mode is on
    this._autoInterval = setInterval(() => {
      if (this.autoMode) this.evaluateAndDispatch();
    }, 10000);
  }

  stopAutoMode() {
    this.autoMode = false;
    if (this._autoInterval) { clearInterval(this._autoInterval); this._autoInterval = null; }
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
    const historyPath = path.join(this.historyDir,
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
    const historyPath = path.join(this.historyDir, filename);
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
        runId: agent.runId || null,
        startedAt: agent.startedAt || null,
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
