// Integrated terminal backend: interactive shell sessions for the active
// Terraform project, rendered in the browser with xterm.js.
//
// Architecture (see README "Integrated terminal"):
//   - node-pty spawns the user's shell in a PTY; output streams to one viewer
//     over SSE, input and resize arrive as JSON requests.
//   - Sessions are bound to their starting directory (an allowed root) and run
//     with the TerraCode process's OS permissions — no privilege elevation.
//   - Every session operation requires the instance-scoped token
//     (X-TerraCode-Token header) plus loopback Host/Origin validation; the
//     custom header forces a CORS preflight, which only the Vite UI origins
//     pass. Origin handling: absent = non-browser local client (allowed),
//     "null" = unauthorized browser context (rejected).
//   - Shell environment: process.env as-is, minus the app-internal token.
//     Vault/cloud credentials never live in process.env (they are injected per
//     terraform run from the encrypted store), so they cannot reach a shell;
//     user-supplied startup variables (Mirage endpoints, TF_* settings) pass
//     through untouched. Opening or restarting a terminal never logs into a
//     cloud provider.
//
// Session states: starting | running | exited | closed | failed.
//   - minimize is client-side only: the panel hides but the SSE connection and
//     shell stay alive; restoring reconnects to the same session.
//   - a session that never gets a viewer within VIEWER_TIMEOUT_MS is closed;
//     when a running session's viewer disconnects, the shell is terminated.
//   - closing (or any termination) kills the shell and its remaining child
//     processes: SIGHUP first, then SIGKILL to the whole process group.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- node-pty loading (optional and isolated) -------------------------------
// The native addon is required lazily so an absent or unsupported build never
// prevents TerraCode from starting: the terminal feature simply reports itself
// unavailable with an actionable message.

let ptyModule = null; // resolved module, once loaded
let ptyLoadError = null; // reason string when loading failed
let ptyLoaderOverride = null; // test-only replacement for require('node-pty')

function loadPty() {
  if (ptyModule !== null || ptyLoadError !== null) return ptyModule;
  try {
    const loader = ptyLoaderOverride || (() => require('node-pty'));
    ptyModule = loader();
  } catch (err) {
    ptyModule = null;
    ptyLoadError = err && err.code === 'MODULE_NOT_FOUND'
      ? 'the node-pty native module is not installed — install TerraCode from source on Linux or WSL and run npm ci'
      : `node-pty could not be loaded (${err.message})`;
  }
  return ptyModule;
}

function terminalAvailability() {
  if (process.env.TERMINAL_DISABLE === '1') {
    return { available: false, reason: 'the terminal feature is disabled on this server (TERMINAL_DISABLE=1)' };
  }
  const pty = loadPty();
  if (!pty) return { available: false, reason: ptyLoadError };
  return { available: true };
}

// --- configuration ----------------------------------------------------------

const MAX_SESSIONS = Number(process.env.TERMINAL_MAX_SESSIONS) || 4; // proposed cap on LIVE sessions
// Finished records are kept so their status can be revisited, but they must not
// block new terminals forever: evict the oldest dead ones past this total.
const MAX_SESSION_RECORDS = 16;

const isLiveState = state => state === 'starting' || state === 'running';

// Read per session so tests (and operators restarting with a new value) can
// override it without a code change; the default is the proposed 15 seconds.
function viewerTimeoutMs() {
  return Number(process.env.TERMINAL_VIEWER_TIMEOUT_MS) || 15_000;
}
const SLOW_CLIENT_MS = 30_000; // a viewer that never drains is not waited on forever
const BUFFER_MAX_BYTES = 64 * 1024; // pre-viewer output kept for replay, oldest dropped first
const INPUT_MAX_BYTES = 256 * 1024; // per input request
const RESIZE_MIN = 1;
const RESIZE_MAX = 500;
const SSE_HEARTBEAT_MS = 15_000;

// Instance-scoped authorization secret for the UI client. Pinnable via env for
// automation; otherwise 256 bits of cryptographic randomness per server start,
// so a stale token from another instance is useless here. Never sent in URLs
// and never written to logs or terminal output.
const TERMINAL_TOKEN = process.env.TERACODE_TERMINAL_TOKEN || crypto.randomBytes(32).toString('hex');

