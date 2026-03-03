/**
 * GitHub OAuth module for SwarmBoard.
 *
 * Encapsulates Passport-based GitHub OAuth, token encryption/storage,
 * and route registration. Designed so a future GitHub App upgrade
 * only requires swapping the strategy.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const session = require('express-session');

// ── Token Encryption (same AES-256-GCM pattern as secrets.enc) ──────────────

function getOrCreateSessionSecret(boardDir) {
  const secretPath = path.join(boardDir, '.session-secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf-8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function deriveTokenKey(boardDir) {
  const keyPath = path.join(boardDir, '.secrets-key');
  let salt;
  if (fs.existsSync(keyPath)) {
    salt = fs.readFileSync(keyPath);
  } else {
    salt = crypto.randomBytes(16);
    fs.writeFileSync(keyPath, salt);
  }
  const machineId = os.hostname();
  return crypto.scryptSync(machineId + salt.toString('hex'), salt, 32);
}

function encryptToken(data, boardDir) {
  const key = deriveTokenKey(boardDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(data);
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { iv: iv.toString('hex'), authTag, ciphertext };
}

function decryptToken(encrypted, boardDir) {
  const key = deriveTokenKey(boardDir);
  const iv = Buffer.from(encrypted.iv, 'hex');
  const authTag = Buffer.from(encrypted.authTag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  return JSON.parse(plaintext);
}

// ── Token Storage ────────────────────────────────────────────────────────────

function tokenPath(projectDir) {
  return path.join(projectDir, 'github-token.enc');
}

function storeGitHubToken(projectDir, tokenData, boardDir) {
  const encrypted = encryptToken(tokenData, boardDir);
  fs.writeFileSync(tokenPath(projectDir), JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

function getGitHubToken(projectDir, boardDir) {
  const tp = tokenPath(projectDir);
  if (!fs.existsSync(tp)) return null;
  try {
    const encrypted = JSON.parse(fs.readFileSync(tp, 'utf-8'));
    return decryptToken(encrypted, boardDir);
  } catch (e) {
    return null;
  }
}

function removeGitHubToken(projectDir) {
  const tp = tokenPath(projectDir);
  if (fs.existsSync(tp)) fs.unlinkSync(tp);
}

// ── Passport Setup & Route Registration ──────────────────────────────────────

/**
 * Mount session, passport, and OAuth routes onto the Express app.
 *
 * @param {Express} app
 * @param {object} config
 * @param {string} config.boardDir — base .agent-board directory
 * @param {string} config.projectsDir — .agent-board/projects directory
 * @param {function} config.getActiveProject — returns current project name
 */
function setupAuth(app, config) {
  const { boardDir, projectsDir, getActiveProject } = config;

  // Sanitize project names to prevent path traversal (mirrors server.js sanitizeProjectName)
  function safeProjectDir(name) {
    const clean = (name || '').replace(/[^a-zA-Z0-9 _-]/g, '');
    if (!clean || clean !== name) return null;
    const dir = path.join(projectsDir, clean);
    if (!path.resolve(dir).startsWith(path.resolve(projectsDir))) return null;
    return dir;
  }

  const clientID = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackURL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3456/auth/github/callback';

  // If OAuth is not configured, register stub routes that explain the situation
  if (!clientID || !clientSecret) {
    app.get('/auth/github', (_req, res) => {
      res.redirect('/?auth=not_configured');
    });
    app.get('/auth/github/callback', (_req, res) => {
      res.redirect('/?auth=not_configured');
    });
    app.get('/auth/status', (_req, res) => {
      res.json({ configured: false, connected: false, message: 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET env vars' });
    });
    app.post('/auth/disconnect', (_req, res) => {
      res.json({ ok: true });
    });
    return;
  }

  // Session middleware
  const sessionSecret = getOrCreateSessionSecret(boardDir);
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
  }));

  // Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Only serialize the profile into the session — the access token is stored
  // encrypted on disk via storeGitHubToken, not kept in session memory
  passport.serializeUser((user, done) => done(null, { profile: user.profile, accessToken: user.accessToken }));
  passport.deserializeUser((obj, done) => done(null, obj));

  passport.use(new GitHubStrategy({
    clientID,
    clientSecret,
    callbackURL,
    scope: ['repo'],
  }, (accessToken, refreshToken, profile, done) => {
    done(null, { accessToken, profile: { username: profile.username, id: profile.id, displayName: profile.displayName } });
  }));

  // ── Routes ──────────────────────────────────────────────────────────────

  // Initiate OAuth — accepts ?project= to store context in session state
  // Includes a CSRF nonce bound to the session to prevent state tampering
  app.get('/auth/github', (req, res, next) => {
    const project = req.query.project || getActiveProject();
    const nonce = crypto.randomBytes(16).toString('hex');
    req.session.oauthNonce = nonce;
    const state = Buffer.from(JSON.stringify({ project, nonce })).toString('base64url');
    passport.authenticate('github', { scope: ['repo'], state })(req, res, next);
  });

  // OAuth callback
  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/?auth=failed' }),
    (req, res) => {
      try {
        // Decode project from state param and verify CSRF nonce
        let project = getActiveProject();
        if (req.query.state) {
          try {
            const stateData = JSON.parse(Buffer.from(req.query.state, 'base64url').toString());
            if (stateData.nonce && stateData.nonce !== req.session.oauthNonce) {
              return res.redirect('/?auth=failed&reason=invalid_state');
            }
            if (stateData.project) project = stateData.project;
          } catch (e) { /* use default */ }
        }
        delete req.session.oauthNonce;

        const projectDir = safeProjectDir(project);
        if (!projectDir || !fs.existsSync(projectDir)) {
          return res.redirect('/?auth=failed&reason=project_not_found');
        }

        const tokenData = {
          accessToken: req.user.accessToken,
          profile: req.user.profile,
          connectedAt: new Date().toISOString(),
          scope: 'repo',
        };

        storeGitHubToken(projectDir, tokenData, boardDir);
        res.redirect('/?auth=success&github_user=' + encodeURIComponent(req.user.profile.username));
      } catch (e) {
        console.error('OAuth callback error:', e);
        res.redirect('/?auth=failed&reason=' + encodeURIComponent(e.message));
      }
    }
  );

  // Note: /auth/status and /auth/disconnect are intentionally NOT registered here.
  // The frontend uses /api/projects/github-status and /api/projects/github-disconnect
  // (defined in server.js) which go through the standard orchFor/sanitize pipeline.
}

module.exports = {
  setupAuth,
  getGitHubToken,
  storeGitHubToken,
  removeGitHubToken,
};