function tokenMatches(header) {
  if (typeof header !== 'string' || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(TERMINAL_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- session store ----------------------------------------------------------

const sessions = new Map(); // id -> record

function newSessionId() {
  return crypto.randomBytes(16).toString('hex'); // 128-bit identifier
}

// Shell resolution: an explicit operator override (TERMINAL_SHELL), then the
// user's $SHELL, then common defaults. Only absolute existing files are used;
// arguments stay empty so node-pty receives the executable and args separately
// and the shell starts interactively from the PTY itself.
function resolveShell() {
  const candidates = [process.env.TERMINAL_SHELL, process.env.SHELL];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return { file: candidate, args: [] };
    } catch {
      // not there — keep looking
    }
  }
  for (const fallback of ['/bin/bash', '/bin/sh']) {
    try {
      if (fs.statSync(fallback).isFile()) return { file: fallback, args: [] };
    } catch {
      // keep looking
    }
  }
  return null;
}

// Environment for a new shell: whatever spawnEnvProvider supplies, falling back
// to the server's environment as-is (so intentionally supplied startup variables
// — Mirage endpoints, Terraform settings — are preserved). The host app uses the
// provider to mirror its button-triggered terraform runs into interactive shells:
// tfenv's bin dir on PATH plus cloud credentials for active login sessions,
// computed fresh at every spawn/restart so a new shell sees current state. The
// app-internal authorization secret never reaches a shell either way.
// The provider is threaded per call (not stored in shared module state) so that
// multiple host-app instances — e.g. a test re-importing server.cjs after
// vi.resetModules() while terminal.cjs stays cached — each keep their own env
// source instead of the last-registered one overwriting the rest.
function terminalSpawnEnv(envProvider) {
  const env = typeof envProvider === 'function' ? { ...envProvider() } : { ...process.env };
  delete env.TERACODE_TERMINAL_TOKEN;
  return env;
}

// Signal every process of a Linux session by enumerating /proc. node-pty's
// forkpty makes each shell a session leader (session id == its pid), and an
// interactive shell puts background jobs in their own process groups — so the
// group alone cannot reach them, but they all stay in the same session.
// No-op off Linux (Windows cleanup is best-effort through node-pty itself).
function signalSession(sessionId, signal) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return; // not a /proc filesystem
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
    } catch {
      continue; // process vanished mid-scan
    }
    // comm may contain spaces or parentheses: the numeric fields start after
    // the last ')'. Layout there: state ppid pgrp session ...
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) continue;
    const fields = stat.slice(closeParen + 2).split(' ');
    if (fields[3] !== String(sessionId)) continue;
    try {
      process.kill(Number(entry), signal);
    } catch {
      // ESRCH — already gone
    }
  }
}

// Terminate every shell this session has spawned and their remaining children,
// platform-appropriately: SIGHUP to each whole session first (the PTY's normal
// hangup), then SIGKILL after a short grace period. Covers orphans left behind
// by earlier incarnations of a restarted session too. (Theoretical pid reuse
// between death and teardown is accepted, as in real terminal emulators.)
function terminatePids(record) {
  const pids = record.pids;
  record.pids = [];
  if (pids.length === 0) return;
  for (const pid of pids) signalSession(pid, 'SIGHUP');
  setTimeout(() => {
    for (const pid of pids) signalSession(pid, 'SIGKILL');
  }, 2_000).unref();
}

// Terminate the live shell (and all previous incarnations' groups) and make
// sure the record is finalized even in pathological cases, so no timers,
// viewers or buffers outlive the close request.
function killShell(record) {
  const pty = record.pty;
  if (!pty || !pty.pid) return;
  record.pty = null; // no further output events from here on
  try {
    pty.kill();
  } catch {
    // already gone
  }
  terminatePids(record);
  setTimeout(() => {
    if (record.state === 'starting' || record.state === 'running') {
      releaseRecord(record, 'closed', { closeReason: record.closeReason ?? 'user' });
      endViewers(record, { type: 'closed', reason: record.closeReason ?? 'user' });
    }
  }, 5_000).unref();
}

function clearTimers(record) {
  if (record.viewerTimer !== null) {
    clearTimeout(record.viewerTimer);
    record.viewerTimer = null;
  }
  if (record.slowClientTimer !== null) {
    clearTimeout(record.slowClientTimer);
    record.slowClientTimer = null;
  }
}

// Full teardown for a session that will not run again: drop the PTY reference,
// timers and buffered output. The record itself stays in the map so its status
// (exit code, close reason) can be revisited.
function releaseRecord(record, state, extra) {
  clearTimers(record);
  record.state = state;
  record.pty = null;
  record.buffer = [];
  record.bufferBytes = 0;
  for (const [key, value] of Object.entries(extra ?? {})) record[key] = value;
}

// End every live viewer stream of a session with one final frame, then drop the
// viewers. The records themselves stay so their status can be revisited.
function endViewers(record, frame) {
  const viewers = [...record.viewers];
  record.viewers.clear();
  for (const res of viewers) {
    try {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        res.end();
      }
    } catch {
      // already disconnected
    }
  }
}

function closeSession(record, reason) {
  if (record.state === 'closed') return;
  record.closeReason = reason;
  const hadShell = record.pty !== null && (record.state === 'starting' || record.state === 'running');
  endViewers(record, { type: 'closed', reason });
  if (hadShell) {
    record.closing = true; // the exit event finalizes this as 'closed', not 'exited'
    killShell(record);
  } else {
    terminatePids(record); // no live shell, but earlier incarnations may have orphans
    releaseRecord(record, 'closed');
  }
}

// Spawn a shell for a record that is in 'starting' or being restarted.
function spawnFor(record, envProvider) {
  const pty = loadPty();
  if (!pty) {
    releaseRecord(record, 'failed', { failReason: ptyLoadError });
    endViewers(record, { type: 'error', message: ptyLoadError });
    return;
  }
  const shell = resolveShell();
  if (!shell) {
    releaseRecord(record, 'failed', { failReason: 'no usable shell found (set TERMINAL_SHELL to an absolute path)' });
    endViewers(record, { type: 'error', message: record.failReason });
    return;
  }
  let child;
  try {
    child = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: record.cols,
      rows: record.rows,
      cwd: record.dir,
      env: terminalSpawnEnv(envProvider),
    });
  } catch (err) {
    releaseRecord(record, 'failed', { failReason: `could not start the shell (${err.message})` });
    endViewers(record, { type: 'error', message: record.failReason });
    return;
  }

  record.pty = child;
  record.pids.push(child.pid); // tracked so close/restart can reap its whole group later
  const onData = data => {
    if (record.state === 'starting') record.state = 'running'; // first output: the shell is up
    pushOutput(record, data);
  };
  child.onData(onData);
  child.on('error', err => {
    // node-pty emits a "read EIO" error as part of its normal exit sequence
    // (slave side closing) right before the real 'exit' event — on both user
    // exits and our own kills. Only non-EIO errors are genuine failures, and
    // nothing is reported while an intentional close is in flight.
    if (record.closing === true || err.code === 'EIO' || /read EIO/.test(err.message)) return;
    child.removeListener('data', onData);
    if (record.state !== 'starting' && record.state !== 'running') return; // already finalized
    releaseRecord(record, 'failed', { failReason: `the shell process failed (${err.message})` });
    endViewers(record, { type: 'error', message: record.failReason });
  });
  child.onExit(({ exitCode, signal }) => {
    child.removeListener('data', onData);
    const closing = record.closing === true;
    delete record.closing;
    if (record.state !== 'starting' && record.state !== 'running') return; // already finalized
    // node-pty reports signal 0 (not a real signal) when the shell exits normally.
    const sig = signal || null;
    releaseRecord(record, closing ? 'closed' : 'exited', { exitStatus: exitCode ?? null, exitSignal: sig });
    endViewers(record, closing
      ? { type: 'closed', reason: record.closeReason }
      : { type: 'exit', status: exitCode ?? null, signal: sig });
  });
}

// Pre-viewer output is buffered (bounded) so an early prompt survives until the
// first stream attaches; with a live viewer it goes straight to the SSE writes.
function pushOutput(record, data) {
  if (record.viewers.size === 0) {
    record.buffer.push(Buffer.from(data));
    record.bufferBytes += data.length;
    while (record.bufferBytes > BUFFER_MAX_BYTES && record.buffer.length > 1) {
      record.bufferBytes -= record.buffer.shift().length;
    }
    if (record.bufferBytes > BUFFER_MAX_BYTES) {
      record.buffer = [Buffer.from(record.buffer.join('').slice(-BUFFER_MAX_BYTES))];
      record.bufferBytes = record.buffer[0].length;
    }
    return;
  }
  for (const res of [...record.viewers]) {
    writeFrameBackpressured(record, res, { type: 'data', text: data.toString('utf-8') });
  }
}

// SSE writes with backpressure: a slow viewer pauses the PTY itself (the shell
// blocks on its own output instead of growing our buffers without bound) and is
// resumed on drain. A viewer that never drains for SLOW_CLIENT_MS closes the
// session rather than hanging the shell forever.
function writeFrameBackpressured(record, res, frame) {
  let ok = true;
  try {
    ok = res.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch {
    return; // connection already gone; 'close' cleans up the viewer
  }
  if (!ok && record.pty) {
    record.pty.pause();
    const resume = () => {
      try {
        record.pty?.resume();
      } catch {
        // pty already dead
      }
      if (record.slowClientTimer !== null) {
        clearTimeout(record.slowClientTimer);
        record.slowClientTimer = null;
      }
    };
    res.once('drain', resume);
    if (record.slowClientTimer === null) {
      record.slowClientTimer = setTimeout(() => closeSession(record, 'slow-client'), SLOW_CLIENT_MS);
      record.slowClientTimer.unref();
    }
  }
}

function startViewerTimeout(record) {
  record.viewerTimer = setTimeout(() => {
    if (record.state === 'starting' || record.state === 'running') {
      closeSession(record, 'timeout'); // never acquired a viewer in time
    }
  }, viewerTimeoutMs());
  record.viewerTimer.unref();
}

// --- request guards ---------------------------------------------------------

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

function hostAllowed(req, port) {
  const header = req.headers.host;
  if (typeof header !== 'string') return false;
  const value = header.trim();
  for (const name of LOOPBACK_HOSTS) {
    if (value === `${name}:${port}` || value === name) return true;
  }
  return false;
}

// Origin policy: an exact UI origin is allowed, an absent Origin marks a
// non-browser local client (allowed — it still needs the token for session
// operations), and everything else — including the literal "null" sent by
// file:// pages and sandboxed iframes — is rejected.
function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  return allowedOrigins.includes(origin);
}

// requireTerminalAuth guards every session operation: loopback Host, Origin
// policy, and the instance token. /token and /status use only the first two.
function makeGuards(port, allowedOrigins) {
  const checkHostAndOrigin = (req, res) => {
    if (!hostAllowed(req, port)) {
      res.status(403).json({ error: 'Invalid Host header — this API is loopback-only' });
      return false;
    }
    if (!originAllowed(req, allowedOrigins)) {
      res.status(403).json({ error: 'Origin not allowed for the terminal API' });
      return false;
    }
    return true;
  };
  const requireAuth = (req, res) => {
    if (!checkHostAndOrigin(req, res)) return false;
    if (!tokenMatches(req.headers['x-terracode-token'])) {
      res.status(401).json({ error: 'Missing or invalid X-TerraCode-Token header' });
      return false;
    }
    return true;
  };
  return { checkHostAndOrigin, requireAuth };
}

function findSession(req, res) {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
    res.status(400).json({ error: 'Invalid session identifier' });
    return null;
  }
  const record = sessions.get(id);
  if (!record) {
    res.status(404).json({ error: 'Unknown terminal session — it may have been closed or expired' });
    return null;
  }
  return record;
}

// --- routes -----------------------------------------------------------------

function createTerminalApi(app, { resolveSafe, respondResolve, port, allowedOrigins, spawnEnvProvider: envProvider }) {
  // envProvider is captured by the route closures below (per app instance), so
  // re-registering the API on another express app never changes this one's env.
  const { checkHostAndOrigin, requireAuth } = makeGuards(port, allowedOrigins);

  // Instance token for the UI client. Guarded by Host/Origin only (the token is
  // what session operations then require). No-store: it must not be cached.
  app.get('/api/terminal/token', (req, res) => {
    if (!checkHostAndOrigin(req, res)) return;
    res.set('Cache-Control', 'no-store');
    res.json({ token: TERMINAL_TOKEN });
  });

  // Informational availability probe (no session data): lets the UI decide
  // whether to offer the Terminal button at all.
  app.get('/api/terminal/status', (req, res) => {
    if (!checkHostAndOrigin(req, res)) return;
    const status = terminalAvailability();
    res.set('Cache-Control', 'no-store');
    res.json({ available: status.available, ...(status.reason ? { reason: status.reason } : {}), maxSessions: MAX_SESSIONS });
  });

  // List session records (live and finished) so a reopened panel can restore.
  app.get('/api/terminal/sessions', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json({
      sessions: [...sessions.values()].map(s => ({
        id: s.id,
        state: s.state,
        dir: s.dir,
        ...(s.exitStatus !== null && s.exitStatus !== undefined ? { exitStatus: s.exitStatus } : {}),
        ...(s.failReason ? { failReason: s.failReason } : {}),
        ...(s.closeReason ? { closeReason: s.closeReason } : {}),
      })),
    });
  });

  // Create a session in an allowed project directory. All validation happens
  // before any PTY is allocated; shell commands later run independently of the
  // API busy locks (they are ordinary user shell activity, not toolbar ops).
  app.post('/api/terminal/sessions', (req, res) => {
    if (!requireAuth(req, res)) return;

    const status = terminalAvailability();
    if (!status.available) {
      return res.status(503).json({ error: `Terminal unavailable: ${status.reason}` });
    }
    // The cap counts live sessions only; finished records are status notes and
    // do not hold a shell, so they never block new terminals.
    const liveCount = [...sessions.values()].filter(s => isLiveState(s.state)).length;
    if (liveCount >= MAX_SESSIONS) {
      return res.status(409).json({ error: `Session limit reached (${MAX_SESSIONS}) — close an existing terminal first` });
    }
    while (sessions.size >= MAX_SESSION_RECORDS) {
      const oldestDead = [...sessions.entries()].find(([, s]) => !isLiveState(s.state))?.[0];
      if (!oldestDead) break; // only live sessions remain; the cap above already applied
      sessions.delete(oldestDead);
    }

    const body = req.body ?? {};
    const rawPath = typeof body.path === 'string' ? body.path : '';
    if (!rawPath) {
      return res.status(400).json({ error: 'Body must include a non-empty path string' });
    }
    const resolved = resolveSafe(rawPath);
    if (!respondResolve(res, resolved)) return;
    try {
      if (!fs.statSync(resolved.path).isDirectory()) {
        return res.status(400).json({ error: 'Path must be a directory' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
    }

    const record = {
      id: newSessionId(),
      dir: resolved.path, // bound to the starting project; never redirected later
      state: 'starting',
      exitStatus: null,
      exitSignal: null,
      failReason: null,
      closeReason: null,
      pty: null,
      pids: [],
      viewers: new Set(),
      buffer: [],
      bufferBytes: 0,
      viewerTimer: null,
      slowClientTimer: null,
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
    };
    sessions.set(record.id, record);
    startViewerTimeout(record);
    spawnFor(record, envProvider);

    res.status(201).json({ id: record.id, state: record.state, dir: record.dir });
  });

  // SSE output stream. One viewer per session; the connection staying open is
  // what keeps a minimized panel alive. When it really disconnects (or the
  // session ends), the shell is terminated and the record keeps its status.
  app.get('/api/terminal/sessions/:id/stream', (req, res) => {
    if (!requireAuth(req, res)) return;
    const record = findSession(req, res);
    if (!record) return;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const send = obj => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // client already disconnected; 'close' ends the response below
      }
    };

    if (record.state === 'exited') {
      send({ type: 'hello', state: record.state, dir: record.dir });
      send({ type: 'exit', status: record.exitStatus, signal: record.exitSignal });
      res.end();
      return;
    }
    if (record.state === 'closed' || record.state === 'failed') {
      send({ type: 'hello', state: record.state, dir: record.dir });
      send(record.state === 'failed'
        ? { type: 'error', message: record.failReason ?? 'The terminal session failed to start' }
        : { type: 'closed', reason: record.closeReason ?? 'user' });
      res.end();
      return;
    }

    // Live (starting/running): attach as the viewer.
    send({ type: 'hello', state: record.state, dir: record.dir });
    if (record.viewerTimer !== null) {
      clearTimeout(record.viewerTimer);
      record.viewerTimer = null;
    }
    if (record.bufferBytes > 0) {
      send({ type: 'replay', text: Buffer.concat(record.buffer).toString('utf-8') });
      record.buffer = [];
      record.bufferBytes = 0;
    }
    record.viewers.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': hb\n');
      } catch {
        // connection already closed; 'close' cleans up below
      }
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (!record.viewers.delete(res)) return; // stream already ended server-side
      if (record.state === 'starting' || record.state === 'running') {
        closeSession(record, 'viewer-disconnect');
      }
    });
  });

  // Forward raw PTY input. No command interpolation happens here — the bytes go
  // to the shell's PTY exactly as typed; only type and size are validated.
  app.post('/api/terminal/sessions/:id/input', (req, res) => {
    if (!requireAuth(req, res)) return;
    const record = findSession(req, res);
    if (!record) return;

    const body = req.body ?? {};
    const data = typeof body.data === 'string' ? body.data : null;
    if (data === null) {
      return res.status(400).json({ error: 'Body must include a string "data" field' });
    }
    if (Buffer.byteLength(data, 'utf-8') > INPUT_MAX_BYTES) {
      return res.status(400).json({ error: `Input too large (limit ${INPUT_MAX_BYTES / 1024} KB per request)` });
    }
    if (record.state !== 'running' && record.state !== 'starting') {
      return res.status(409).json({ error: `The session is ${record.state} — restart it to send input` });
    }
    if (!record.pty) {
      return res.status(503).json({ error: 'The shell process is not available' });
    }
    try {
      record.pty.write(data);
    } catch (err) {
      return res.status(500).json({ error: `Failed to write to the terminal (${err.message})` });
    }
    res.json({ ok: true });
  });

  // Resize the PTY; dimensions are validated before touching the process.
  app.post('/api/terminal/sessions/:id/resize', (req, res) => {
    if (!requireAuth(req, res)) return;
    const record = findSession(req, res);
    if (!record) return;

    const body = req.body ?? {};
    const cols = body.cols;
    const rows = body.rows;
    for (const [name, value] of [['cols', cols], ['rows', rows]]) {
      if (!Number.isInteger(value) || value < RESIZE_MIN || value > RESIZE_MAX) {
        return res.status(400).json({ error: `${name} must be an integer between ${RESIZE_MIN} and ${RESIZE_MAX}` });
      }
    }
    if (record.state !== 'running' && record.state !== 'starting') {
      return res.status(409).json({ error: `The session is ${record.state} — resize needs a live shell` });
    }
    if (!record.pty) {
      return res.status(503).json({ error: 'The shell process is not available' });
    }
    record.cols = cols;
    record.rows = rows;
    try {
      record.pty.resize(cols, rows);
    } catch (err) {
      return res.status(500).json({ error: `Failed to resize the terminal (${err.message})` });
    }
    res.json({ ok: true });
  });

  // Explicit restart after exit/failure: a brand-new shell in the same bound
  // directory with a fresh environment snapshot (documented behavior — existing
  // sessions keep their own environment until restarted). No cloud login is
  // performed here or anywhere in the terminal path.
  app.post('/api/terminal/sessions/:id/restart', (req, res) => {
    if (!requireAuth(req, res)) return;
    const record = findSession(req, res);
    if (!record) return;

    if (record.state !== 'exited' && record.state !== 'failed') {
      return res.status(409).json({ error: `Only exited or failed sessions can be restarted (this one is ${record.state})` });
    }
    const status = terminalAvailability();
    if (!status.available) {
      return res.status(503).json({ error: `Terminal unavailable: ${status.reason}` });
    }

    terminatePids(record); // a restart is a clean slate: reap the old shell's orphans too
    record.exitStatus = null;
    record.exitSignal = null;
    record.failReason = null;
    record.closeReason = null;
    record.buffer = [];
    record.bufferBytes = 0;
    record.state = 'starting';
    startViewerTimeout(record);
    spawnFor(record, envProvider);
    res.json({ id: record.id, state: record.state });
  });

  // Close a session in any state: release the PTY, timers, listeners and
  // viewers, terminate the shell and its children, keep the record for status.
  app.post('/api/terminal/sessions/:id/close', (req, res) => {
    if (!requireAuth(req, res)) return;
    const record = findSession(req, res);
    if (!record) return;

    closeSession(record, 'user');
    // A live shell finalizes asynchronously on its exit event; answer now with
    // the intended state so the UI does not have to poll.
    res.json({ id: record.id, state: record.state === 'closed' ? 'closed' : 'closing', dir: record.dir });
  });

  return { requireAuth };
}

// Application shutdown (server stop / pilot exit): terminate every session so
// no shell outlives the TerraCode process.
function stopAllTerminalSessions() {
  for (const record of [...sessions.values()]) {
    closeSession(record, 'shutdown');
  }
}

// Test-only: drop the cached node-pty load result so both availability branches
// can be exercised in one process (the cache is otherwise sticky by design).
function resetPtyCacheForTests() {
  ptyModule = null;
  ptyLoadError = null;
}

// Test-only: replace the node-pty loader (e.g. with a function that throws
// MODULE_NOT_FOUND) and clear the cache so the next load uses it. Pass null to
// restore the real require-based loader.
function setPtyLoaderForTests(loader) {
  ptyLoaderOverride = typeof loader === 'function' ? loader : null;
  resetPtyCacheForTests();
}

module.exports = { createTerminalApi, stopAllTerminalSessions, terminalAvailability, resetPtyCacheForTests, setPtyLoaderForTests };
