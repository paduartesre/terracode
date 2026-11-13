// Backend API for FileExplorer directory listings and file contents
// Run with: node server.cjs
// Set BASE_DIR env var to change the primary root (default: this project's
// directory) and/or BASE_DIRS (':'-separated) to allow extra roots. More roots
// can be added at runtime via POST /api/roots (e.g. opening another repo).
// Terraform runs through tfenv when ~/.tfenv/bin exists (TFENV_BIN overrides,
// TFENV_DISABLE=1 turns it off); per-folder version = <dir>/.terraform-version.

const express = require('express');
const cors = require('cors');
const chokidar = require('chokidar');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Security: restrict access to the allowed roots below. BASE_DIR is the primary
// root (relative paths resolve against it); EXTRA_ROOTS_STATIC come from the
// BASE_DIRS env var and EXTRA_ROOTS are added at runtime via POST /api/roots.
const BASE_DIR = process.env.BASE_DIR || __dirname;
const EXTRA_ROOTS_STATIC = (process.env.BASE_DIRS || '')
  .split(/[:;]/)
  .map(s => s.trim())
  .filter(Boolean);
const MAX_EXTRA_ROOTS = 16; // cap on runtime-added roots
const EXTRA_ROOTS = []; // realpaths added at runtime via POST /api/roots

function allRoots() {
  return [BASE_DIR, ...EXTRA_ROOTS_STATIC, ...EXTRA_ROOTS];
}

// Response payload for /api/roots: every allowed root plus the subset added at
// runtime (and therefore removable via DELETE). BASE_DIR and static BASE_DIRS
// roots are never removable.
function rootsPayload() {
  return { roots: allRoots(), removableRoots: [...EXTRA_ROOTS] };
}

// True if `resolved` is inside at least one allowed root (static check; no
// symlink resolution).
function withinAnyRoot(resolved) {
  for (const r of allRoots()) {
    const rel = path.relative(r, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

// True if the real path `real` is inside at least one existing allowed root.
function withinAnyRootReal(real) {
  for (const r of allRoots()) {
    let baseReal;
    try {
      baseReal = fs.realpathSync(r);
    } catch {
      continue; // root does not exist yet
    }
    const realRel = path.relative(baseReal, real);
    if (realRel === '' || (!realRel.startsWith('..') && !path.isAbsolute(realRel))) return true;
  }
  return false;
}
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MTIME_EPSILON_MS = 1;
const HOST = process.env.HOST || '127.0.0.1'; // localhost only, no LAN exposure

// Only the Vite dev (5173) and preview (4173) origins may call this API from a browser
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ],
}));
app.use(express.json({ limit: '2mb' }));

function expandHome(p) {
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// Resolve a user-supplied path and ensure it stays within one of the allowed
// roots, including after following symlinks (fs.realpathSync). Relative paths
// resolve against BASE_DIR. Returns:
//   { path: realPath }  - safe; real path to use
//   { error: 'denied' } - resolves outside every allowed root (directly or via symlink)
//   { error: 'missing' } - does not exist
function resolveSafe(rawPath) {
  let resolved;
  try {
    resolved = path.resolve(BASE_DIR, expandHome(String(rawPath)));
  } catch {
    return { error: 'denied' };
  }
  if (!withinAnyRoot(resolved)) {
    return { error: 'denied' };
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    return err && err.code === 'ENOENT' ? { error: 'missing' } : { error: 'denied' };
  }
  if (!withinAnyRootReal(real)) {
    return { error: 'denied' };
  }
  return { path: real };
}

// Send the 403/404 response for a failed resolveSafe; returns true if safe.
function respondResolve(res, result) {
  if (result.error === 'denied') {
    res.status(403).json({ error: 'Access denied: path outside allowed directory' });
    return false;
  }
  if (result.error === 'missing') {
    res.status(404).json({ error: 'Path not found' });
    return false;
  }
  return true;
}

// Heuristic: reject files that are not displayable text. Catches binary data
// even when it contains no null bytes (e.g. compressed streams).
function looksBinary(content) {
  // Null byte, or U+FFFD means the file is not valid UTF-8 text
  if (content.includes('\u0000') || content.includes('\uFFFD')) return true;
  const sample = content.slice(0, 8192);
  let controlChars = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) controlChars++;
  }
  return controlChars / sample.length > 0.05;
}

// API endpoint: list directory entries
app.get('/api/files', (req, res) => {
  const rawPath = req.query.path;

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const resolvedPath = resolved.path;

  try {
    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    const items = entries.map(entry => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
      isDirectory: entry.isDirectory()
    }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read directory', details: err.message });
  }
});

// API endpoint: read a file's text content
app.get('/api/file-content', (req, res) => {
  const rawPath = req.query.path;

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const resolvedPath = resolved.path;

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }
    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({
        error: `File too large (${Math.round(stat.size / 1024)} KB, limit ${MAX_FILE_SIZE / 1024} KB)`
      });
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    if (looksBinary(content)) {
      return res.status(415).json({ error: 'Binary file: preview not supported' });
    }

    res.json({ path: resolvedPath, content, mtimeMs: stat.mtimeMs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read file', details: err.message });
  }
});

// Write text content to a file atomically: the bytes go to a temp file in the
// same directory first, then rename over the target (atomic on POSIX). A crash
// mid-write can therefore never leave a truncated target behind. The target's
// permission bits are preserved across the rename; the temp file is removed if
// anything fails. Temp names match WATCH_IGNORED so the watcher stays quiet.
let tmpSeq = 0;
function writeFileAtomic(target, content) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${++tmpSeq}`);
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    let mode;
    try {
      mode = fs.statSync(target).mode & 0o777;
    } catch {
      mode = null; // target vanished between check and write; default umask is fine
    }
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp file never created or already gone; nothing to clean up
    }
    throw err;
  }
}

// API endpoint: save a file's text content (with conflict detection via mtime).
// The write is atomic (temp file + rename), so readers never observe partial
// content even if the process dies mid-write.
app.put('/api/file-content', (req, res) => {
  const body = req.body ?? {};
  const rawPath = body.path;
  const content = body.content;
  const expectedMtimeMs = body.mtimeMs;

  if (typeof rawPath !== 'string' || typeof content !== 'string') {
    return res.status(400).json({ error: 'Body must include path and content strings' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const resolvedPath = resolved.path;

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }

    // Conflict detection: reject if the file changed on disk since it was opened
    if (typeof expectedMtimeMs === 'number') {
      if (Math.abs(stat.mtimeMs - expectedMtimeMs) > MTIME_EPSILON_MS) {
        return res.status(409).json({
          error: 'File was modified on disk since it was opened. Reload and retry.'
        });
      }
    }

    writeFileAtomic(resolvedPath, content);
    markSelfWrite(resolvedPath);
    const newStat = fs.statSync(resolvedPath);
    res.json({ path: resolvedPath, mtimeMs: newStat.mtimeMs, size: newStat.size });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file', details: err.message });
  }
});

const MAX_SCAN_FILES = 5000;
const MAX_RESULTS = 200;
const MAX_MATCHES_PER_FILE = 3;
const MAX_SEARCH_DEPTH = 12;

// API endpoint: search file names and contents under a directory. Optional
// query params: regex=1 (treat q as a regular expression), case=1 (case-sensitive
// literal match), ext=a,b,c (only files with one of these extensions). File
// results carry mtimeMs so the client can do conflict-safe replaces later.
app.get('/api/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    return res.status(400).json({ error: 'Query parameter required' });
  }

  const isRegex = req.query.regex === '1' || req.query.regex === 'true';
  const isCase = req.query.case === '1' || req.query.case === 'true';
  const extParam = typeof req.query.ext === 'string' ? req.query.ext : '';

  let re = null;
  if (isRegex) {
    try {
      re = new RegExp(q, isCase ? '' : 'i'); // no /g so repeated .test() stays stateless
    } catch {
      return res.status(400).json({ error: 'Invalid regular expression' });
    }
  }
  const needle = isCase ? q : q.toLowerCase();

  let extSet = null;
  if (extParam) {
    extSet = new Set(
      extParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(e => e.startsWith('.') ? e.slice(1) : e)
    );
  }

  const matches = text => re ? re.test(text) : (isCase ? text.includes(needle) : text.toLowerCase().includes(needle));
  const matchesExt = name => {
    if (!extSet) return true;
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return false; // no extension / hidden file
    return extSet.has(name.slice(dot + 1).toLowerCase());
  };

  const rawPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : BASE_DIR;
  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const root = resolved.path;

  try {
    if (!fs.statSync(root).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Search failed', details: err.message });
  }

  const results = [];
  let scanned = 0;

  function walk(dir, depth) {
    if (results.length >= MAX_RESULTS || scanned > MAX_SCAN_FILES || depth > MAX_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS || scanned > MAX_SCAN_FILES) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        // An extension filter implies file-type filtering: skip directory results.
        if (!extSet && matches(entry.name)) {
          results.push({ name: entry.name, path: full, isDirectory: true });
        }
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue; // unreadable file
        }
        const nameOk = matchesExt(entry.name);
        const matchedName = nameOk && matches(entry.name);
        let matchList;

        if (!matchedName && nameOk && stat.size <= MAX_FILE_SIZE) {
          try {
            const buf = fs.readFileSync(full);
            if (buf.includes(0)) continue; // binary file
            const lines = buf.toString('utf-8').split('\n');
            matchList = [];
            for (let i = 0; i < lines.length && matchList.length < MAX_MATCHES_PER_FILE; i++) {
              if (matches(lines[i])) {
                matchList.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
              }
            }
          } catch {
            // unreadable file; skip content search
          }
        }

        if (matchedName || (matchList && matchList.length > 0)) {
          results.push({
            name: entry.name,
            path: full,
            isDirectory: false,
            mtimeMs: stat.mtimeMs,
            ...(matchList ? { matches: matchList } : {})
          });
        }
      }
    }
  }

  walk(root, 0);
  res.json(results);
});

// API endpoint: replace occurrences of a pattern within a single file. Reuses the
// same conflict-safe write path as PUT /api/file-content (optional mtimeMs check).
// Body: { path, find, replacement, regex?, caseSensitive?, mtimeMs? }. Returns the
// number of replacements made and the new mtimeMs.
app.post('/api/replace', (req, res) => {
  const body = req.body ?? {};
  const rawPath = body.path;
  const find = typeof body.find === 'string' ? body.find : '';
  const replacement = typeof body.replacement === 'string' ? body.replacement : '';
  const isRegex = body.regex === true || body.regex === '1';
  const isCase = body.caseSensitive === true || body.caseSensitive === '1';
  const expectedMtimeMs = body.mtimeMs;

  if (typeof rawPath !== 'string' || !rawPath) {
    return res.status(400).json({ error: 'Body must include a path string' });
  }
  if (!find) {
    return res.status(400).json({ error: 'Find pattern is required' });
  }

  let re = null;
  if (isRegex) {
    try {
      re = new RegExp(find, isCase ? 'g' : 'gi');
    } catch {
      return res.status(400).json({ error: 'Invalid regular expression' });
    }
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const filePath = resolved.path;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }
    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: `File too large (${Math.round(stat.size / 1024)} KB, limit ${MAX_FILE_SIZE / 1024} KB)` });
    }

    // Conflict detection: reject if the file changed on disk since it was read.
    if (typeof expectedMtimeMs === 'number') {
      if (Math.abs(stat.mtimeMs - expectedMtimeMs) > MTIME_EPSILON_MS) {
        return res.status(409).json({ error: 'File was modified on disk since it was opened. Reload and retry.' });
      }
    }

    const original = fs.readFileSync(filePath, 'utf-8');
    if (looksBinary(original)) {
      return res.status(415).json({ error: 'Binary file: replace not supported' });
    }

    let updated;
    let count;
    if (re) {
      const m = original.match(re);
      count = m ? m.length : 0;
      updated = original.replace(re, replacement);
    } else if (isCase) {
      const parts = original.split(find);
      count = parts.length - 1;
      updated = parts.join(replacement);
    } else {
      const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cre = new RegExp(esc, 'gi');
      const m = original.match(cre);
      count = m ? m.length : 0;
      updated = original.replace(cre, replacement);
    }

    if (count === 0 || updated === original) {
      return res.json({ replaced: 0, path: filePath, mtimeMs: stat.mtimeMs });
    }

    writeFileAtomic(filePath, updated);
    markSelfWrite(filePath);
    const newStat = fs.statSync(filePath);
    res.json({ replaced: count, path: filePath, mtimeMs: newStat.mtimeMs });
  } catch (err) {
    res.status(500).json({ error: 'Replace failed', details: err.message });
  }
});

// Resolve a path that may not exist yet (creation target, rename destination).
// The parent must exist and stay within an allowed root; the final segment is
// joined onto the parent's real path so symlinks in the parent chain are resolved.
function resolveSafeNew(rawPath) {
  let resolved;
  try {
    resolved = path.resolve(BASE_DIR, expandHome(String(rawPath)));
  } catch {
    return { error: 'denied' };
  }
  if (!withinAnyRoot(resolved)) {
    return { error: 'denied' };
  }
  const base = path.basename(resolved);
  if (!base || base === '.' || base === '..') return { error: 'denied' };

  const parentCheck = resolveSafe(path.dirname(resolved));
  if (parentCheck.error) return parentCheck;

  // If the target already exists, it must also pass full containment checks.
  try {
    fs.statSync(path.join(parentCheck.path, base));
    const existing = resolveSafe(rawPath);
    if (existing.error) return existing;
  } catch {
    // does not exist yet — will be created inside the contained parent
  }
  return { path: path.join(parentCheck.path, base) };
}

// API endpoint: create a new file or directory
app.post('/api/files', (req, res) => {
  const body = req.body ?? {};
  const rawPath = body.path;
  const type = body.type;
  const content = typeof body.content === 'string' ? body.content : '';

  if (typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Body must include a path string' });
  }
  if (type !== 'file' && type !== 'directory') {
    return res.status(400).json({ error: "Type must be 'file' or 'directory'" });
  }

  const resolved = resolveSafeNew(rawPath);
  if (!respondResolve(res, resolved)) return;
  const target = resolved.path;

  // lstat so an existing symlink is also treated as a conflict (writeFileSync
  // would otherwise follow it and overwrite the link target).
  try {
    fs.lstatSync(target);
    return res.status(409).json({ error: 'Already exists' });
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      return res.status(500).json({ error: 'Failed to create', details: err.message });
    }
  }

  try {
    if (type === 'directory') {
      fs.mkdirSync(target);
    } else {
      if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `Content too large (limit ${MAX_FILE_SIZE / 1024} KB)` });
      }
      fs.writeFileSync(target, content, 'utf-8');
    }
    markSelfWrite(target); // keep the watcher quiet about our own create
    res.json({ name: path.basename(target), path: target, isDirectory: type === 'directory' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return res.status(409).json({ error: 'Already exists' });
    }
    res.status(500).json({ error: 'Failed to create', details: err.message });
  }
});

// API endpoint: rename or move a file/directory within the allowed root
// True when realPath is one of the allowed roots itself, or a directory that
// contains another active allowed root (compared by canonical path). Renaming
// or recursively deleting such a path would move or remove the folder the user
// opened while /api/roots keeps listing it, so both operations refuse it.
// Only ".." and paths starting with ".." + sep point outside the source
// directory; a child literally named "..project" stays protected.
function isOrContainsAllowedRoot(realPath) {
  for (const r of allRoots()) {
    let real;
    try {
      real = fs.realpathSync(r);
    } catch {
      continue; // root does not exist yet
    }
    if (real === realPath) return true;
    const rel = path.relative(realPath, real);
    if (rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

app.post('/api/rename', (req, res) => {
  const body = req.body ?? {};
  const from = body.from;
  const to = body.to;

  if (typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'Body must include from and to strings' });
  }

  const srcCheck = resolveSafe(from);
  if (!respondResolve(res, srcCheck)) return;
  const dstCheck = resolveSafeNew(to);
  if (!respondResolve(res, dstCheck)) return;
  const source = srcCheck.path;
  const target = dstCheck.path;

  if (isOrContainsAllowedRoot(source)) {
    return res.status(403).json({ error: 'Cannot rename a directory that is or contains an allowed root' });
  }

  try {
    fs.statSync(target); // destination must not exist
    return res.status(409).json({ error: 'Destination already exists' });
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) {
      return res.status(500).json({ error: 'Rename failed', details: err.message });
    }
  }

  try {
    fs.renameSync(source, target);
    markSelfWrite(source); // suppress the watcher's unlink/add pair for our own move
    markSelfWrite(target);
    const stat = fs.statSync(target);
    res.json({ name: path.basename(target), path: target, isDirectory: stat.isDirectory() });
  } catch (err) {
    // e.g. renaming a directory into its own subtree
    return res.status(400).json({ error: 'Rename failed', details: err.message });
  }
});

// API endpoint: delete a file or directory (recursive for directories)
app.delete('/api/files', (req, res) => {
  const rawPath = req.query.path;

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const target = resolved.path;

  if (isOrContainsAllowedRoot(target)) {
    return res.status(403).json({ error: 'Cannot delete a directory that is or contains an allowed root' });
  }

  try {
    fs.rmSync(target, { recursive: true });
    markSelfWrite(target); // prefix match also covers a deleted directory's children
    res.json({ deleted: target });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed', details: err.message });
  }
});

// --- Allowed roots ---------------------------------------------------------
// The server may serve several repositories at once. POST /api/roots lets the
// UI open another folder without a restart, widening what this API can reach;
// it is only exposed on 127.0.0.1 and to the Vite dev origins (CORS above).

app.get('/api/roots', (req, res) => {
  res.json(rootsPayload());
});

app.post('/api/roots', (req, res) => {
  const body = req.body ?? {};
  const rawPath = body.path;

  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return res.status(400).json({ error: 'Body must include a path string' });
  }

  let resolved;
  try {
    resolved = path.resolve(expandHome(rawPath));
  } catch {
    return res.status(400).json({ error: 'Invalid path' });
  }

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Path not found' });
    }
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    if (!fs.statSync(real).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat path', details: err.message });
  }

  if (!EXTRA_ROOTS.includes(real)) {
    if (EXTRA_ROOTS.length >= MAX_EXTRA_ROOTS) {
      return res.status(409).json({ error: `Too many allowed roots (max ${MAX_EXTRA_ROOTS})` });
    }
    EXTRA_ROOTS.push(real);
  }

  // Keep the file watcher in sync with newly allowed roots (chokidar dedupes).
  if (fileWatcher !== null) {
    try {
      fileWatcher.add(real);
    } catch {
      // watcher already closed; nothing to do
    }
  }

  res.json(rootsPayload());
});

// Remove a runtime-added root. Only roots added via POST /api/roots are
// removable; the default (BASE_DIR) and static BASE_DIRS roots cannot be.
app.delete('/api/roots', (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rawPath.trim()) {
    return res.status(400).json({ error: 'Path parameter required' });
  }

  let real;
  try {
    real = fs.realpathSync(path.resolve(expandHome(rawPath)));
  } catch (err) {
    if (err && err.code === 'ENOENT') return res.status(404).json({ error: 'Root not found' });
    return res.status(403).json({ error: 'Access denied' });
  }

  const idx = EXTRA_ROOTS.indexOf(real);
  if (idx === -1) {
    return res.status(400).json({ error: 'Only runtime-added roots can be removed' });
  }
  EXTRA_ROOTS.splice(idx, 1);

  // Stop watching the removed root so its changes no longer broadcast.
  if (fileWatcher !== null) {
    try {
      fileWatcher.unwatch(real);
    } catch {
      // watcher already closed; nothing to do
    }
  }

  res.json(rootsPayload());
});

// --- Terraform operations -------------------------------------------------
// Run a whitelisted terraform subcommand inside an allowed directory. The
// command and its arguments are fixed server-side (never client-supplied) and
// spawned without a shell, so the only inputs are the binary name and cwd.

// Fixed plan file name inside the target directory: plan-file writes it, and
// apply only ever applies that saved file (never -auto-approve).
const TF_PLAN_FILE = 'tf.plan';

// All commands run in text mode (the same output a Linux shell would show);
// the UI streams it verbatim and parses only what it needs from that text.
const TF_COMMANDS = {
  fmt: ['fmt', '-recursive'],
  validate: ['validate', '-no-color'],
  plan: ['plan', '-input=false', '-no-color'],
  // Drift check: plan with -detailed-exitcode (0 = in sync, 2 = changes found).
  // Read-only.
  drift: ['plan', '-input=false', '-no-color', '-detailed-exitcode'],
  // Dependency graph of the configuration (DOT on stdout). Read-only.
  graph: ['graph', '-no-color'],
  init: ['init', '-input=false', '-no-color'],
  output: ['output', '-no-color'],
  'state-list': ['state', 'list', '-no-color'],
  // Guarded apply flow, see TF_PLAN_FILE above.
  'plan-file': ['plan', '-input=false', '-no-color'],
  apply: ['apply', '-input=false', '-no-color', TF_PLAN_FILE],
  version: ['version', '-no-color'],
  'init-upgrade': ['init', '-input=false', '-no-color', '-upgrade'],
  'workspace-list': ['workspace', 'list', '-no-color'],
  // Inspect the saved execution plan (terraform show tfplan).
  'show-plan': ['show', '-no-color', TF_PLAN_FILE],
  // Guarded destroy flow: save a destroy plan, then `apply` applies that file.
  'plan-file-destroy': ['plan', '-input=false', '-no-color', '-destroy'],
};

// Commands with client-supplied arguments (each argument validated separately).
const TF_ARG_COMMANDS = new Set([
  'state-show', // address
  'workspace-new', // name
  'workspace-select', // name
  'import', // address + importId
  'state-mv', // srcAddress + destAddress
  'state-rm', // address
  'console-eval', // expression (via stdin, never argv)
]);

// Commands that accept -var-file=<name> pointing at a top-level .tfvars file.
const TF_VARFILE_COMMANDS = new Set(['init', 'init-upgrade', 'plan', 'drift', 'plan-file', 'plan-file-destroy']);

// Terraform workspace name: letters, digits, '_' and '-' (terraform's own rule).
function isValidWorkspaceName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(name);
}

// A terraform import ID: arbitrary text except a leading '-' (which would be
// parsed as an option) and control characters. Spawned without a shell, so this
// is the whole injection surface.
function isValidImportId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) return false;
  if (id.startsWith('-')) return false;
  for (const ch of id) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127) return false;
  }
  return true;
}

// A top-level .tfvars file name. Basename only — the regex makes path
// separators impossible, so no traversal is possible.
const TF_VARFILE_RE = /^[A-Za-z0-9._-]+\.tfvars$/;

function isValidVarFileName(name) {
  return typeof name === 'string' && TF_VARFILE_RE.test(name);
}

// -backend-config key=value pairs for init (remote backend setup, e.g. S3/GCS).
const TF_BACKEND_CONFIG_MAX = 10;
const TF_BC_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Returns null when invalid, otherwise the argv strings to append to init.
function parseBackendConfig(raw) {
  if (raw === undefined || raw === null) return [];
  let pairs = raw;
  if (typeof pairs === 'string') {
    try {
      pairs = JSON.parse(pairs);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(pairs) || pairs.length > TF_BACKEND_CONFIG_MAX) return null;
  const out = [];
  for (const pair of pairs) {
    if (typeof pair !== 'object' || pair === null) return null;
    const key = typeof pair.key === 'string' ? pair.key : '';
    const value = typeof pair.value === 'string' ? pair.value : '';
    if (!TF_BC_KEY_RE.test(key)) return null;
    if (value.length > 512) return null;
    for (const ch of value) {
      const c = ch.charCodeAt(0);
      if (c < 32 || c === 127) return null;
    }
    out.push(`-backend-config=${key}=${value}`);
  }
  return out;
}

// Console expression: evaluated by terraform itself and passed via stdin, never
// argv. Newlines (multiple expressions) and tabs are allowed, other control
// characters are not.
const TF_CONSOLE_MAX_CHARS = 4096;
function isValidConsoleExpression(expr) {
  if (typeof expr !== 'string' || expr.trim() === '' || expr.length > TF_CONSOLE_MAX_CHARS) return false;
  for (const ch of expr) {
    const c = ch.charCodeAt(0);
    if (c < 32 && c !== 10 && c !== 9) return false;
  }
  return true;
}

const TF_TIMEOUT_MS = Number(process.env.TF_TIMEOUT_MS) || 120_000;
const TF_MAX_FILES = 100; // cap on .tf files scanned for fmt before/after capture
const tfRunning = new Set(); // real dir paths with an in-flight command
const TF_PREVIEW_TTL_MS = 5 * 60_000;
const TF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const TF_PREVIEW_MAX_COUNT = 4;
const tfPreviews = new Map();

// Keep a short-lived plan in server memory so JSON represents the same plan as
// the text. The temporary file is private and is removed immediately after use.
function rememberTfPreview(dir, file) {
  try {
    if (fs.statSync(file).size > TF_PREVIEW_MAX_BYTES) return null;
    const bytes = fs.readFileSync(file);
    while (tfPreviews.size >= TF_PREVIEW_MAX_COUNT) {
      const first = tfPreviews.keys().next().value;
      clearTimeout(tfPreviews.get(first).timer);
      tfPreviews.delete(first);
    }
    const id = crypto.randomBytes(16).toString('hex');
    const timer = setTimeout(() => tfPreviews.delete(id), TF_PREVIEW_TTL_MS);
    timer.unref();
    tfPreviews.set(id, { dir, bytes, expiresAt: Date.now() + TF_PREVIEW_TTL_MS, timer });
    return id;
  } catch {
    return null;
  }
}
const TF_MAX_STATE_ADDRESSES = 1000;

// Terraform resource address, e.g. aws_instance.web or module.vpc.aws_subnet.private[0].
// Only word chars, dashes, dots and [index] are allowed — no shell metacharacters possible.
function isValidTfAddress(addr) {
  if (typeof addr !== 'string' || !addr || addr.length > 255) return false;
  return /^[A-Za-z0-9_-]+(\[[0-9]+\])?(\.[A-Za-z0-9_-]+(\[[0-9]+\])?)*$/.test(addr);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// --- Plan summary from text-mode output --------------------------------------

// Parse terraform's text-mode plan output into per-action counts. The canonical
// per-resource header lines ("# addr will be created", ...) are counted first;
// when none are present (e.g. a clean "No changes." run) the final
// "Plan: X to add, Y to change, Z to destroy." line is used instead — there,
// replaces count as changes. Returns null when neither is found (the plan
// errored before printing any summary).
function parsePlanText(stdout) {
  const summary = { add: 0, update: 0, replace: 0, destroy: 0 };
  let sawHeader = false;
  for (const line of stdout.split('\n')) {
    let action = null;
    if (/^\s*#\s+.+ will be created\s*$/.test(line)) action = 'add';
    else if (/^\s*#\s+.+ will be updated in-place\s*$/.test(line)) action = 'update';
    else if (/^\s*#\s+.+ must be replaced\s*$/.test(line)) action = 'replace';
    else if (/^\s*#\s+.+ will be destroyed\s*$/.test(line)) action = 'destroy';
    if (action !== null) {
      summary[action] += 1;
      sawHeader = true;
    }
  }
  const m = stdout.match(/^Plan: (\d+) to add, (\d+) to change, (\d+) to destroy\./m);
  if (sawHeader && (!m || (summary.add + summary.replace === Number(m[1]) &&
      summary.update === Number(m[2]) && summary.destroy + summary.replace === Number(m[3])))) return summary;
  if (m) return { add: Number(m[1]), update: Number(m[2]), replace: 0, destroy: Number(m[3]) };
  if (sawHeader) return summary;
  if (/^No changes\./m.test(stdout)) return { add: 0, update: 0, replace: 0, destroy: 0 };
  return null;
}

// --- Dependency graph (`terraform graph` DOT output) ------------------------

const TF_MAX_GRAPH_NODES = 500;
const TF_MAX_GRAPH_EDGES = 2000;

// Unescape a quoted DOT string ("a\"b" -> a"b).
function unquoteDot(s) {
  return s.replace(/\\(.)/g, '$1');
}

// Parse `terraform graph` DOT output into nodes (with labels when present) and
// directed edges. terraform emits one statement per line: node declarations
// ("id" attr=...) or edges ("a" -> "b"). Node ids may contain escaped quotes
// (provider["registry..."]). Non-matching lines (digraph header, subgraph,
// attributes) are ignored.
function parseTfGraphDot(dot) {
  const nodeOrder = [];
  const labels = new Map();
  const edges = [];
  const seenNodes = new Set();
  const addNode = id => {
    if (seenNodes.has(id)) return;
    seenNodes.add(id);
    if (nodeOrder.length < TF_MAX_GRAPH_NODES) nodeOrder.push(id);
  };
  for (const rawLine of dot.split('\n')) {
    const line = rawLine.trim();
    let m = line.match(/^"((?:[^"\\]|\\.)*)"\s*->\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      const from = unquoteDot(m[1]);
      const to = unquoteDot(m[2]);
      addNode(from);
      addNode(to);
      if (edges.length < TF_MAX_GRAPH_EDGES) edges.push([from, to]);
      continue;
    }
    m = line.match(/^"((?:[^"\\]|\\.)*)"(?=\s|$)/);
    if (!m) continue;
    const id = unquoteDot(m[1]);
    addNode(id);
    const lm = line.match(/label="((?:[^"\\]|\\.)*)"/);
    if (lm && !labels.has(id)) labels.set(id, unquoteDot(lm[1]));
  }
  return {
    nodes: nodeOrder.map(id => ({ id, ...(labels.has(id) ? { label: labels.get(id) } : {}) })),
    edges,
  };
}

// Merge stdout/stderr into one display string (stderr appended when present).
function tfOutputText(result) {
  let output = result.stdout;
  if (result.stderr.trim()) output += (output ? '\n' : '') + result.stderr;
  return output;
}

// --- tfenv integration -----------------------------------------------------
// When tfenv is available, terraform commands run through its `terraform` shim
// (bin dir prepended to PATH). The shim resolves the version per directory:
// TFENV_TERRAFORM_VERSION env var, then a .terraform-version file walked up
// from cwd, then the global default (~/.tfenv/version). Version selection for
// a folder is done by writing <dir>/.terraform-version (the format tfenv
// expects; `tfenv pin` writes the same file).
// TFENV_BIN overrides the bin location; TFENV_DISABLE=1 turns tfenv off.

function tfenvBinDir() {
  if (process.env.TFENV_DISABLE === '1') return null;
  const candidate = process.env.TFENV_BIN
    ? expandHome(process.env.TFENV_BIN)
    : path.join(os.homedir(), '.tfenv', 'bin');
  try {
    fs.statSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const TF_VERSION_RE = /^\d+\.\d+(\.\d+)?(-[A-Za-z0-9.]+)?$/; // e.g. 1.5.0, 1.9.8-beta1
const TF_LIST_TIMEOUT_MS = 15_000;
const TF_INSTALL_TIMEOUT_MS = Number(process.env.TF_INSTALL_TIMEOUT_MS) || 300_000;

// Extract terraform version strings from `tfenv list` output (lines look like
// "* 1.5.0 (amd64) (set by ...)" or plain "1.9.8").
function parseTfVersions(output) {
  const versions = new Set();
  for (const line of String(output).split('\n')) {
    const m = line.match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/);
    if (m) versions.add(m[1]);
  }
  return [...versions];
}

// Spawn a binary and resolve with its output. Resolves (never rejects) with:
//   { exitCode, timedOut, stdout, stderr } on normal close
//   { error: 'enoent' | message, ... } when the binary cannot be started
// When onChunk is given it receives each raw stdout/stderr chunk as it arrives.
// When stdin (a string) is given it is written to the child's stdin and closed.
function spawnCaptured(file, args, cwd, timeoutMs, env = process.env, onChunk, stdin, maxBytes = Infinity) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let tooLarge = false;
    let outputBytes = 0;
    let child;
    try {
      child = spawn(file, args, { cwd, env });
    } catch (err) {
      return finish({ error: err.message, timedOut: false, stdout, stderr });
    }
    if (stdin !== undefined) {
      // EPIPE when the process exits before reading everything; ignore it.
      child.stdin.on('error', () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const capture = (d, isStderr) => {
      outputBytes += d.length;
      if (outputBytes > maxBytes) {
        tooLarge = true;
        child.kill('SIGKILL');
        return;
      }
      const s = d.toString();
      if (isStderr) stderr += s; else stdout += s;
      if (onChunk) onChunk(s);
    };
    child.stdout.on('data', d => capture(d, false));
    child.stderr.on('data', d => capture(d, true));
    child.on('error', err => {
      clearTimeout(timer);
      finish({ error: err.code === 'ENOENT' ? 'enoent' : err.message, timedOut: false, stdout, stderr });
    });
    child.on('close', code => {
      clearTimeout(timer);
      finish({ ...(tooLarge ? { error: 'output-too-large' } : {}), exitCode: code, timedOut, stdout, stderr });
    });
  });
}

// Run terraform (via the tfenv shim when available) and resolve with its output.
// onChunk (optional) receives raw stdout/stderr chunks as it arrives; stdin
// (optional string) is piped to the process (used by console-eval); extraEnv
// (optional object) adds per-run environment variables (cloud credentials).
function runTerraform(cwd, args, onChunk, stdin, extraEnv, maxBytes) {
  const binDir = tfenvBinDir();
  const baseEnv = binDir
    ? { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` }
    : process.env;
  const env = extraEnv && Object.keys(extraEnv).length > 0 ? { ...baseEnv, ...extraEnv } : baseEnv;
  return spawnCaptured('terraform', args, cwd, TF_TIMEOUT_MS, env, onChunk, stdin, maxBytes);
}

// Run a tfenv subcommand (list / version-name / install) and resolve with output.
function runTfenv(cwd, args, timeoutMs = TF_LIST_TIMEOUT_MS) {
  const binDir = tfenvBinDir();
  if (!binDir) return Promise.resolve({ error: 'enoent', timedOut: false, stdout: '', stderr: '' });
  return spawnCaptured(path.join(binDir, 'tfenv'), args, cwd, timeoutMs);
}

// Collect .tf/.tfvars file contents under a directory (for fmt diffs).
function collectTfFiles(dir, depth, out) {
  if (out.size >= TF_MAX_FILES || depth > MAX_SEARCH_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.size >= TF_MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === '.terraform') continue;
      collectTfFiles(full, depth + 1, out);
    } else if (entry.isFile() && /\.(tf|tfvars)$/.test(entry.name)) {
      try {
        const stat = fs.statSync(full);
        if (stat.size <= MAX_FILE_SIZE) {
          out.set(full, fs.readFileSync(full, 'utf-8'));
        }
      } catch {
        // unreadable file; skip it
      }
    }
  }
}

// Build the argv for a command. Client-supplied arguments (opts) were already
// validated by the endpoint handler; everything else is fixed server-side.
function buildTfArgs(command, opts) {
  if (command === 'state-show') return ['state', 'show', '-no-color', opts.address];
  if (command === 'workspace-new') return ['workspace', 'new', '-no-color', opts.name];
  if (command === 'workspace-select') return ['workspace', 'select', '-no-color', opts.name];
  if (command === 'import') return ['import', '-input=false', '-no-color', opts.address, opts.importId];
  if (command === 'state-mv') return ['state', 'mv', '-no-color', opts.srcAddress, opts.destAddress];
  // -force: the UI already confirmed; without it state rm would prompt.
  if (command === 'state-rm') return ['state', 'rm', '-input=false', '-no-color', '-force', opts.address];
  if (command === 'console-eval') return ['console', '-no-color'];
  const args = [...TF_COMMANDS[command]];
  if (opts.varFile && TF_VARFILE_COMMANDS.has(command)) args.push(`-var-file=${opts.varFile}`);
  if (Array.isArray(opts.backendConfig) && opts.backendConfig.length > 0) {
    args.push(...opts.backendConfig);
  }
  return args;
}

// A saved plan carries the configuration it was made from, so applying it after
// a configuration edit silently ignores that edit. plan-file records a content
// fingerprint of what terraform reads (see tfConfigFiles) and apply compares it.
// Hashes, not mtimes: cp -p, touch -r or a git checkout can keep old timestamps.
const TF_PLAN_MAX_FILES = 1000; // more config files than this fails closed
const TF_CONFIG_RE = /\.(tf|tf\.json|tfvars|tfvars\.json)$/;
const TF_MODULE_CONFIG_RE = /\.(tf|tf\.json)$/;
const tfPlanFingerprints = new Map(); // dir -> Map(relative name -> sha256)

// Top-level config files of one directory (terraform does not recurse).
function listTfConfigDir(dir, re, out, directories, symlinkTargets) {
  directories.push({ dir, re });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!re.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isFile()) {
      out.push(file);
    } else if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!withinAnyRootReal(target) || !fs.statSync(target).isFile()) {
        throw new Error('Terraform configuration symlink cannot be checked safely');
      }
      symlinkTargets.push(target);
      out.push(file);
    }
  }
}

// The files a plan in dir depends on: the root module's top-level .tf/.tf.json/
// .tfvars/.tfvars.json files, the top-level .tf/.tf.json files of local modules
// recorded by terraform init, and the saved plan itself. Nested directories that
// are not module sources (e.g. another root) are ignored, as terraform does.
function tfConfigFiles(dir) {
  const files = [];
  const directories = [];
  const symlinkTargets = [];
  listTfConfigDir(dir, TF_CONFIG_RE, files, directories, symlinkTargets);
  const dataDir = process.env.TF_DATA_DIR ? path.resolve(dir, process.env.TF_DATA_DIR) : path.join(dir, '.terraform');
  const manifestPath = path.join(dataDir, 'modules', 'modules.json');
  let modules = [];
  let manifestStat;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch (err) {
    // Terraform does not create a module manifest for projects without modules.
    if (err.code !== 'ENOENT') throw err;
  }
  if (manifestStat) {
    if (!manifestStat.isFile()) throw new Error('Invalid Terraform module manifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!Array.isArray(manifest?.Modules)) throw new Error('Invalid Terraform module manifest');
    modules = manifest.Modules;
    files.push(manifestPath);
  }
  const seen = new Set([dir]);
  for (const mod of modules) {
    if (typeof mod?.Key !== 'string' || typeof mod.Dir !== 'string' || !mod.Dir) {
      throw new Error('Invalid Terraform module manifest');
    }
    if (mod.Key === '') continue;
    if (typeof mod.Source !== 'string' || !mod.Source) throw new Error('Invalid Terraform module manifest');
    if (!mod.Source.startsWith('./') && !mod.Source.startsWith('../')) continue;
    const modDir = path.resolve(dir, mod.Dir);
    if (seen.has(modDir)) continue;
    seen.add(modDir);
    listTfConfigDir(modDir, TF_MODULE_CONFIG_RE, files, directories, symlinkTargets);
  }
  return { files, directories, symlinkTargets, manifestPath };
}

function hashTfFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Terraform input is not a regular file');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// Map(relative name -> fingerprint). Metadata is used only while a plan runs,
// so a later timestamp-only change does not block an otherwise valid plan.
function tfPlanFingerprint(dir, { includePlan = true, metadata = false, planFile = path.join(dir, TF_PLAN_FILE) } = {}) {
  const { files } = tfConfigFiles(dir);
  if (includePlan) files.push(planFile);
  if (files.length > TF_PLAN_MAX_FILES) throw new Error('too many configuration files');
  const out = new Map();
  for (const file of files) {
    let fingerprint = hashTfFile(file);
    if (metadata) {
      const link = fs.lstatSync(file, { bigint: true });
      const target = fs.statSync(file, { bigint: true });
      fingerprint += `:${link.dev}:${link.ino}:${link.ctimeNs}:${target.dev}:${target.ino}:${target.ctimeNs}`;
    }
    out.set(includePlan && file === planFile ? TF_PLAN_FILE : path.relative(dir, file), fingerprint);
  }
  return out;
}

function sameTfFingerprint(a, b) {
  return a.size === b.size && [...a].every(([name, value]) => b.get(name) === value);
}

// Observe configuration changes for the entire plan, including edits that are
// later reverted. A missing filename or watcher error is treated as a change.
function watchTfPlanConfig(dir) {
  const { directories, symlinkTargets, manifestPath } = tfConfigFiles(dir);
  const watchers = [];
  let changed = false;
  const watch = (parent, matches) => {
    const watcher = fs.watch(parent, { persistent: false }, (_event, name) => {
      if (!name || matches(String(name))) changed = true;
    });
    watcher.on('error', () => { changed = true; });
    watchers.push(watcher);
  };
  const watchFile = file => {
    let parent = path.dirname(file);
    let name = path.basename(file);
    while (!fs.existsSync(parent)) {
      name = path.basename(parent);
      const next = path.dirname(parent);
      if (next === parent) throw new Error('Cannot watch Terraform configuration');
      parent = next;
    }
    watch(parent, entry => entry === name);
  };
  try {
    for (const item of directories) watch(item.dir, name => item.re.test(name));
    for (const target of symlinkTargets) watchFile(target);
    watchFile(manifestPath);
  } catch (err) {
    for (const watcher of watchers) watcher.close();
    throw err;
  }
  return { hasChanged: () => changed, close: () => watchers.forEach(watcher => watcher.close()) };
}

// Why the saved plan in dir must not be applied, or null when it still matches
// the configuration (also when there is no plan: terraform reports that).
function stalePlanReason(dir) {
  if (!fs.existsSync(path.join(dir, TF_PLAN_FILE))) return null;
  const recorded = tfPlanFingerprints.get(dir);
  if (!recorded) return `${TF_PLAN_FILE} was not created by this session.`;
  let current;
  try {
    current = tfPlanFingerprint(dir);
  } catch {
    return 'The configuration could not be fully checked against the saved plan.';
  }
  for (const [name, hash] of recorded) {
    if (current.get(name) !== hash) return `${name} ${current.has(name) ? 'changed' : 'was removed'} after ${TF_PLAN_FILE} was created.`;
  }
  for (const name of current.keys()) {
    if (!recorded.has(name)) return `${name} was added after ${TF_PLAN_FILE} was created.`;
  }
  return null;
}

// Build the JSON payload for a terraform command. Returns { statusCode, body }.
// onChunk (optional) receives raw stdout/stderr chunks while the command runs.
async function runTerraformCommand(command, dir, opts = {}, onChunk) {
  if (command === 'apply') {
    const stale = stalePlanReason(dir);
    if (stale) return { statusCode: 409, body: { error: `${stale} Run the plan again before applying.` } };
  }
  const savesPlan = command === 'plan-file' || command === 'plan-file-destroy';
  let planBefore;
  let planWatch;
  let savedPlanDir;
  if (savesPlan) tfPlanFingerprints.delete(dir);

  // fmt needs the pre-format content to build diffs; capture it first.
  const before = new Map();
  if (command === 'fmt') collectTfFiles(dir, 0, before);

  const args = buildTfArgs(command, opts);
  const stdin = command === 'console-eval' ? `${opts.expression}\n` : undefined;
  let previewDir = null;
  if (command === 'plan') {
    try {
      previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terracode-plan-'));
      args.push(`-out=${path.join(previewDir, 'plan')}`);
    } catch {
      return { statusCode: 500, body: { error: 'Could not prepare a private plan preview' } };
    }
  }

  // Inject cloud credentials as environment variables for this run only. Only
  // providers with an active login session are included (see the credential
  // store section below); using them refreshes the unlock TTL.
  const credEnv = buildCloudEnv();
  if (Object.keys(credEnv).length > 0) {
    setCredUnlock(credUnlockedPayload); // refresh on use
  }

  let result;
  let previewId = null;
  try {
    if (savesPlan) {
      try {
        planBefore = tfPlanFingerprint(dir, { includePlan: false, metadata: true });
        planWatch = watchTfPlanConfig(dir);
        const watched = tfPlanFingerprint(dir, { includePlan: false, metadata: true });
        if (!sameTfFingerprint(planBefore, watched)) throw new Error('Configuration changed before planning');
        savedPlanDir = fs.mkdtempSync(path.join(dir, '.terracode-plan-'));
        args.push(`-out=${path.join(savedPlanDir, TF_PLAN_FILE)}`);
      } catch {
        return { statusCode: 409, body: { error: 'The configuration cannot be checked safely. Check its files and modules before planning.' } };
      }
    }
    result = await runTerraform(dir, args, onChunk, stdin, Object.keys(credEnv).length > 0 ? credEnv : undefined);
    if (previewDir && !result.error && !result.timedOut && result.exitCode === 0) {
      previewId = rememberTfPreview(dir, path.join(previewDir, 'plan'));
    }
    if (savesPlan && !result.error && !result.timedOut && result.exitCode === 0) {
      try {
        // Let queued filesystem events run before checking the final snapshot.
        await new Promise(resolve => setImmediate(resolve));
        const afterPlan = tfPlanFingerprint(dir, { includePlan: false, metadata: true });
        const planFile = path.join(savedPlanDir, TF_PLAN_FILE);
        const recorded = tfPlanFingerprint(dir, { planFile });
        const verified = tfPlanFingerprint(dir, { includePlan: false, metadata: true });
        await new Promise(resolve => setImmediate(resolve));
        if (planWatch.hasChanged() || !sameTfFingerprint(planBefore, afterPlan) || !sameTfFingerprint(afterPlan, verified)) {
          return { statusCode: 409, body: { error: 'The configuration changed while Terraform was planning. Run the plan again before applying.' } };
        }
        const publishedPlan = path.join(dir, TF_PLAN_FILE);
        fs.renameSync(planFile, publishedPlan);
        if (hashTfFile(publishedPlan) !== recorded.get(TF_PLAN_FILE)) {
          return { statusCode: 409, body: { error: 'The saved plan changed during publication. Run the plan again before applying.' } };
        }
        tfPlanFingerprints.set(dir, recorded);
      } catch {
        return { statusCode: 409, body: { error: 'The configuration could not be checked against the saved plan. Check its files and modules before retrying.' } };
      }
    }
  } finally {
    planWatch?.close();
    if (savedPlanDir) fs.rmSync(savedPlanDir, { recursive: true, force: true });
    if (previewDir) fs.rmSync(previewDir, { recursive: true, force: true });
  }
  if (result.error === 'enoent') {
    return { statusCode: 503, body: { error: 'terraform executable not found in PATH' } };
  }
  if (result.error) {
    return { statusCode: 500, body: { error: 'Failed to run terraform', details: result.error } };
  }

  if (command === 'fmt') {
    // terraform fmt prints each file it changed (relative to cwd) on stdout.
    const changedFiles = [];
    for (const line of result.stdout.split('\n')) {
      const name = line.trim();
      if (!name || changedFiles.length >= TF_MAX_FILES) continue;
      const full = path.resolve(dir, name);
      const rel = path.relative(dir, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // stay contained
      const prev = before.get(full);
      if (prev === undefined) continue;
      try {
        changedFiles.push({ path: full, before: prev, after: fs.readFileSync(full, 'utf-8') });
      } catch {
        // file vanished between fmt and the re-read; skip it
      }
    }
    const body = { command: 'fmt', exitCode: result.exitCode ?? 0, changedFiles };
    if (result.stderr.trim()) body.error = result.stderr.trim();
    return { statusCode: 200, body };
  }

  if (command === 'plan' || command === 'drift') {
    let parsed = null;
    try {
      parsed = parsePlanText(result.stdout);
    } catch {
      // unparseable output; the raw text below still shows what happened
    }
    const exitCode = result.timedOut ? null : result.exitCode;
    if (command === 'plan') {
      return {
        statusCode: 200,
        body: { command: 'plan', exitCode, timedOut: result.timedOut, summary: parsed, output: tfOutputText(result), previewId },
      };
    }
    // -detailed-exitcode: 0 = state matches reality, 2 = changes detected.
    // Any other code (or a timeout) means the check itself failed -> null.
    let drifted = null;
    if (exitCode === 0) drifted = false;
    else if (exitCode === 2) drifted = true;
    return {
      statusCode: 200,
      body: { command: 'drift', exitCode, timedOut: result.timedOut, drifted, summary: parsed, output: tfOutputText(result) },
    };
  }

  if (command === 'graph') {
    let graph = { nodes: [], edges: [] };
    try {
      graph = parseTfGraphDot(result.stdout);
    } catch {
      // unparseable DOT; the raw output below is still returned
    }
    return {
      statusCode: 200,
      body: {
        command: 'graph',
        exitCode: result.timedOut ? null : result.exitCode,
        timedOut: result.timedOut,
        nodes: graph.nodes,
        edges: graph.edges,
        output: tfOutputText(result),
      },
    };
  }

  if (command === 'state-list') {
    const addresses = [];
    for (const line of result.stdout.split('\n')) {
      const addr = line.trim();
      if (!addr) continue;
      if (addresses.length >= TF_MAX_STATE_ADDRESSES) break;
      addresses.push(addr);
    }
    return {
      statusCode: 200,
      body: {
        command: 'state-list',
        exitCode: result.timedOut ? null : result.exitCode,
        timedOut: result.timedOut,
        addresses,
        output: tfOutputText(result),
      },
    };
  }

  if (command === 'version') {
    // Text mode: "Terraform v1.9.8" / "on linux_amd64".
    const vm = result.stdout.match(/^Terraform (v[\d][\w.-]*)/m);
    const pm = result.stdout.match(/^on (\S+)/m);
    return {
      statusCode: 200,
      body: {
        command: 'version',
        exitCode: result.timedOut ? null : result.exitCode,
        timedOut: result.timedOut,
        version: vm ? vm[1].slice(1) : null,
        platform: pm ? pm[1] : null,
        output: tfOutputText(result),
      },
    };
  }

  if (command === 'workspace-list') {
    const workspaces = [];
    for (const line of result.stdout.split('\n')) {
      let name = line.trim();
      if (!name) continue;
      let current = false;
      if (name.startsWith('*')) {
        current = true;
        name = name.slice(1).trim();
      }
      if (workspaces.length < TF_MAX_STATE_ADDRESSES) workspaces.push({ name, current });
    }
    return {
      statusCode: 200,
      body: {
        command: 'workspace-list',
        exitCode: result.timedOut ? null : result.exitCode,
        timedOut: result.timedOut,
        workspaces,
        output: tfOutputText(result),
      },
    };
  }

  // validate, output, init, state-show, workspace-new/select, show-plan, import,
  // state-mv/rm, console-eval and the guarded apply/destroy flows return raw text.
  const body = {
    command,
    exitCode: result.timedOut ? null : result.exitCode,
    output: tfOutputText(result),
    timedOut: result.timedOut,
  };
  if (command === 'state-show' || command === 'state-rm') body.address = opts.address;
  if (command === 'workspace-new' || command === 'workspace-select') body.name = opts.name;
  if (command === 'import') body.address = opts.address;
  if (command === 'state-mv') {
    body.srcAddress = opts.srcAddress;
    body.destAddress = opts.destAddress;
  }
  return { statusCode: 200, body };
}

// --- State inspection (pure file reads — no terraform process) --------------

const TF_REDACTED_KEY_RE = /secret|token|password|credential|access_key|private/i;
const TF_MAX_BACKEND_CONFIG_KEYS = 12;
const TF_STATE_FILE_MAX_BYTES = 5 * 1024 * 1024; // skip parsing huge state files

// Backend config values can hold credentials (S3 secret keys, GCS tokens);
// redact anything that looks sensitive before it reaches the browser.
function redactBackendConfig(config) {
  if (!isPlainObject(config)) return {};
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(config)) {
    if (count >= TF_MAX_BACKEND_CONFIG_KEYS) break;
    count += 1;
    if (TF_REDACTED_KEY_RE.test(key)) {
      out[key] = '(redacted)';
      continue;
    }
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    out[key] = s.length > 80 ? `${s.slice(0, 80)}…` : (typeof value === 'string' ? value : s);
  }
  return out;
}

// Default-workspace local state file stats (null when the file is absent).
function readLocalState(dir) {
  const file = path.join(dir, 'terraform.tfstate');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > TF_STATE_FILE_MAX_BYTES) {
      return { exists: true, resources: null, serial: null };
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      exists: true,
      resources: Array.isArray(parsed.resources) ? parsed.resources.length : null,
      serial: typeof parsed.serial === 'number' ? parsed.serial : null,
    };
  } catch {
    return null;
  }
}

// Resolve + validate a terraform working directory. Responds with the error and
// returns null on failure; returns the real dir path on success.
function resolveTfDir(res, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) {
    res.status(400).json({ error: 'Must include a non-empty path string' });
    return null;
  }
  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return null;
  try {
    if (!fs.statSync(resolved.path).isDirectory()) {
      res.status(400).json({ error: 'Path must be a directory' });
      return null;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to stat directory', details: err.message });
    return null;
  }
  return resolved.path;
}

// API endpoint: inspect the state backend of a project without running terraform.
// Reads <dir>/.terraform/terraform.tfstate (written by init) for the configured
// backend, and <dir>/terraform.tfstate for local-state stats.
app.get('/api/tf/state-info', (req, res) => {
  const rawPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : BASE_DIR;
  const dir = resolveTfDir(res, rawPath);
  if (!dir) return;

  let initialized = false;
  try {
    initialized = fs.statSync(path.join(dir, '.terraform')).isDirectory();
  } catch {
    // not initialized
  }

  let backend = null;
  if (initialized) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '.terraform', 'terraform.tfstate'), 'utf-8'));
      if (isPlainObject(meta.backend) && typeof meta.backend.type === 'string') {
        backend = { type: meta.backend.type, config: redactBackendConfig(meta.backend.config) };
      }
    } catch {
      // init has not written the backend metadata yet
    }
  }

  res.json({ initialized, backend, localState: readLocalState(dir) });
});

// API endpoint: list top-level *.tfvars files of a project. terraform.tfvars and
// *.auto.tfvars are loaded automatically by terraform; others need -var-file.
app.get('/api/tf/var-files', (req, res) => {
  const rawPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : BASE_DIR;
  const dir = resolveTfDir(res, rawPath);
  if (!dir) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list directory', details: err.message });
    return;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !TF_VARFILE_RE.test(entry.name)) continue;
    if (files.length >= 50) break;
    files.push({
      name: entry.name,
      autoLoaded: entry.name === 'terraform.tfvars' || /\.auto\.tfvars$/.test(entry.name),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ files });
});

// --- Terraform module registry (read-only proxy) -----------------------------
// The public registry HTTP API has no full-text search; modules are looked up
// by namespace/name/provider. We proxy the documented endpoint so the browser
// never talks to a third party directly and every request gets a timeout, a
// size cap and strict input validation. REGISTRY_BASE overrides the host (tests).

const REGISTRY_TIMEOUT_MS = 10_000;
const REGISTRY_MAX_BODY_BYTES = 2 * 1024 * 1024;
const REGISTRY_MAX_VERSIONS = 50;
// Registry identifiers: letters, digits, '-' and '_' (provider may also use '.').
const REGISTRY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REGISTRY_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function registryBase() {
  return (process.env.REGISTRY_BASE || 'https://registry.terraform.io').replace(/\/+$/, '');
}

// Sort versions newest-first without a semver dependency: numeric compare of the
// dotted core, pre-release suffixes sort before their release.
function compareRegistryVersionsDesc(a, b) {
  const parse = v => {
    const m = String(v).match(/^(\d+(?:\.\d+)*)(.*)$/);
    if (!m) return { parts: [], rest: String(v), pre: false };
    return { parts: m[1].split('.').map(n => Number(n)), rest: m[2], pre: /-/.test(m[2]) };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const d = (pb.parts[i] ?? 0) - (pa.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  // Same numeric core: a pre-release ("1.0.0-beta") sorts before the release.
  if (pa.pre !== pb.pre) return pa.pre ? 1 : -1;
  return pb.rest.localeCompare(pa.rest);
}

app.get('/api/tf/registry/module', async (req, res) => {
  const ns = typeof req.query.ns === 'string' ? req.query.ns : '';
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const provider = typeof req.query.provider === 'string' ? req.query.provider : '';

  if (!REGISTRY_NAME_RE.test(ns) || !REGISTRY_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'ns and name must be 1-64 chars of letters, digits, "-" or "_"' });
  }
  if (!REGISTRY_PROVIDER_RE.test(provider)) {
    return res.status(400).json({ error: 'provider must be 1-64 chars of letters, digits, ".", "-" or "_"' });
  }

  const url = `${registryBase()}/v1/modules/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}`;
  let upstream;
  try {
    upstream = await fetch(url, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    return res.status(502).json({ error: `Registry request failed: ${err.message}` });
  }

  if (upstream.status === 404) {
    return res.status(404).json({ error: 'Module not found in the registry' });
  }
  if (!upstream.ok) {
    return res.status(502).json({ error: `Registry returned HTTP ${upstream.status}` });
  }

  const declared = Number(upstream.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > REGISTRY_MAX_BODY_BYTES) {
    return res.status(502).json({ error: 'Registry response too large' });
  }

  let data;
  try {
    const text = await upstream.text();
    if (Buffer.byteLength(text, 'utf8') > REGISTRY_MAX_BODY_BYTES) throw new Error('too large');
    data = JSON.parse(text);
  } catch {
    return res.status(502).json({ error: 'Registry returned an invalid response' });
  }

  // The registry returns version entries either as plain strings (current API)
  // or as {version, published_at} objects; normalize both to the same shape.
  const versions = [];
  if (Array.isArray(data.versions)) {
    for (const v of data.versions) {
      if (typeof v === 'string') {
        if (versions.length >= REGISTRY_MAX_VERSIONS) break;
        versions.push({ version: v });
        continue;
      }
      if (!isPlainObject(v) || typeof v.version !== 'string') continue;
      if (versions.length >= REGISTRY_MAX_VERSIONS) break;
      versions.push({ version: v.version, ...(typeof v.published_at === 'string' ? { publishedAt: v.published_at } : {}) });
    }
  }
  versions.sort((a, b) => compareRegistryVersionsDesc(a.version, b.version));

  res.json({
    namespace: ns,
    name,
    provider,
    source: `registry.terraform.io/${ns}/${name}/${provider}`,
    ...(typeof data.description === 'string' && data.description.trim() !== '' ? { description: data.description } : {}),
    ...(Number.isFinite(Number(data.downloads)) ? { downloads: Number(data.downloads) } : {}),
    versions,
  });
});

// --- Infracost cost estimation (optional binary) ------------------------------
// Runs `infracost breakdown --path <dir> --format json --no-color` when the
// binary is on PATH; fixed arguments, no shell, root-contained dir. Current
// Infracost builds require INFRACOST_API_KEY — it is inherited from this
// process's environment (set it before starting the app to enable estimates).

const INFRACOST_TIMEOUT_MS = 180_000; // first run downloads price data
const TF_MAX_COST_RESOURCES = 200;
const TF_MAX_COST_NOTES = 20;

// Search PATH first (so explicit installs and test fakes win), then the extra
// CLI dirs (~/.local/bin etc.) — same resolution as the cloud CLIs.
function findInPath(name) {
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...cliPathDirs(),
  ];
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return path.join(dir, name);
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

app.get('/api/tf/cost-availability', (req, res) => {
  res.json({ available: findInPath('infracost') !== null });
});

app.post('/api/tf/cost', async (req, res) => {
  const body = req.body ?? {};
  const dir = resolveTfDir(res, typeof body.path === 'string' ? body.path : '');
  if (!dir) return;

  const bin = findInPath('infracost');
  if (!bin) {
    return res.status(503).json({
      error: 'infracost executable not found in PATH',
      hint: 'Install Infracost to enable cost estimates, e.g. curl -sSfL https://raw.githubusercontent.com/infracost/infracost/main/install.sh | sh',
    });
  }

  const result = await spawnCaptured(bin, ['breakdown', '--path', dir, '--format', 'json', '--no-color'], dir, INFRACOST_TIMEOUT_MS);
  if (result.error === 'enoent') {
    return res.status(503).json({ error: 'infracost executable not found in PATH' });
  }
  if (result.error) {
    return res.status(500).json({ error: 'Failed to run infracost', details: result.error });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // fall through with an empty estimate + the raw output for diagnosis
  }

  const resources = [];
  if (isPlainObject(parsed) && Array.isArray(parsed.projects)) {
    for (const project of parsed.projects) {
      if (!isPlainObject(project) || !Array.isArray(project.resources)) continue;
      for (const r of project.resources) {
        if (resources.length >= TF_MAX_COST_RESOURCES) break;
        if (!isPlainObject(r) || typeof r.address !== 'string') continue;
        const cost = Number(r.monthly_cost);
        resources.push({ address: r.address, monthlyCost: Number.isFinite(cost) ? cost : null });
      }
    }
  }

  const notes = (arr) =>
    Array.isArray(arr)
      ? arr.slice(0, TF_MAX_COST_NOTES).map(n => (typeof n === 'string' ? n : isPlainObject(n) && typeof n.summary === 'string' ? n.summary : JSON.stringify(n)))
      : [];

  const total = Number(parsed?.total_monthly_cost);
  res.json({
    exitCode: result.timedOut ? null : result.exitCode,
    timedOut: result.timedOut,
    currencySymbol: isPlainObject(parsed) && typeof parsed.currency_symbol === 'string' ? parsed.currency_symbol : '$',
    totalMonthlyCost: Number.isFinite(total) ? total : null,
    resources,
    errors: notes(parsed?.errors),
    warnings: notes(parsed?.warnings),
    output: result.timedOut || parsed === null ? tfOutputText(result).slice(0, 4000) : '',
  });
});

// --- Cloud credentials (global encrypted store) + real cloud logins ---------
// Credentials for remote state backends (AWS / Azure / GCP), registered once in
// the platform's system settings and stored at ~/.terraform-code/credentials.enc
// (override with TF_CODE_CRED_DIR). The payload is AES-256-GCM ciphertext keyed
// by scrypt(passphrase, random 16-byte salt): authenticated encryption, so a
// wrong passphrase fails tag verification (no canary needed). No plaintext ever
// touches disk and the passphrase is never stored or logged. "Unlocking"
// verifies the passphrase and keeps the decrypted payload in server memory only
// (TTL-bounded), which is gone when the process exits.
//
// Logging in authenticates against the real cloud service using the installed
// CLI clients (aws / az / gcloud): `aws sts get-caller-identity`,
// `az login --service-principal` (secret passed via env, never argv) and
// `gcloud auth activate-service-account`. A successful login opens a per-provider
// session; only providers with an active session have their credentials injected
// into terraform runs as environment variables.

const CRED_DIR_NAME = '.terraform-code';
const CRED_FILE_NAME = 'credentials.enc';
const SCRYPT_N = 32768; // 2^15 — ~32 MiB working memory per derivation
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const CRED_SALT_LEN = 16;
const CRED_IV_LEN = 12;
const CRED_KEY_LEN = 32; // AES-256
const CRED_PASS_MIN = 8;
const CRED_PASS_MAX = 512;
const CRED_UNLOCK_TTL_MS = Number(process.env.CRED_UNLOCK_TTL_MS) || 15 * 60_000;
// Cloud CLIs are spawned with a bounded timeout (az login can be slow on first use).
const CLOUD_LOGIN_TIMEOUT_MS = Number(process.env.CLOUD_LOGIN_TIMEOUT_MS) || 90_000;
// CLI binary names, read lazily so tests can override them via CLOUD_*_BIN.
function cliBin(name) {
  return process.env[`CLOUD_${name.toUpperCase()}_BIN`] || name;
}

// Whitelisted credential fields per provider (string values only, with length
// caps). Unknown providers or keys are rejected so the store can never carry
// arbitrary data.
const CRED_PROVIDERS = {
  aws: [
    ['accessKeyId', 128],
    ['secretAccessKey', 512],
    ['sessionToken', 4096], // STS temporary credentials only
    ['region', 32], // e.g. us-east-2; empty = leave the CLI default
  ],
  azure: [
    ['clientId', 128],
    ['clientSecret', 512],
    ['tenantId', 128],
    ['subscriptionId', 128],
  ],
  gcp: [
    ['serviceAccountJson', 65536],
    ['projectId', 128], // GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT; empty = key's own project
  ],
  github: [
    ['username', 128],
    ['token', 512], // personal access token (required when 2FA is on — passwords never work)
    ['host', 253], // self-hosted instance host; empty = github.com
  ],
  gitlab: [
    ['username', 128],
    ['token', 512], // personal access token (required when 2FA is on — passwords never work)
    ['host', 253], // self-hosted instance host; empty = gitlab.com
  ],
};

// Default public hosts for the git credential providers (used when a stored
// entry leaves `host` empty). Git credentials are consumed by push/pull/fetch
// via GIT_ASKPASS — never by cloud logins or terraform env injection.
const GIT_CRED_PROVIDERS = { github: 'github.com', gitlab: 'gitlab.com' };

function gitCredentialMetadata(creds) {
  const metadata = {};
  for (const [provider, defaultHost] of Object.entries(GIT_CRED_PROVIDERS)) {
    const entry = creds[provider];
    if (!entry) continue;
    metadata[provider] = {
      username: typeof entry.username === 'string' ? entry.username : '',
      host: typeof entry.host === 'string' && entry.host.trim() !== '' ? entry.host.trim().toLowerCase() : defaultHost,
      hasToken: typeof entry.token === 'string' && entry.token !== '',
    };
  }
  return metadata;
}

// Global store location (system settings scope, never inside a project).
function credHomeDir() {
  return process.env.TF_CODE_CRED_DIR || path.join(os.homedir(), CRED_DIR_NAME);
}

function isValidPassphrase(p) {
  return typeof p === 'string' && p.length >= CRED_PASS_MIN && p.length <= CRED_PASS_MAX;
}

// Validate + normalize a credentials payload. Returns { error } or
// { creds, providers }; providers with no non-empty fields are dropped. With
// allowEmpty the "at least one field" rule is relaxed (update-with-removals).
function normalizeCredentials(raw, allowEmpty = false) {
  if (!isPlainObject(raw)) return { error: 'credentials must be an object' };
  const creds = {};
  for (const [provider, fields] of Object.entries(CRED_PROVIDERS)) {
    const block = raw[provider];
    if (block === undefined || block === null) continue;
    if (!isPlainObject(block)) return { error: `${provider} credentials must be an object` };
    for (const key of Object.keys(block)) {
      if (!fields.some(([n]) => n === key)) return { error: `Unknown ${provider} credential field "${key}"` };
    }
    const out = {};
    for (const [name, maxLen] of fields) {
      const value = block[name];
      if (value === undefined || value === null) {
        out[name] = '';
        continue;
      }
      if (typeof value !== 'string' || value.length > maxLen) {
        return { error: `${provider}.${name} must be a string of at most ${maxLen} characters` };
      }
      for (const ch of value) {
        const c = ch.charCodeAt(0);
        // GCP service-account JSON may span lines; every other field stays clean.
        if ((c < 32 && !(provider === 'gcp' && name === 'serviceAccountJson' && (c === 10 || c === 9))) || c === 127) {
          return { error: `${provider}.${name} contains invalid characters` };
        }
      }
      out[name] = value;
    }
    if (Object.values(out).some(v => v !== '')) creds[provider] = out;
  }
  // A GCP service-account key must parse as a JSON object.
  if (creds.gcp && creds.gcp.serviceAccountJson.trim() !== '') {
    try {
      const parsed = JSON.parse(creds.gcp.serviceAccountJson);
      if (!isPlainObject(parsed)) throw new Error('not an object');
    } catch {
      return { error: 'gcp.serviceAccountJson must be a valid service-account key (JSON object)' };
    }
  }
  for (const provider of ['github', 'gitlab']) {
    if (creds[provider]?.host && normalizeGitHost(creds[provider].host) === null) {
      return { error: `${provider}.host must be a hostname with an optional port` };
    }
  }
  const providers = Object.keys(creds);
  if (providers.length === 0 && !allowEmpty) return { error: 'Provide at least one credential field' };
  return { creds, providers };
}

function credStorePath() {
  return path.join(credHomeDir(), CRED_FILE_NAME);
}

function deriveCredKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf-8'), salt, CRED_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_N * SCRYPT_R * 128 * 2, // 2x the working-set requirement
  });
}

// Encrypt a normalized credential payload. Fresh salt + IV on every write; the
// result is plain JSON of hex fields (safe to store in any text file).
function encryptCredFile(creds, providers, passphrase) {
  const salt = crypto.randomBytes(CRED_SALT_LEN);
  const iv = crypto.randomBytes(CRED_IV_LEN);
  const key = deriveCredKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(creds), 'utf-8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // Non-sensitive git identifiers (username/host only — never tokens) so the UI
  // can show what is stored without decrypting; survives restarts and lock state.
  const gitMeta = gitCredentialMetadata(creds);
  return {
    v: 1,
    kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ct: ct.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    // Non-sensitive metadata only so the UI can show status without decrypting.
    // Never contains credential values (tokens stay inside the ciphertext).
    meta: { providers, git: gitMeta },
  };
}

// Returns the decrypted payload, or null when the passphrase is wrong (GCM auth
// failure) or the file is malformed.
function decryptCredPayload(fileObj, passphrase) {
  try {
    if (!isPlainObject(fileObj) || fileObj.v !== 1) return null;
    const salt = Buffer.from(String(fileObj.salt), 'hex');
    const iv = Buffer.from(String(fileObj.iv), 'hex');
    const ct = Buffer.from(String(fileObj.ct), 'hex');
    const tag = Buffer.from(String(fileObj.tag), 'hex');
    if (salt.length !== CRED_SALT_LEN || iv.length !== CRED_IV_LEN || tag.length !== 16) return null;
    const key = deriveCredKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on auth failure
    const parsed = JSON.parse(plain.toString('utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readCredFile() {
  try {
    const raw = fs.readFileSync(credStorePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null; // absent or unreadable — treated as "no store"
  }
}

// Atomic write (temp file + rename) with owner-only permissions, plus a
// .gitignore inside the folder so the encrypted store can never be committed.
function writeCredFile(fileObj) {
  const dirPath = credHomeDir();
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(dirPath, '.gitignore'), '*\n', { flag: 'wx' }); // create-only
  } catch {
    // already present; the .enc file itself is still protected by encryption
  }
  const target = path.join(dirPath, CRED_FILE_NAME);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(fileObj), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// In-memory unlocked store (never persisted): single global payload + expiry.
let credUnlockedPayload = null;
let credUnlockExpiry = 0;
let credUnlockTimer = null;
let credLockGeneration = 0;

// Sessions contain provider identities, not secrets. A pending login must not
// be allowed to restore a session after a lock, logout, or credential change.
const cloudSessions = new Map();
const cloudLoginGenerations = new Map();

function invalidateCloudLogin(provider) {
  const generation = (cloudLoginGenerations.get(provider) ?? 0) + 1;
  cloudLoginGenerations.set(provider, generation);
  return generation;
}

function credUnlockEntry() {
  if (credUnlockedPayload === null) return null;
  if (Date.now() >= credUnlockExpiry) {
    clearCredUnlock();
    return null;
  }
  return credUnlockedPayload;
}

function scheduleCredExpiry() {
  const delay = Math.max(1, Math.min(credUnlockExpiry - Date.now(), 2_147_483_647));
  credUnlockTimer = setTimeout(() => {
    if (Date.now() >= credUnlockExpiry) clearCredUnlock();
    else scheduleCredExpiry();
  }, delay);
  credUnlockTimer.unref();
}

function setCredUnlock(payload) {
  if (credUnlockTimer !== null) clearTimeout(credUnlockTimer);
  credUnlockedPayload = payload;
  credUnlockExpiry = Date.now() + CRED_UNLOCK_TTL_MS;
  scheduleCredExpiry();
}

function clearCredUnlock() {
  if (credUnlockTimer !== null) clearTimeout(credUnlockTimer);
  credUnlockTimer = null;
  credUnlockedPayload = null;
  credUnlockExpiry = 0;
  credLockGeneration += 1;
  cloudSessions.clear();
}

// --- Cloud CLI helpers --------------------------------------------------------

// Extra PATH directories for CLIs installed outside the default PATH (pip's
// ~/.local/bin, ~/go/bin, gcloud's tarball install). CLOUD_CLI_EXTRA_PATH
// overrides the list entirely ('' disables it — used by tests so fake CLIs on
// PATH are never shadowed by real installations).
function cliPathDirs() {
  if (process.env.CLOUD_CLI_EXTRA_PATH !== undefined) {
    return process.env.CLOUD_CLI_EXTRA_PATH.split(path.delimiter).filter(Boolean);
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'go', 'bin'),
    path.join(home, 'google-cloud-sdk', 'bin'),
  ];
  return candidates.filter(d => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function cliEnv(extra = {}) {
  const dirs = cliPathDirs();
  const base =
    dirs.length > 0 ? { ...process.env, PATH: `${dirs.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}` } : process.env;
  return { ...base, ...extra };
}

function runCli(bin, args, extraEnv = {}, timeoutMs = CLOUD_LOGIN_TIMEOUT_MS) {
  return spawnCaptured(bin, args, os.homedir(), timeoutMs, cliEnv(extraEnv));
}

// Never echo stored secrets back in error output (CLI errors can quote argv/env).
function redactSecrets(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('[redacted]');
  }
  return out;
}

// --- Real cloud authentication -------------------------------------------------

async function loginAws(creds) {
  const env = {};
  if (creds.accessKeyId) env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
  if (creds.secretAccessKey) env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
  if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken;
  if (creds.region) {
    env.AWS_REGION = creds.region;
    env.AWS_DEFAULT_REGION = creds.region;
  }
  const args = ['sts', 'get-caller-identity'];
  if (creds.region) args.push(`--region=${creds.region}`);
  const res = await runCli(cliBin('aws'), args, env);
  if (res.error === 'enoent') return { error: 'aws CLI not found — install the AWS CLI to enable AWS login' };
  if (res.timedOut) return { error: 'AWS authentication timed out' };
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // fall through to the failure branch
  }
  if (!parsed || !parsed.Account) {
    const detail = redactSecrets((res.stderr || res.stdout).trim().slice(-400), [creds.secretAccessKey, creds.sessionToken]);
    return { error: `AWS rejected the credentials${detail ? `: ${detail}` : ''}` };
  }
  return { identity: parsed.Arn ?? `account ${parsed.Account}`, account: parsed.Account, arn: parsed.Arn ?? null };
}

async function loginAzure(creds) {
  // az does not read AZURE_* env vars for `login --service-principal` — the
  // service principal must be passed as explicit flags. The process is short-
  // lived and local, and CLI errors are redacted before reaching the client.
  const args = ['login', '--service-principal', '--output', 'json'];
  if (creds.clientId) args.push(`--username=${creds.clientId}`);
  if (creds.clientSecret) args.push(`--password=${creds.clientSecret}`);
  if (creds.tenantId) args.push(`--tenant=${creds.tenantId}`);

  const login = await runCli(cliBin('az'), args, {});
  if (login.error === 'enoent') return { error: 'az CLI not found — install the Azure CLI to enable Azure login' };
  if (login.timedOut) return { error: 'Azure authentication timed out' };
  let accounts = null;
  try {
    accounts = JSON.parse(login.stdout);
  } catch {
    // fall through to the failure branch
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    const detail = redactSecrets((login.stderr || login.stdout).trim().slice(-400), [creds.clientSecret]);
    return { error: `Azure rejected the service principal${detail ? `: ${detail}` : ''}` };
  }

  let subscriptionId = null;
  if (creds.subscriptionId) {
    const setRes = await runCli(cliBin('az'), ['account', 'set', `--subscription=${creds.subscriptionId}`, '--output', 'json']);
    if ((setRes.exitCode ?? 1) !== 0) {
      const detail = redactSecrets((setRes.stderr || setRes.stdout).trim().slice(-400), [creds.clientSecret]);
      return { error: `Azure login succeeded but selecting subscription "${creds.subscriptionId}" failed${detail ? `: ${detail}` : ''}` };
    }
    let shown = null;
    try {
      shown = JSON.parse(setRes.stdout);
    } catch {
      // non-JSON output is fine — the set command already succeeded
    }
    subscriptionId = (shown && typeof shown.id === 'string' ? shown.id : creds.subscriptionId) || null;
  }

  const show = await runCli(cliBin('az'), ['account', 'show', '--output', 'json']);
  let acct = null;
  try {
    acct = JSON.parse(show.stdout);
  } catch {
    // fall back to the login response
  }
  const name = (acct && acct.name) || accounts[0].name || 'service principal';
  const id = (acct && acct.id) || subscriptionId || null;
  return { identity: id ? `${name} (${id})` : String(name), subscriptionId: id, user: (acct && acct.user?.name) || null };
}

async function loginGcp(creds) {
  // The service-account key lives in the store dir as an owner-only file that
  // both gcloud and terraform runs use.
  const home = credHomeDir();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const keyFile = path.join(home, 'gcp-key.json');
  try {
    fs.writeFileSync(keyFile, creds.serviceAccountJson, { mode: 0o600 });
  } catch (err) {
    return { error: `Failed to write the GCP key file: ${err.message}` };
  }

  const activate = await runCli(cliBin('gcloud'), ['auth', 'activate-service-account', `--key-file=${keyFile}`]);
  if (activate.error === 'enoent') return { error: 'gcloud CLI not found — install the Google Cloud CLI to enable GCP login' };
  if (activate.timedOut) return { error: 'GCP authentication timed out' };
  if ((activate.exitCode ?? 1) !== 0) {
    const detail = redactSecrets((activate.stderr || activate.stdout).trim().slice(-400), []);
    return { error: `Google Cloud rejected the service account${detail ? `: ${detail}` : ''}` };
  }

  let project = creds.projectId;
  if (project) {
    const setRes = await runCli(cliBin('gcloud'), ['config', 'set', 'project', project]);
    if ((setRes.exitCode ?? 1) !== 0) return { error: `GCP login succeeded but selecting project "${project}" failed` };
  } else {
    try {
      const parsed = JSON.parse(creds.serviceAccountJson);
      if (typeof parsed.project_id === 'string' && parsed.project_id) project = parsed.project_id;
    } catch {
      // already validated as a JSON object at registration time
    }
  }

  let account = null;
  const acctRes = await runCli(cliBin('gcloud'), ['config', 'get-value', 'account']);
  if ((acctRes.exitCode ?? 1) === 0 && acctRes.stdout.trim()) account = acctRes.stdout.trim();
  return { identity: [account, project].filter(Boolean).join(' @ ') || 'service account', account, project };
}

// Environment variables for a terraform run from the global credential store.
// Only providers with an ACTIVE login session are injected, so merely having
// credentials registered never leaks them into a process environment.
function buildCloudEnv() {
  const payload = credUnlockEntry();
  if (payload === null) return {};
  const env = {};
  for (const [provider, creds] of Object.entries(payload)) {
    if (!cloudSessions.has(provider)) continue;
    if (provider === 'aws') {
      if (creds.accessKeyId) env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
      if (creds.secretAccessKey) env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
      if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken;
      if (creds.region) {
        env.AWS_REGION = creds.region;
        env.AWS_DEFAULT_REGION = creds.region;
      }
    } else if (provider === 'azure') {
      // ARM_* is what the azurerm provider reads; AZURE_* covers SDK/CLI tooling.
      if (creds.clientId) {
        env.ARM_CLIENT_ID = creds.clientId;
        env.AZURE_CLIENT_ID = creds.clientId;
      }
      if (creds.clientSecret) {
        env.ARM_CLIENT_SECRET = creds.clientSecret;
        env.AZURE_CLIENT_SECRET = creds.clientSecret;
      }
      if (creds.tenantId) {
        env.ARM_TENANT_ID = creds.tenantId;
        env.AZURE_TENANT_ID = creds.tenantId;
      }
      if (creds.subscriptionId) {
        env.ARM_SUBSCRIPTION_ID = creds.subscriptionId;
        env.AZURE_SUBSCRIPTION_ID = creds.subscriptionId;
      }
    } else if (provider === 'gcp' && creds.serviceAccountJson.trim() !== '') {
      const keyFile = path.join(credHomeDir(), 'gcp-key.json');
      try {
        if (fs.statSync(keyFile).isFile()) env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
      } catch {
        // key file missing — the login that wrote it must have been cleared
      }
      if (creds.projectId) {
        env.GOOGLE_CLOUD_PROJECT = creds.projectId;
        env.GCLOUD_PROJECT = creds.projectId;
      }
    }
  }
  return env;
}

// API endpoint: global cloud credential store + login session status. Never
// returns credential values — only which providers are configured, whether the
// store is unlocked, and which logins are currently active.
app.get('/api/cloud/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fileObj = readCredFile();
  const unlocked = credUnlockEntry() !== null;
  // Non-secret identifiers only, and only while unlocked (decryption required).
  // Lets the UI confirm what is stored after an unlock. Never includes secrets.
  let details;
  if (unlocked) {
    const payload = credUnlockEntry();
    details = {};
    if (payload.aws) details.aws = { accessKeyId: payload.aws.accessKeyId ?? '', region: payload.aws.region ?? '', hasSecretAccessKey: Boolean(payload.aws.secretAccessKey), hasSessionToken: Boolean(payload.aws.sessionToken) };
    if (payload.azure) details.azure = { clientId: payload.azure.clientId ?? '', tenantId: payload.azure.tenantId ?? '', subscriptionId: payload.azure.subscriptionId ?? '' };
    if (payload.gcp) details.gcp = { projectId: payload.gcp.projectId ?? '' };
  }
  res.json({
    exists: fileObj !== null,
    providers: fileObj !== null && Array.isArray(fileObj.meta?.providers) ? fileObj.meta.providers : [],
    unlocked,
    sessions: unlocked ? Object.fromEntries(cloudSessions) : {},
    ...(unlocked ? { unlockedUntil: credUnlockExpiry } : {}),
    ...(details ? { details } : {}),
  });
});

// API endpoint: manage the global credential store (system settings). Actions:
//   create            { passphrase, credentials } — new store (409 if exists)
//   update            { passphrase, credentials } — verify + re-encrypt
//   change-passphrase { oldPassphrase, newPassphrase }
//   unlock            { passphrase } — verify; keep payload in memory for the TTL
//   lock              {} — drop the in-memory copy immediately
//   delete            { passphrase } — verify + remove the store file
app.post('/api/cloud/credentials', (req, res) => {
  const body = req.body ?? {};

  const action = typeof body.action === 'string' ? body.action : '';

  const statusPayload = () => {
    const fileObj = readCredFile();
    const unlocked = credUnlockEntry() !== null;
    return {
      ok: true,
      exists: fileObj !== null,
      providers: fileObj !== null && Array.isArray(fileObj.meta?.providers) ? fileObj.meta.providers : [],
      unlocked,
      sessions: unlocked ? Object.fromEntries(cloudSessions) : {},
      ...(unlocked ? { unlockedUntil: credUnlockExpiry } : {}),
    };
  };

  if (action === 'create' || action === 'update') {
    if (!isValidPassphrase(body.passphrase)) {
      return res.status(400).json({ error: `Passphrase must be ${CRED_PASS_MIN}-${CRED_PASS_MAX} characters` });
    }
    const existing = readCredFile();

    let next; // normalized credential payload to persist
    let old = null;
    if (action === 'create') {
      if (existing !== null) {
        return res.status(409).json({ error: 'Cloud credentials are already registered — use update instead' });
      }
      const normalized = normalizeCredentials(body.credentials);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      next = normalized.creds;
    } else {
      if (existing === null) return res.status(404).json({ error: 'No cloud credentials are registered yet' });
      old = decryptCredPayload(existing, body.passphrase);
      if (old === null) return res.status(401).json({ error: 'Wrong passphrase' });

      // Partial updates preserve omitted fields, including stored secrets.
      const changes = body.credentials ?? {};
      if (!isPlainObject(changes)) return res.status(400).json({ error: 'credentials must be an object' });
      for (const provider of Object.keys(changes)) {
        if (!Object.hasOwn(CRED_PROVIDERS, provider)) return res.status(400).json({ error: `Unknown credential provider "${provider}"` });
        if (!isPlainObject(changes[provider])) return res.status(400).json({ error: `${provider} credentials must be an object` });
      }
      next = { ...old };
      for (const provider of Object.keys(next)) {
        if (!Object.hasOwn(CRED_PROVIDERS, provider)) delete next[provider]; // drop unknown legacy keys
      }
      const removeList = Array.isArray(body.removeProviders) ? body.removeProviders : [];
      for (const p of removeList) {
        if (typeof p !== 'string' || !Object.hasOwn(CRED_PROVIDERS, p)) {
          return res.status(400).json({ error: `Unknown provider "${p}" in removeProviders` });
        }
        delete next[p];
      }
      for (const [provider, block] of Object.entries(changes)) {
        if (removeList.includes(provider)) return res.status(400).json({ error: `Cannot update and remove ${provider} together` });
        const normalized = normalizeCredentials({ [provider]: { ...(old[provider] ?? {}), ...block } }, true);
        if (normalized.error) return res.status(400).json({ error: normalized.error });
        if (normalized.creds[provider]) next[provider] = normalized.creds[provider];
      }
    }

    try {
      writeCredFile(encryptCredFile(next, Object.keys(next), body.passphrase));
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save credentials', details: err.message });
    }
    if (action === 'update') {
      for (const provider of ['aws', 'azure', 'gcp']) {
        if (JSON.stringify(old[provider]) !== JSON.stringify(next[provider])) {
          invalidateCloudLogin(provider);
          cloudSessions.delete(provider);
        }
      }
    }
    // The caller just proved passphrase knowledge (or set a new one): leave the
    // store unlocked so immediate follow-ups — test, login, git push/pull/fetch —
    // work without re-entering the passphrase. The TTL still applies.
    setCredUnlock(next);
    return res.json(statusPayload());
  }

  if (action === 'change-passphrase') {
    const existing = readCredFile();
    if (existing === null) return res.status(404).json({ error: 'No cloud credentials are registered yet' });
    if (!isValidPassphrase(body.newPassphrase)) {
      return res.status(400).json({ error: `New passphrase must be ${CRED_PASS_MIN}-${CRED_PASS_MAX} characters` });
    }
    const payload = decryptCredPayload(existing, body.oldPassphrase);
    if (payload === null) return res.status(401).json({ error: 'Wrong passphrase' });
    try {
      writeCredFile(encryptCredFile(payload, Object.keys(payload), body.newPassphrase));
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save credentials', details: err.message });
    }
    if (credUnlockEntry() !== null) setCredUnlock(payload);
    else clearCredUnlock();
    return res.json(statusPayload());
  }

  if (action === 'unlock') {
    const existing = readCredFile();
    if (existing === null) return res.status(404).json({ error: 'No cloud credentials are registered yet' });
    if (!isValidPassphrase(body.passphrase)) {
      return res.status(400).json({ error: `Passphrase must be ${CRED_PASS_MIN}-${CRED_PASS_MAX} characters` });
    }
    const payload = decryptCredPayload(existing, body.passphrase);
    if (payload === null) return res.status(401).json({ error: 'Wrong passphrase' });
    setCredUnlock(payload);
    // Backfill non-secret git metadata for stores written before it existed.
    if (!isPlainObject(existing.meta?.git)) {
      try {
        writeCredFile(encryptCredFile(payload, Object.keys(payload), body.passphrase));
      } catch {
        // backfill is cosmetic; the unlock itself already succeeded
      }
    }
    return res.json(statusPayload());
  }

  if (action === 'lock') {
    clearCredUnlock();
    return res.json(statusPayload());
  }

  if (action === 'delete') {
    const existing = readCredFile();
    if (existing === null) return res.status(404).json({ error: 'No cloud credentials are registered yet' });
    if (!isValidPassphrase(body.passphrase)) {
      return res.status(400).json({ error: `Passphrase must be ${CRED_PASS_MIN}-${CRED_PASS_MAX} characters` });
    }
    if (decryptCredPayload(existing, body.passphrase) === null) {
      return res.status(401).json({ error: 'Wrong passphrase' });
    }
    try {
      fs.rmSync(credStorePath(), { force: true });
      fs.rmSync(path.join(credHomeDir(), 'gcp-key.json'), { force: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete credentials', details: err.message });
    }
    clearCredUnlock();
    return res.json(statusPayload());
  }

  return res.status(400).json({
    error: "action must be one of 'create', 'update', 'change-passphrase', 'unlock', 'lock', 'delete'",
  });
});

// API endpoint: authenticate against a cloud provider using the registered
// credentials (the platform performs the real login via the installed CLI).
// An optional passphrase unlocks the store first when it is locked.
app.post('/api/cloud/login', async (req, res) => {
  const body = req.body ?? {};
  const provider = typeof body.provider === 'string' ? body.provider : '';
  if (!Object.hasOwn(CRED_PROVIDERS, provider)) {
    return res.status(400).json({ error: `provider must be one of ${Object.keys(CRED_PROVIDERS).join(', ')}` });
  }
  if (Object.hasOwn(GIT_CRED_PROVIDERS, provider)) {
    return res.status(400).json({ error: `${provider} credentials are used automatically by git push/pull/fetch — no login needed` });
  }

  let payload = credUnlockEntry();
  if (payload === null) {
    const existing = readCredFile();
    if (existing === null) return res.status(404).json({ error: 'No cloud credentials registered yet — add them in Settings first' });
    // Offer to unlock inline so a single click can complete the login.
    if (!isValidPassphrase(body.passphrase)) {
      return res.status(401).json({ error: 'The credential store is locked — enter its passphrase to log in' });
    }
    payload = decryptCredPayload(existing, body.passphrase);
    if (payload === null) return res.status(401).json({ error: 'Wrong passphrase' });
    setCredUnlock(payload);
  }

  const creds = payload[provider];
  if (!creds) return res.status(404).json({ error: `No ${provider} credentials are registered` });

  const lockGeneration = credLockGeneration;
  const loginGeneration = invalidateCloudLogin(provider);
  let outcome;
  try {
    outcome = provider === 'aws' ? await loginAws(creds) : provider === 'azure' ? await loginAzure(creds) : await loginGcp(creds);
  } catch (err) {
    return res.status(500).json({ error: `Login failed: ${err.message}` });
  }
  // Check expiry first: it also invalidates sessions and pending logins.
  const currentPayload = credUnlockEntry();
  if (currentPayload === null || credLockGeneration !== lockGeneration ||
      cloudLoginGenerations.get(provider) !== loginGeneration) {
    return res.status(409).json({ error: 'Credential state changed while logging in — start login again' });
  }
  if (outcome.error) return res.status(401).json({ error: outcome.error });

  const session = { loggedInAt: Date.now(), identity: outcome.identity, ...outcome };
  cloudSessions.set(provider, session);
  setCredUnlock(currentPayload); // preserve unrelated credential updates
  res.json({ ok: true, provider, session });
});

// API endpoint: end an in-app login session (stops credential injection for
// that provider). The CLI's own machine-level state is left untouched.
app.post('/api/cloud/logout', (req, res) => {
  const body = req.body ?? {};
  const provider = typeof body.provider === 'string' ? body.provider : '';
  if (!Object.hasOwn(CRED_PROVIDERS, provider)) {
    return res.status(400).json({ error: `provider must be one of ${Object.keys(CRED_PROVIDERS).join(', ')}` });
  }
  invalidateCloudLogin(provider);
  cloudSessions.delete(provider);
  res.json({ ok: true, provider });
});

// Validate the command + client arguments from a request body or query object.
// Returns { error } when invalid, otherwise { opts } for runTerraformCommand.
function validateTfRun(command, source) {
  if (typeof command !== 'string' || (!Object.hasOwn(TF_COMMANDS, command) && !TF_ARG_COMMANDS.has(command))) {
    return {
      error: `Command must be one of ${[...Object.keys(TF_COMMANDS), ...TF_ARG_COMMANDS].map(c => `'${c}'`).join(', ')}`,
    };
  }

  const address = typeof source.address === 'string' ? source.address.trim() : '';
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const srcAddress = typeof source.srcAddress === 'string' ? source.srcAddress.trim() : '';
  const destAddress = typeof source.destAddress === 'string' ? source.destAddress.trim() : '';
  const importId = typeof source.importId === 'string' ? source.importId : '';
  const varFile = typeof source.varFile === 'string' ? source.varFile.trim() : '';
  const expression = typeof source.expression === 'string' ? source.expression : '';

  if (command === 'state-show' || command === 'state-rm') {
    if (!isValidTfAddress(address)) {
      return { error: "Must include a valid resource address, e.g. 'aws_instance.web'" };
    }
  } else if (command === 'workspace-new' || command === 'workspace-select') {
    if (!isValidWorkspaceName(name)) {
      return { error: "Must include a valid workspace name (letters, digits, '_' and '-')" };
    }
  } else if (command === 'import') {
    if (!isValidTfAddress(address)) {
      return { error: "Import needs a valid resource address, e.g. 'aws_s3_bucket.logs'" };
    }
    if (!isValidImportId(importId)) {
      return { error: 'Import needs a non-empty resource ID that does not start with "-"' };
    }
  } else if (command === 'state-mv') {
    if (!isValidTfAddress(srcAddress) || !isValidTfAddress(destAddress)) {
      return { error: 'State mv needs valid source and destination addresses' };
    }
  } else if (command === 'console-eval') {
    if (!isValidConsoleExpression(expression)) {
      return { error: 'Must include a non-empty expression to evaluate' };
    }
  }

  const opts = {};
  if (varFile !== '') {
    if (!TF_VARFILE_COMMANDS.has(command)) {
      return { error: `var-file is only supported for: ${[...TF_VARFILE_COMMANDS].join(', ')}` };
    }
    if (!isValidVarFileName(varFile)) {
      return { error: 'var-file must be a .tfvars file name in the project directory' };
    }
    opts.varFile = varFile;
  }

  const backendConfig = parseBackendConfig(source.backendConfig);
  if (backendConfig === null) return { error: 'Invalid backend-config pairs' };
  if (backendConfig.length > 0 && command !== 'init' && command !== 'init-upgrade') {
    return { error: 'backend-config is only supported for init and init-upgrade' };
  }
  opts.backendConfig = backendConfig;

  if (address) opts.address = address;
  if (name) opts.name = name;
  if (srcAddress) opts.srcAddress = srcAddress;
  if (destAddress) opts.destAddress = destAddress;
  if (importId !== '') opts.importId = importId;
  if (expression !== '') opts.expression = expression;

  return { opts };
}

// API endpoint: run a whitelisted terraform command in a directory. All commands
// run in text mode so the UI can show exactly what a shell would print.
// Fixed-arg commands: fmt | validate | plan | drift | init | init-upgrade |
//   output | state-list | version | workspace-list | show-plan | plan-file |
//   apply | plan-file-destroy. Arg commands (validated): state-show,
//   workspace-new/select, import, state-mv/rm, console-eval. Optional: varFile
//   (.tfvars name) and backendConfig (init only).
app.post('/api/tf/run', (req, res) => {
  const body = req.body ?? {};
  const command = typeof body.command === 'string' ? body.command : '';

  const validated = validateTfRun(command, body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const opts = validated.opts;

  const dir = resolveTfDir(res, body.path);
  if (!dir) return;

  // var-file must exist as a regular file in the project directory.
  if (opts.varFile !== undefined) {
    try {
      if (!fs.statSync(path.join(dir, opts.varFile)).isFile()) {
        return res.status(400).json({ error: `var-file ${opts.varFile} not found in the project directory` });
      }
    } catch {
      return res.status(400).json({ error: `var-file ${opts.varFile} not found in the project directory` });
    }
  }

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  tfRunning.add(dir);

  runTerraformCommand(command, dir, opts)
    .then(({ statusCode, body: payload }) => {
      if (!res.headersSent) res.status(statusCode).json(payload);
    })
    .catch(err => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to run terraform', details: err.message });
      }
    })
    .finally(() => {
      tfRunning.delete(dir);
    });
});

// The raw JSON is requested explicitly: Terraform may include sensitive values.
app.post('/api/tf/plan-json', async (req, res) => {
  const body = req.body ?? {};
  const id = typeof body.previewId === 'string' ? body.previewId : '';
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(400).json({ error: 'Invalid plan preview' });
  const dir = resolveTfDir(res, body.path);
  if (!dir) return;
  const preview = tfPreviews.get(id);
  if (!preview || preview.dir !== dir || Date.now() >= preview.expiresAt) {
    return res.status(404).json({ error: 'Plan preview expired — run Plan again' });
  }
  if (tfRunning.has(dir)) return res.status(409).json({ error: 'A terraform command is already running for this directory' });
  tfRunning.add(dir);
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terracode-plan-'));
    const file = path.join(tempDir, 'plan');
    fs.writeFileSync(file, preview.bytes, { mode: 0o600 });
    const result = await runTerraform(dir, ['show', '-json', file], undefined, undefined, undefined, TF_PREVIEW_MAX_BYTES);
    if (result.error === 'output-too-large') return res.status(413).json({ error: 'Plan JSON exceeds the preview size limit' });
    if (result.error || result.timedOut || result.exitCode !== 0) {
      return res.status(result.timedOut ? 504 : 500).json({ error: 'Could not render the saved plan as JSON' });
    }
    try { JSON.parse(result.stdout); } catch { return res.status(500).json({ error: 'Terraform returned invalid plan JSON' }); }
    res.set('Cache-Control', 'no-store');
    return res.json({ rawJson: result.stdout });
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tfRunning.delete(dir);
  }
});

// API endpoint: run a whitelisted terraform command and stream its output live.
// Same validation as POST /api/tf/run (query params instead of body). Responds
// with Server-Sent Events: {"type":"chunk","text"} while the command runs, then
// {"type":"done","status":N,"result":{...}} (or {"type":"error",...}) and ends.
app.get('/api/tf/run-stream', (req, res) => {
  const command = typeof req.query.command === 'string' ? req.query.command : '';

  // Same validation as POST /api/tf/run; query values are strings, so
  // backendConfig arrives JSON-encoded and parseBackendConfig decodes it.
  const validated = validateTfRun(command, req.query);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const opts = validated.opts;

  const dir = resolveTfDir(res, typeof req.query.path === 'string' ? req.query.path : '');
  if (!dir) return;

  if (opts.varFile !== undefined) {
    try {
      if (!fs.statSync(path.join(dir, opts.varFile)).isFile()) {
        return res.status(400).json({ error: `var-file ${opts.varFile} not found in the project directory` });
      }
    } catch {
      return res.status(400).json({ error: `var-file ${opts.varFile} not found in the project directory` });
    }
  }

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  tfRunning.add(dir);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"hello"}\n\n'); // initial message confirms the stream is live

  const send = obj => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      // client already disconnected; 'close' ends the response below
    }
  };

  runTerraformCommand(command, dir, opts, text => send({ type: 'chunk', text }))
    .then(({ statusCode, body }) => {
      send({ type: 'done', status: statusCode, result: body });
    })
    .catch(err => {
      send({ type: 'error', error: err.message });
    })
    .finally(() => {
      tfRunning.delete(dir);
      res.end();
    });

  // If the client disconnects mid-run the command keeps running to completion
  // (same semantics as POST /api/tf/run); writes above become no-ops.
});

// API endpoint: list tfenv-managed terraform versions and the active one for a dir
app.get('/api/tf/versions', (req, res) => {
  const rawPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : BASE_DIR;
  const dir = resolveTfDir(res, rawPath);
  if (!dir) return;

  if (!tfenvBinDir()) {
    return res.json({ tfenvAvailable: false, installed: [], active: null });
  }

  Promise.all([
    runTfenv(dir, ['list']),
    runTfenv(dir, ['version-name']),
  ]).then(([listRes, nameRes]) => {
    const installed = listRes.error ? [] : parseTfVersions(listRes.stdout);
    let active = null;
    if (!nameRes.error && !nameRes.timedOut) {
      const firstLine = (nameRes.stdout || '').trim().split('\n')[0].trim();
      if (firstLine) active = firstLine;
    }
    res.json({ tfenvAvailable: true, installed, active });
  }).catch(err => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to query tfenv', details: err.message });
    }
  });
});

// API endpoint: set the terraform version for a directory by writing its
// .terraform-version file (the format tfenv expects; `tfenv pin` writes it too)
app.post('/api/tf/version', (req, res) => {
  const body = req.body ?? {};
  const rawPath = body.path;
  const version = typeof body.version === 'string' ? body.version.trim() : '';

  if (!TF_VERSION_RE.test(version)) {
    return res.status(400).json({ error: 'Version must look like a terraform release, e.g. 1.5.0 or 1.9.8-beta1' });
  }
  if (typeof rawPath !== 'string' || !rawPath) {
    return res.status(400).json({ error: 'Body must include a path string' });
  }

  const binDir = tfenvBinDir();
  if (!binDir) {
    return res.status(400).json({ error: 'tfenv is not available on this machine' });
  }

  const dir = resolveTfDir(res, rawPath);
  if (!dir) return;

  runTfenv(dir, ['list']).then(listRes => {
    const installed = listRes.error ? null : parseTfVersions(listRes.stdout);
    if (installed && !installed.includes(version)) {
      return res.status(400).json({ error: `Version ${version} is not installed — install it first` });
    }
    const file = path.join(dir, '.terraform-version');
    fs.writeFileSync(file, `${version}\n`, 'utf-8');
    res.json({ path: file, version });
  }).catch(err => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to set terraform version', details: err.message });
    }
  });
});

// API endpoint: install a terraform version via `tfenv install <version>`
let tfInstalling = false; // single global install at a time
app.post('/api/tf/install', (req, res) => {
  const body = req.body ?? {};
  const version = typeof body.version === 'string' ? body.version.trim() : '';

  if (!TF_VERSION_RE.test(version)) {
    return res.status(400).json({ error: 'Version must look like a terraform release, e.g. 1.5.0 or 1.9.8-beta1' });
  }

  const binDir = tfenvBinDir();
  if (!binDir) {
    return res.status(400).json({ error: 'tfenv is not available on this machine' });
  }

  if (tfInstalling) {
    return res.status(409).json({ error: 'A terraform install is already in progress' });
  }
  tfInstalling = true;

  runTfenv(process.cwd(), ['install', version], TF_INSTALL_TIMEOUT_MS)
    .then(result => {
      if (result.error === 'enoent') {
        return res.status(503).json({ error: 'tfenv executable not found' });
      }
      const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
      res.status(200).json({ exitCode: result.timedOut ? null : result.exitCode, output, timedOut: result.timedOut });
    })
    .catch(err => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to install terraform version', details: err.message });
      }
    })
    .finally(() => {
      tfInstalling = false;
    });
});

// --- Git operations --------------------------------------------------------
// Run git with fixed arguments inside an allowed directory that belongs to a
// repository. Arguments are never assembled from user input, except file
// pathspecs passed after `--` and the commit message passed via -m; everything
// is spawned without a shell.

const GIT_TIMEOUT_MS = Number(process.env.GIT_TIMEOUT_MS) || 60_000;
const GIT_NETWORK_TIMEOUT_MS = Number(process.env.GIT_NETWORK_TIMEOUT_MS) || 120_000; // push/pull/fetch
const GIT_CRED_TEST_TIMEOUT_MS = Number(process.env.GIT_CRED_TEST_TIMEOUT_MS) || 15_000; // provider API check
const GIT_MAX_STATUS_ENTRIES = 5000; // cap on parsed status records
const GIT_MAX_COMMIT_FILES = 200; // cap on explicit file lists for git add
const GIT_MAX_MESSAGE_LEN = 5000;
const GIT_MAX_BRANCHES = 1000; // cap on branches returned to the UI
const GIT_REMOTE_URL_MAX = 500; // cap on remote URL length
const GIT_DEFAULT_LOG_LIMIT = 50; // commits returned by /api/git/log when no limit given
const GIT_MAX_LOG_LIMIT = 200; // hard cap on how many commits a client may request
const GIT_MAX_COMMIT_DIFF_FILES = 50; // per-file diffs shown for one commit at most
// A git object id we are willing to hand back to git: 7-40 lowercase hex chars.
// Short hashes (>=7) and full 40-char ids both match; anything else is rejected
// before it can be parsed as a git option or pathspec.
const GIT_HASH_RE = /^[0-9a-f]{7,40}$/;
// Real dir paths with an in-flight *mutating* git op (commit/branch/checkout/
// merge/rebase/push/pull/fetch/init). Read-only ops (status/diff/branches/
// remotes) do not take this lock. One mutating op per directory at a time.
const gitBusy = new Set();

// Terraform commands and mutating git operations share one rule: nothing else
// may run on the same project meanwhile. A checkout, merge or pull rewrites the
// files a running terraform command reads, and a terraform run must not start
// while git is rewriting them. Two paths belong to the same project when one
// contains the other (a repository root and a Terraform folder inside it).
function pathsOverlap(a, b) {
  const inside = (child, parent) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

function projectBusyError(dir) {
  for (const d of tfRunning) {
    if (pathsOverlap(d, dir)) return 'A terraform command is already running for this directory';
  }
  for (const d of gitBusy) {
    if (pathsOverlap(d, dir)) return 'A git operation is already in progress for this directory';
  }
  return null;
}

// A safe branch/ref name: starts with a letter or digit, then letters/digits/
// '.', '_', '/', '-' (never leading '-'). This keeps user input from being parsed
// as a git option and excludes NUL/control characters by construction.
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isValidRefName(name) {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (!GIT_REF_RE.test(name)) return false;
  if (name.endsWith('.lock') || name.includes('..') || name.includes('@{')) return false;
  if (name === '.' || name === '..' || name.endsWith('/')) return false;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127) return false; // control chars (already excluded, be explicit)
  }
  return true;
}

// A remote URL we are willing to hand to git: http(s)/ssh/git URLs, scp-like
// user@host:path forms, or a local absolute path. No shell is used, but the
// metacharacter check is defense-in-depth against anything git might misread.
function isValidRemoteUrl(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > GIT_REMOTE_URL_MAX || u.includes('\0')) return false;
  if (/[\s;&|`$<>\\]/.test(u)) return false; // whitespace + shell metacharacters
  const webUrl = /^(https?|ssh|git):\/\//i.test(u);
  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(u);
  const localPath = /^\/[^\s]*$/.test(u) || u.startsWith('~/');
  return webUrl || scpLike || localPath;
}

// Best-effort detection of the hosting platform from a remote URL, so the UI can
// offer an "open in browser" link. Returns 'github', 'gitlab', or null. Works for
// github.com / GitHub Enterprise and gitlab.com / self-hosted GitLab alike.
function detectPlatform(url) {
  const u = String(url).toLowerCase();
  if (u.includes('github.com') || /(^|\/)github\./.test(u)) return 'github';
  if (u.includes('gitlab.')) return 'gitlab'; // gitlab.com and self-hosted *.gitlab.*
  return null;
}

// Derive a human-openable web URL from a git remote, e.g.
// https://github.com/owner/repo.git -> https://github.com/owner/repo
function repoWebUrl(url) {
  const u = String(url).trim();
  let m;
  if ((m = u.match(/^https?:\/\/([^/]+)\/(.+?)(\.git)?$/i))) return `https://${m[1]}/${m[2]}`;
  if ((m = u.match(/^[^@\s]+@([^:\s]+):(.+?)(\.git)?$/))) return `https://${m[1]}/${m[2]}`;
  return null;
}

// --- Git credential injection -------------------------------------------------
// Tokens stay in this process. A per-operation loopback broker with a random
// capability serves askpass; Git and its hooks do not inherit tokens in env.

function normalizeGitHost(host) {
  if (typeof host !== 'string' || host.trim() === '') return null;
  const raw = host.trim();
  if (/[\s/@?#\\]/.test(raw)) return null;
  try {
    const url = new URL(`https://${raw}`);
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function gitCredentialForPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const match = prompt.match(/^(Username|Password) for ['"]?(https:\/\/[^'"\s]+)['"]?:\s*$/i);
  if (!match) return null;
  let url;
  try { url = new URL(match[2]); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const payload = credUnlockEntry();
  if (payload === null) return null;
  for (const [provider, defaultHost] of Object.entries(GIT_CRED_PROVIDERS)) {
    const creds = payload[provider];
    if (!creds || typeof creds.token !== 'string' || creds.token === '') continue;
    const host = creds.host?.trim() ? normalizeGitHost(creds.host) : defaultHost;
    if (host !== url.host.toLowerCase()) continue;
    return match[1].toLowerCase() === 'password' ? creds.token : (creds.username || null);
  }
  return null;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function writeGitAskpassScript(dir) {
  const file = path.join(dir, 'askpass.sh');
  const isSea = require('node:sea').isSea();
  const helper = isSea ? '--terracode-git-askpass' : shellQuote(path.join(__dirname, 'scripts', 'git-askpass.cjs'));
  fs.writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${helper} "$@"\n`, { mode: 0o700 });
  return file;
}

async function runGitNetwork(cwd, args, timeoutMs = GIT_NETWORK_TIMEOUT_MS) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const payload = credUnlockEntry();
  const available = payload && Object.keys(GIT_CRED_PROVIDERS).some(p => typeof payload[p]?.token === 'string' && payload[p].token !== '');
  if (!available) return runGit(cwd, args, timeoutMs, env);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terracode-git-'));
  const key = crypto.randomBytes(32).toString('hex');
  const clients = new Set();
  const broker = net.createServer(client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.setTimeout(5000, () => client.destroy());
    let data = '';
    client.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 4096) return client.destroy();
      if (!data.includes('\n')) return;
      let value = null;
      try {
        const request = JSON.parse(data.split('\n')[0]);
        if (typeof request.key === 'string' && request.key.length === key.length &&
            crypto.timingSafeEqual(Buffer.from(request.key), Buffer.from(key))) value = gitCredentialForPrompt(request.prompt);
      } catch { /* invalid request */ }
      client.end(JSON.stringify({ value }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      broker.once('error', reject);
      broker.listen(0, '127.0.0.1', () => { broker.removeListener('error', reject); resolve(); });
    });
    broker.on('error', () => {});
    env.GIT_ASKPASS = writeGitAskpassScript(dir);
    env.TERRACODE_GIT_PORT = String(broker.address().port);
    env.TERRACODE_GIT_KEY = key;
    env.LC_ALL = 'C';
    return await runGit(cwd, args, timeoutMs, env);
  } finally {
    for (const client of clients) client.destroy();
    if (broker.listening) await new Promise(resolve => broker.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runGit(cwd, args, timeoutMs = GIT_TIMEOUT_MS, env) {
  return spawnCaptured('git', args, cwd, timeoutMs, env);
}

// Parse `git log --pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s` output.
// Records are newline-separated; fields within a record are NUL-separated with
// the subject last (joined back if it ever contained a NUL). Malformed/short
// records are skipped rather than throwing.
function parseGitLog(output) {
  const commits = [];
  for (const line of String(output).split('\n')) {
    if (!line) continue;
    const parts = line.split('\0');
    if (parts.length < 6) continue; // malformed record
    commits.push({
      hash: parts[0],
      short: parts[1],
      author: parts[2],
      email: parts[3],
      date: parts[4],
      subject: parts.slice(5).join('\0'),
    });
  }
  return commits;
}

// Parse `git show --name-status --format=<hash>` output into a list of changed
// files. Lines are tab-separated: "<status>\t<path>" or, for renames/copies,
// "<R|C><score>\t<oldpath>\t<newpath>". The status letter is the first char so
// "R100" and "C75" reduce to R / C.
function parseNameStatus(output) {
  const changed = [];
  for (const line of String(output).split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const status = (cols[0] || '').charAt(0);
    let oldPath = null;
    let newPath = null;
    if ((status === 'R' || status === 'C') && cols.length >= 3) {
      oldPath = cols[1];
      newPath = cols[2];
    } else if (cols.length >= 2) {
      oldPath = cols[1];
      newPath = cols[1];
    }
    if (!newPath || !status) continue;
    changed.push({ status, oldPath: oldPath ?? newPath, newPath });
  }
  return changed;
}

// Parse `git status --porcelain=v1 -z` output. Records are NUL-terminated:
// "XY <path>" where X = index status and Y = worktree status (space when
// clean). Rename/copy records carry the original path in the next chunk
// ("R  new\0old\0"). Untracked directories stay collapsed as "?? dir/".
function parsePorcelainZ(output) {
  const entries = [];
  const chunks = String(output).split('\0');
  let i = 0;
  while (i < chunks.length && entries.length < GIT_MAX_STATUS_ENTRIES) {
    const rec = chunks[i];
    if (!rec || rec.length < 4) {
      i++;
      continue; // empty trailing chunk or malformed record
    }
    const index = rec[0];
    const worktree = rec[1];
    let p = rec.slice(3);
    let origPath;
    if ((index === 'R' || index === 'C') && i + 1 < chunks.length) {
      origPath = chunks[i + 1];
      i++;
    }
    entries.push({ index, worktree, path: p, ...(origPath !== undefined ? { origPath } : {}) });
    i++;
  }
  return entries;
}

// API endpoint: git status (porcelain v1) for a directory. Non-repo paths get
// { isRepo: false } so the UI can hide git affordances gracefully.
app.get('/api/git/status', async (req, res) => {
  const rawPath = req.query.path;

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  const result = await runGit(dir, ['status', '--porcelain=v1', '-z']);
  if (result.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (result.error) {
    return res.status(500).json({ error: 'Failed to run git status', details: result.error });
  }
  // Non-zero exit covers "fatal: not a git repository" and index errors alike.
  if (result.timedOut || result.exitCode !== 0) {
    return res.json({ isRepo: false, entries: [] });
  }
  res.json({ isRepo: true, entries: parsePorcelainZ(result.stdout) });
});

// API endpoint: file content at HEAD and in the worktree (for diffing against
// HEAD). Untracked files come back with oldContent ''; deleted files with
// newContent ''.
app.get('/api/git/diff', async (req, res) => {
  const rawPath = req.query.path; // directory containing the file
  const file = req.query.file; // path relative to that directory

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }
  if (!file || typeof file !== 'string' || file.includes('\0')) {
    return res.status(400).json({ error: 'File parameter required' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  // The file may not exist on disk (deleted files are diffable), so resolveSafe
  // is only applied when it does; the static containment check always applies.
  const abs = path.resolve(dir, file);
  if (!withinAnyRoot(abs)) {
    return res.status(403).json({ error: 'Access denied: path outside allowed directory' });
  }

  const topRes = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (topRes.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (topRes.error) {
    return res.status(500).json({ error: 'Failed to run git', details: topRes.error });
  }
  if (topRes.timedOut || topRes.exitCode !== 0) {
    return res.status(400).json({ error: 'Path is not inside a git repository' });
  }
  const toplevel = (topRes.stdout || '').trim().split('\n')[0];

  let relToRoot;
  try {
    relToRoot = path.relative(toplevel, abs);
  } catch {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (relToRoot === '' || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return res.status(403).json({ error: 'Access denied: path outside repository' });
  }
  const gitPath = relToRoot.split(path.sep).join('/');

  // Old side: content at HEAD (missing there => untracked/new file)
  let oldContent = '';
  let inHead = false;
  const showRes = await runGit(dir, ['show', `HEAD:${gitPath}`]);
  if (!showRes.error && !showRes.timedOut && showRes.exitCode === 0) {
    inHead = true;
    oldContent = showRes.stdout;
  }

  // New side: current worktree content (missing => deleted file). resolveSafe
  // also rejects symlinks that escape the allowed roots.
  let newContent = '';
  let onDisk = false;
  const workCheck = resolveSafe(abs);
  if (!workCheck.error) {
    try {
      const st = fs.statSync(workCheck.path);
      if (st.isFile()) {
        if (st.size > MAX_FILE_SIZE) {
          return res.status(413).json({
            error: `File too large (${Math.round(st.size / 1024)} KB, limit ${MAX_FILE_SIZE / 1024} KB)`
          });
        }
        newContent = fs.readFileSync(workCheck.path, 'utf-8');
        onDisk = true;
      }
    } catch {
      // vanished between check and read; treat as deleted
    }
  } else if (workCheck.error === 'denied') {
    return res.status(403).json({ error: 'Access denied: path outside allowed directory' });
  }

  if (!inHead && !onDisk) {
    return res.status(404).json({ error: 'File not found in HEAD or worktree' });
  }
  if (Buffer.byteLength(oldContent, 'utf-8') > MAX_FILE_SIZE) {
    return res.status(413).json({ error: `File at HEAD too large (limit ${MAX_FILE_SIZE / 1024} KB)` });
  }
  if (looksBinary(oldContent)) {
    return res.status(415).json({ error: 'Binary file at HEAD: diff not supported' });
  }
  if (looksBinary(newContent)) {
    return res.status(415).json({ error: 'Binary file in worktree: diff not supported' });
  }

  res.json({ path: abs, oldContent, newContent, untracked: !inHead && onDisk });
});

// API endpoint: recent commit history for a directory. Read-only; no busy lock.
// Returns { isRepo:false, commits:[] } for non-repositories and empty histories.
app.get('/api/git/log', async (req, res) => {
  const rawPath = req.query.path;

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }

  let limit = Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = GIT_DEFAULT_LOG_LIMIT;
  limit = Math.min(Math.floor(limit), GIT_MAX_LOG_LIMIT);

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  const result = await runGit(dir, [
    'log', '-n', String(limit), '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s'
  ]);
  if (result.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (result.error) {
    return res.status(500).json({ error: 'Failed to run git log', details: result.error });
  }
  const stderr = String(result.stderr || '').toLowerCase();
  if (result.timedOut) {
    return res.status(504).json({ error: 'git log timed out' });
  }
  // Non-zero exit is either "not a repository" or an initialized-but-empty repo.
  if (result.exitCode !== 0 && !stderr.includes('does not have any commits')) {
    if (stderr.includes('not a git repository') || stderr.includes('bad revision')) {
      return res.json({ isRepo: false, commits: [] });
    }
    return res.status(500).json({ error: 'Failed to run git log', details: String(result.stderr || '').trim().slice(0, 2000) });
  }
  res.json({ isRepo: true, commits: parseGitLog(result.stdout) });
});

// API endpoint: the per-file diff a single commit introduced (its changes vs its
// parent). Read-only; no busy lock. The hash is validated before it reaches git.
app.get('/api/git/commit-diff', async (req, res) => {
  const rawPath = req.query.path; // directory inside the repository
  const hash = typeof req.query.hash === 'string' ? req.query.hash.trim() : '';

  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }
  if (!GIT_HASH_RE.test(hash)) {
    return res.status(400).json({ error: 'Invalid commit hash (expected 7-40 lowercase hex chars)' });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  const topRes = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (topRes.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (topRes.error) {
    return res.status(500).json({ error: 'Failed to run git', details: topRes.error });
  }
  if (topRes.timedOut || topRes.exitCode !== 0) {
    return res.status(400).json({ error: 'Path is not inside a git repository' });
  }

  // Commit metadata (single record, same field layout as /api/git/log minus hash).
  const metaRes = await runGit(dir, ['log', '-n', '1', '--pretty=format:%h%x00%an%x00%ae%x00%aI%x00%s', hash]);
  if (metaRes.error || metaRes.timedOut) {
    return res.status(500).json({ error: 'Failed to read commit metadata' });
  }
  const metaParts = (metaRes.stdout || '').split('\n')[0].split('\0');
  if (metaRes.exitCode !== 0 || metaParts.length < 5) {
    const err = String(metaRes.stderr || '').trim();
    return res.status(404).json({ error: err ? `Commit not found: ${err.slice(0, 200)}` : 'Commit not found' });
  }

  // Changed files for this commit (name-status, no header).
  const nsRes = await runGit(dir, ['show', '--name-status', '--format=', hash]);
  if (nsRes.error || nsRes.timedOut) {
    return res.status(500).json({ error: 'Failed to list changed files' });
  }
  if (nsRes.exitCode !== 0) {
    const err = String(nsRes.stderr || '').trim();
    return res.status(404).json({ error: err ? `Commit not found: ${err.slice(0, 200)}` : 'Commit not found' });
  }

  const changed = parseNameStatus(nsRes.stdout);
  const truncated = changed.length > GIT_MAX_COMMIT_DIFF_FILES;
  const toFetch = changed.slice(0, GIT_MAX_COMMIT_DIFF_FILES);

  // Fetch each file's content at the commit and its parent. Added files have no
  // parent blob (oldContent ''); deleted files have no commit blob (newContent '').
  const files = [];
  for (const c of toFetch) {
    let newContent = '';
    if (c.status !== 'D') {
      const nr = await runGit(dir, ['show', `${hash}:${c.newPath}`]);
      if (!nr.error && !nr.timedOut && nr.exitCode === 0) newContent = nr.stdout;
    }
    let oldContent = '';
    if (c.status !== 'A') {
      const pr = await runGit(dir, ['show', `${hash}^:${c.oldPath}`]);
      if (!pr.error && !pr.timedOut && pr.exitCode === 0) oldContent = pr.stdout;
    }

    let binaryOrLarge = false;
    if (Buffer.byteLength(oldContent, 'utf-8') > MAX_FILE_SIZE || Buffer.byteLength(newContent, 'utf-8') > MAX_FILE_SIZE) {
      binaryOrLarge = true;
    } else if (looksBinary(oldContent) || looksBinary(newContent)) {
      binaryOrLarge = true;
    }

    files.push({
      path: c.newPath,
      status: c.status,
      oldContent: binaryOrLarge ? '' : oldContent,
      newContent: binaryOrLarge ? '' : newContent,
      ...(binaryOrLarge ? { binaryOrLarge: true } : {})
    });
  }

  res.json({
    hash,
    short: metaParts[0],
    author: metaParts[1],
    email: metaParts[2],
    date: metaParts[3],
    subject: metaParts.slice(4).join('\0'),
    files,
    truncated
  });
});

// API endpoint: stage and commit changes. With no `files` list everything
// under the directory is staged (git add -A); otherwise only the listed files.
app.post('/api/git/commit', async (req, res) => {
  const body = req.body ?? {};
  const rawPath = body.path;
  const message = typeof body.message === 'string' ? body.message : '';
  if (Object.hasOwn(body, 'files') && !Array.isArray(body.files)) {
    return res.status(400).json({ error: 'files must be an array' });
  }
  const files = Array.isArray(body.files) ? body.files : null;

  if (typeof rawPath !== 'string' || !rawPath) {
    return res.status(400).json({ error: 'Body must include a path string' });
  }
  const trimmedMsg = message.trim();
  if (!trimmedMsg) {
    return res.status(400).json({ error: 'Commit message is required' });
  }
  if (message.includes('\0') || trimmedMsg.length > GIT_MAX_MESSAGE_LEN) {
    return res.status(400).json({ error: `Commit message too long (max ${GIT_MAX_MESSAGE_LEN} chars)` });
  }

  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);

  try {
    let addArgs;
    if (files) {
      if (files.length === 0 || files.length > GIT_MAX_COMMIT_FILES) {
        return res.status(400).json({ error: `files must contain 1..${GIT_MAX_COMMIT_FILES} entries` });
      }
      const specs = [];
      for (const f of files) {
        if (typeof f !== 'string' || !f || f.includes('\0')) {
          return res.status(400).json({ error: 'Invalid file entry in files list' });
        }
        const absF = path.resolve(dir, f);
        if (!withinAnyRoot(absF)) {
          return res.status(403).json({ error: 'Access denied: path outside allowed directory' });
        }
        const spec = `:(literal)${f}`;
        try {
          fs.lstatSync(absF);
          specs.push(spec);
        } catch (err) {
          if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
            return res.status(400).json({ error: 'Could not inspect selected file' });
          }
          // A previously staged deletion or rename is absent from the index.
          // Keep it in the commit pathspec, but do not pass it to git add.
          const tracked = await runGit(dir, ['ls-files', '--error-unmatch', '--', spec]);
          if (tracked.error || tracked.timedOut || ![0, 1].includes(tracked.exitCode)) {
            return res.status(500).json({ error: 'Failed to check selected file' });
          }
          if (tracked.exitCode === 0) specs.push(spec);
        }
      }
      addArgs = specs.length ? ['add', '--', ...specs] : null;
    } else {
      addArgs = ['add', '-A'];
    }

    if (addArgs) {
      const addRes = await runGit(dir, addArgs);
      if (addRes.error === 'enoent') {
        return res.status(503).json({ error: 'git executable not found in PATH' });
      }
      if (addRes.error || addRes.timedOut || addRes.exitCode !== 0) {
        const details = ((addRes.stdout || '') + (addRes.stderr ? `\n${addRes.stderr}` : '')).trim().slice(0, 2000);
        return res.status(400).json({ error: 'git add failed', details });
      }
    }

    // --quiet exits 1 when the index differs from HEAD (works on unborn HEAD too)
    const fileSpecs = files ? files.map(file => `:(literal)${file}`) : [];
    const quietRes = await runGit(dir, ['diff', '--cached', '--quiet', ...(files ? ['--', ...fileSpecs] : [])]);
    if (quietRes.error || quietRes.timedOut || ![0, 1].includes(quietRes.exitCode)) {
      return res.status(500).json({ error: 'Failed to check staged changes' });
    }
    if (quietRes.exitCode === 0) {
      return res.json({ committed: false, reason: 'nothing to commit' });
    }

    const commitRes = await runGit(dir, ['commit', '-m', trimmedMsg, ...(files ? ['--only', '--', ...fileSpecs] : [])]);
    if (commitRes.error || commitRes.timedOut || commitRes.exitCode !== 0) {
      const details = ((commitRes.stdout || '') + (commitRes.stderr ? `\n${commitRes.stderr}` : '')).trim().slice(0, 2000);
      return res.status(500).json({ error: 'git commit failed', details });
    }

    const hashRes = await runGit(dir, ['rev-parse', '--short', 'HEAD']);
    const hash = !hashRes.error && hashRes.exitCode === 0 ? (hashRes.stdout || '').trim().split('\n')[0] : null;
    res.json({ committed: true, hash, message: trimmedMsg });
  } finally {
    gitBusy.delete(dir);
  }
});

// Shared guard for the mutating endpoints below: resolve a directory path that
// must exist and be inside an allowed root. Returns the real dir on success or
// null after sending the appropriate error response (400/403/404/500).
function resolveRepoDir(req, res) {
  const rawPath = typeof req.body === 'object' && req.body !== null ? req.body.path : req.query.path;
  if (!rawPath || typeof rawPath !== 'string') {
    res.status(400).json({ error: 'Body must include a path string' });
    return null;
  }
  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return null;
  const dir = resolved.path;
  try {
    if (!fs.statSync(dir).isDirectory()) {
      res.status(400).json({ error: 'Path must be a directory' });
      return null;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to stat directory', details: err.message });
    return null;
  }
  return dir;
}

// Combine stdout+stderr into a trimmed, length-capped diagnostic string.
function gitOutput(result) {
  return ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim().slice(0, 2000);
}

// API endpoint: current branch and the list of local branches for a directory.
// Non-repo paths get { isRepo:false } so the UI can offer "initialize" instead.
app.get('/api/git/branches', async (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }
  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  const [curRes, listRes] = await Promise.all([
    runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(dir, ['for-each-ref', 'refs/heads/', '--format=%(refname:short)']),
  ]);
  if (curRes.error === 'enoent' || listRes.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (curRes.error || listRes.error) {
    return res.status(500).json({ error: 'Failed to run git', details: curRes.error || listRes.error });
  }
  // Non-repo: rev-parse --abbrev-ref HEAD exits non-zero.
  if (curRes.timedOut || curRes.exitCode !== 0) {
    return res.json({ isRepo: false, current: null, branches: [] });
  }
  const rawCurrent = (curRes.stdout || '').trim().split('\n')[0].trim();
  const current = rawCurrent === 'HEAD' ? null : rawCurrent; // detached HEAD -> null
  const branches = [];
  for (const line of String(listRes.stdout).split('\n')) {
    const name = line.trim();
    if (!name) continue;
    if (branches.length >= GIT_MAX_BRANCHES) break;
    branches.push(name);
  }
  res.json({ isRepo: true, current, branches });
});

// API endpoint: configured remotes for a directory, with platform detection and
// a derived "open in browser" web URL (GitHub / GitLab / self-hosted).
app.get('/api/git/remotes', async (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(400).json({ error: 'Path parameter required' });
  }
  const resolved = resolveSafe(rawPath);
  if (!respondResolve(res, resolved)) return;
  const dir = resolved.path;

  try {
    if (!fs.statSync(dir).isDirectory()) {
      return res.status(400).json({ error: 'Path must be a directory' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to stat directory', details: err.message });
  }

  const result = await runGit(dir, ['remote', '-v']);
  if (result.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (result.error) {
    return res.status(500).json({ error: 'Failed to run git', details: result.error });
  }
  if (result.timedOut || result.exitCode !== 0) {
    return res.json({ isRepo: false, remotes: [] });
  }

  // `git remote -v` lines look like "<name>\t<url> (fetch|push)". Dedupe by name.
  const seen = new Map();
  for (const line of String(result.stdout).split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)/);
    if (!m) continue;
    const [, name, url] = m;
    if (!seen.has(name)) {
      seen.set(name, { name, url, platform: detectPlatform(url), webUrl: repoWebUrl(url) });
    }
  }
  res.json({ isRepo: true, remotes: [...seen.values()] });
});

// API endpoint: create a new branch. With switch:true it also checks the new
// branch out (git checkout -b); otherwise it only creates it (git branch).
app.post('/api/git/branch', async (req, res) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : null;
  const switchTo = Boolean(body.switch);

  if (!isValidRefName(name)) {
    return res.status(400).json({ error: 'Invalid branch name (letters, digits, . _ / -; no leading dash)' });
  }
  if (from !== null && !isValidRefName(from)) {
    return res.status(400).json({ error: 'Invalid start point ref' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const args = switchTo ? ['checkout', '-b', name] : ['branch', name];
    if (from) args.push(from);
    const result = await runGit(dir, args);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut || result.exitCode !== 0) {
      return res.status(400).json({ error: 'Failed to create branch', details: gitOutput(result) });
    }
    res.json({ created: name, switched: switchTo });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: switch to an existing branch (or detach at a ref).
app.post('/api/git/checkout', async (req, res) => {
  const body = req.body ?? {};
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!isValidRefName(ref)) {
    return res.status(400).json({ error: 'Invalid branch or ref name' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const result = await runGit(dir, ['checkout', ref]);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut || result.exitCode !== 0) {
      return res.status(400).json({ error: 'Checkout failed', details: gitOutput(result) });
    }
    res.json({ checkedOut: ref });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: merge a branch into the current one. A conflicted merge exits
// non-zero; we return it as 200 with conflicted:true so the UI can show the
// conflicts (resolve in the editor, then commit to finish).
app.post('/api/git/merge', async (req, res) => {
  const body = req.body ?? {};
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  if (!isValidRefName(branch)) {
    return res.status(400).json({ error: 'Invalid branch name to merge' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const result = await runGit(dir, ['merge', branch]);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut) {
      return res.status(result.timedOut ? 504 : 500).json({ error: 'Failed to run git merge', details: gitOutput(result) });
    }
    const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
    if (result.exitCode === 0) {
      return res.json({ merged: true, conflicted: false, branch, output });
    }
    // Non-zero exit means the merge stopped (conflicts or error); surface it.
    const conflicted = result.exitCode === 1;
    return res.json({
      merged: false,
      conflicted,
      branch,
      output,
      ...(conflicted ? { hint: 'Resolve the conflicts in the editor, then commit to finish the merge.' } : {}),
    });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: rebase the current branch onto another. A conflicted rebase
// stops with non-zero; we return 200 with conflicted:true and the UI offers
// continue/skip/abort via /api/git/rebase-step.
app.post('/api/git/rebase', async (req, res) => {
  const body = req.body ?? {};
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  if (!isValidRefName(branch)) {
    return res.status(400).json({ error: 'Invalid branch name to rebase onto' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const result = await runGit(dir, ['rebase', branch]);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut) {
      return res.status(result.timedOut ? 504 : 500).json({ error: 'Failed to run git rebase', details: gitOutput(result) });
    }
    const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
    if (result.exitCode === 0) {
      return res.json({ rebased: true, conflicted: false, branch, output });
    }
    return res.json({
      rebased: false,
      conflicted: true,
      branch,
      output,
      hint: 'Resolve the conflicts in the editor, then continue or abort the rebase.',
    });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: advance a stopped rebase. action is one of abort | continue | skip.
app.post('/api/git/rebase-step', async (req, res) => {
  const body = req.body ?? {};
  const action = typeof body.action === 'string' ? body.action : '';
  if (!['abort', 'continue', 'skip'].includes(action)) {
    return res.status(400).json({ error: "Action must be one of 'abort', 'continue', 'skip'" });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const result = await runGit(dir, ['rebase', `--${action}`]);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut) {
      return res.status(result.timedOut ? 504 : 500).json({ error: `Failed to run git rebase --${action}`, details: gitOutput(result) });
    }
    const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
    // continue can stop again at the next conflict; report done:false in that case.
    res.json({ action, done: result.exitCode === 0, output });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: status of the git credential subset of the global encrypted
// store — which providers are configured and whether it is unlocked. Never
// returns credential values; management reuses /api/cloud/credentials.
app.get('/api/git/credentials', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fileObj = readCredFile();
  const payload = credUnlockEntry();
  const all = payload !== null ? Object.keys(payload) : fileObj !== null && Array.isArray(fileObj.meta?.providers) ? fileObj.meta.providers : [];
  // Non-secret identifiers only (username/host/token presence) — safe to expose
  // while locked; lets the UI show what is stored across restarts.
  const gitMeta = payload !== null ? gitCredentialMetadata(payload) : fileObj !== null && isPlainObject(fileObj.meta?.git) ? fileObj.meta.git : {};
  const unlocked = payload !== null;
  res.json({
    exists: fileObj !== null,
    providers: all.filter(p => Object.hasOwn(GIT_CRED_PROVIDERS, p)),
    unlocked,
    ...(unlocked ? { unlockedUntil: credUnlockExpiry } : {}),
    stored: gitMeta,
  });
});

// API endpoint: verify GitHub/GitLab credentials against the provider's own
// user API (github.com/api/v3/user, gitlab.com/api/v4/user or a self-hosted
// instance). Inline values are used when given (test-before-save); otherwise
// the stored entry is required and the store must be unlocked.
app.post('/api/git/credentials/test', async (req, res) => {
  const body = req.body ?? {};
  const provider = typeof body.provider === 'string' ? body.provider : '';
  if (!Object.hasOwn(GIT_CRED_PROVIDERS, provider)) {
    return res.status(400).json({ error: `provider must be one of ${Object.keys(GIT_CRED_PROVIDERS).join(', ')}` });
  }

  let token = typeof body.token === 'string' ? body.token.trim() : '';
  const requestedHost = typeof body.host === 'string' ? body.host.trim() : '';
  let host = requestedHost ? normalizeGitHost(requestedHost) : '';
  if (requestedHost && host === null) return res.status(400).json({ error: 'Invalid instance host' });

  if (token === '') {
    const payload = credUnlockEntry();
    const stored = payload !== null ? payload[provider] : null;
    if (!stored || typeof stored.token !== 'string' || stored.token === '') {
      return res.status(401).json({ error: `No ${provider} credentials to test — fill in the form or unlock the store` });
    }
    token = stored.token;
    const storedHost = stored.host?.trim() ? normalizeGitHost(stored.host) : GIT_CRED_PROVIDERS[provider];
    if (storedHost === null) return res.status(400).json({ error: 'Invalid stored instance host' });
    if (host && host !== storedHost) return res.status(400).json({ error: 'Stored credentials can only be tested against their registered host' });
    host = storedHost;
  }

  const baseHost = host !== '' ? host : GIT_CRED_PROVIDERS[provider];
  // github.com's REST API lives on api.github.com — the /api/v3 path on the web
  // host answers 404 for everyone. Self-hosted GHE keeps /api/v3 on its own host.
  const url =
    provider === 'github'
      ? baseHost === 'github.com'
        ? 'https://api.github.com/user'
        : `https://${baseHost}/api/v3/user`
      : `https://${baseHost}/api/v4/user`;
  const headers =
    provider === 'github'
      ? { Authorization: `Bearer ${token}`, 'User-Agent': 'terracode', Accept: 'application/json' }
      : { 'PRIVATE-TOKEN': token, Accept: 'application/json' };

  let upstream;
  try {
    upstream = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(GIT_CRED_TEST_TIMEOUT_MS) });
  } catch (err) {
    return res.status(502).json({ error: `Connection to ${baseHost} failed: ${err.message}` });
  }
  if (!upstream.ok) {
    const hint =
      provider === 'github'
        ? ' With 2FA enabled, account passwords never work over HTTPS — use a personal access token.'
        : '';
    return res.status(401).json({ error: `Authentication rejected by ${provider === 'github' ? 'GitHub' : 'GitLab'} (HTTP ${upstream.status}).${hint}` });
  }
  const data = await upstream.json().catch(() => null);
  const identity = isPlainObject(data) ? String(data.login || data.username || '') : '';
  res.json({ ok: true, provider, host: baseHost, identity: identity !== '' ? identity : 'authenticated' });
});

// API endpoint: initialize a repository in a folder (for imported/empty folders
// with no .git) and optionally add an `origin` remote so the user can push to a
// new GitHub/GitLab repo. Refuses if the path is already inside a work tree.
app.post('/api/git/init', async (req, res) => {
  const body = req.body ?? {};
  const remoteUrl = typeof body.remoteUrl === 'string' ? body.remoteUrl.trim() : '';
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : null;

  if (remoteUrl !== '' && !isValidRemoteUrl(remoteUrl)) {
    return res.status(400).json({ error: 'Invalid remote URL (use an https/ssh/git URL, user@host:path, or a local path)' });
  }
  if (branch !== null && !isValidRefName(branch)) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  // Already a repository? Report it instead of re-initializing.
  const probe = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  if (probe.error === 'enoent') {
    return res.status(503).json({ error: 'git executable not found in PATH' });
  }
  if (!probe.error && !probe.timedOut && probe.exitCode === 0 && (probe.stdout || '').trim() === 'true') {
    return res.status(409).json({ error: 'Path is already a git repository', initialized: false });
  }

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const initArgs = ['init'];
    if (branch) initArgs.push('-b', branch);
    const initRes = await runGit(dir, initArgs);
    if (initRes.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (initRes.error || initRes.timedOut || initRes.exitCode !== 0) {
      return res.status(400).json({ error: 'git init failed', details: gitOutput(initRes) });
    }

    let remoteAdded = false;
    if (remoteUrl !== '') {
      const addRes = await runGit(dir, ['remote', 'add', 'origin', remoteUrl]);
      if (addRes.error || addRes.timedOut || addRes.exitCode !== 0) {
        return res.status(400).json({ error: 'Failed to add remote origin', details: gitOutput(addRes) });
      }
      remoteAdded = true;
    }

    res.json({
      initialized: true,
      path: dir,
      branch: branch ?? null,
      remoteUrl: remoteUrl !== '' ? remoteUrl : null,
      remoteAdded,
    });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: push the current (or named) branch to origin. Network op with a
// longer timeout; failures (auth, rejection) come back as 200 with success:false
// and the full git output so the UI can show why it failed.
app.post('/api/git/push', async (req, res) => {
  const body = req.body ?? {};
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : null;
  const setUpstream = body.setUpstream !== false; // default true

  if (branch !== null && !isValidRefName(branch)) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    let pushBranch = branch;
    if (pushBranch === null) {
      // `git push -u origin` without a refspec fails on branches that have no
      // upstream yet ("The current branch X has no upstream branch"): with only
      // a remote name, push.default=simple needs an existing tracking config to
      // infer the refspec. Passing the current branch explicitly pushes new
      // branches and sets their upstream in one step. Detached HEAD reports
      // "HEAD" — keep the legacy behavior there (no meaningful branch name).
      const curRes = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (curRes.error === 'enoent') {
        return res.status(503).json({ error: 'git executable not found in PATH' });
      }
      const current = !curRes.error && !curRes.timedOut && curRes.exitCode === 0 ? (curRes.stdout || '').trim().split('\n')[0] : '';
      if (current !== '' && current !== 'HEAD') pushBranch = current;
    }

    const args = ['push'];
    if (setUpstream) args.push('-u');
    args.push('origin');
    if (pushBranch) args.push(pushBranch);
    const result = await runGitNetwork(dir, args, GIT_NETWORK_TIMEOUT_MS);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut) {
      return res.status(result.timedOut ? 504 : 500).json({ error: 'git push failed', details: gitOutput(result), timedOut: Boolean(result.timedOut) });
    }
    const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
    res.json({ success: result.exitCode === 0, branch: pushBranch ?? undefined, output });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: pull from origin (current or named branch). A conflicted pull
// comes back as 200 with conflicted:true so the UI can surface it.
app.post('/api/git/pull', async (req, res) => {
  const body = req.body ?? {};
  const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : null;

  if (branch !== null && !isValidRefName(branch)) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const args = ['pull'];
    if (branch) args.push('origin', branch);
    const result = await runGitNetwork(dir, args, GIT_NETWORK_TIMEOUT_MS);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut) {
      return res.status(result.timedOut ? 504 : 500).json({ error: 'git pull failed', details: gitOutput(result), timedOut: Boolean(result.timedOut) });
    }
    const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
    if (result.exitCode === 0) {
      return res.json({ success: true, conflicted: false, branch: branch ?? undefined, output });
    }
    const conflicted = /conflict/i.test(output);
    res.json({ success: false, conflicted, branch: branch ?? undefined, output });
  } finally {
    gitBusy.delete(dir);
  }
});

// API endpoint: fetch all remotes (updates remote-tracking refs; read-only with
// respect to the work tree). Useful before listing branches or pulling.
app.post('/api/git/fetch', async (req, res) => {
  const dir = resolveRepoDir(req, res);
  if (!dir) return;

  const busy = projectBusyError(dir);
  if (busy) {
    return res.status(409).json({ error: busy });
  }
  gitBusy.add(dir);
  try {
    const result = await runGitNetwork(dir, ['fetch', '--all'], GIT_NETWORK_TIMEOUT_MS);
    if (result.error === 'enoent') {
      return res.status(503).json({ error: 'git executable not found in PATH' });
    }
    if (result.error || result.timedOut) {
      return res.status(result.timedOut ? 504 : 500).json({ error: 'git fetch failed', details: gitOutput(result), timedOut: Boolean(result.timedOut) });
    }
    const output = ((result.stdout || '') + (result.stderr ? `\n${result.stderr}` : '')).trim();
    res.json({ success: result.exitCode === 0, output });
  } finally {
    gitBusy.delete(dir);
  }
});

// --- File watching & live events -------------------------------------------
// Watch all allowed roots with chokidar and push change notifications to
// connected clients over Server-Sent Events (GET /api/events). The UI uses the
// stream to refresh the tree when files are rewritten externally (e.g. by
// terraform fmt or another editor) and to reload an open file that changed on
// disk. WATCH_FILES=0 disables watching; FS_DEBOUNCE_MS tunes the batch window.

const FS_DEBOUNCE_MS = Number(process.env.FS_DEBOUNCE_MS) || 200; // batch window for fs-change events
const SSE_HEARTBEAT_MS = 25_000; // keep-alive comment so dead links are noticed
const SELF_WRITE_SUPPRESS_MS = 3000; // ignore watcher events caused by our own writes

// Directories/files the watcher should never report: VCS metadata, terraform's
// provider cache, dependency trees, and this server's atomic-write temp files.
const WATCH_IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])\.terraform([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /\.tmp-\d+-\d+$/,
];

const sseClients = new Set(); // active /api/events responses
let fileWatcher = null; // chokidar instance (null when watching is off)
const selfWrites = new Map(); // real path -> timestamp of a write made by this server

// Remember that the server itself wrote/created/moved/deleted `p`, so watcher
// events for it (and, on prefix match, everything under it) are not echoed back.
function markSelfWrite(p) {
  const now = Date.now();
  selfWrites.set(p, now);
  if (selfWrites.size > 256) {
    for (const [k, t] of selfWrites) {
      if (now - t > SELF_WRITE_SUPPRESS_MS) selfWrites.delete(k);
    }
  }
}

function isSelfWrite(p) {
  const now = Date.now();
  for (const [k, t] of selfWrites) {
    if (now - t > SELF_WRITE_SUPPRESS_MS) continue;
    if (p === k || p.startsWith(k + path.sep)) return true;
  }
  return false;
}

function broadcast(payload) {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      // dead socket; its 'close' handler removes it from the set
    }
  }
}

// Coalesce watcher events: collect changed paths and flush them as one batched
// fs-change event after a quiet window, so a burst (e.g. terraform fmt over many
// files) costs the UI a single refresh instead of N.
const pendingFsChanges = new Set(); // real paths waiting for the next flush
let fsFlushTimer = null;

function scheduleFsChange(p) {
  if (isSelfWrite(p)) return;
  pendingFsChanges.add(p);
  if (fsFlushTimer !== null) return;
  fsFlushTimer = setTimeout(() => {
    fsFlushTimer = null;
    const paths = [...pendingFsChanges];
    pendingFsChanges.clear();
    broadcast({ type: 'fs-change', paths });
  }, FS_DEBOUNCE_MS);
}

// API endpoint: Server-Sent Events stream of file-system change notifications.
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"hello"}\n\n'); // initial message confirms the stream is live
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': hb\n');
    } catch {
      // connection already closed; 'close' handler cleans up below
    }
  }, SSE_HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Start (or restart) the chokidar watcher on the given roots, or on all allowed
// roots when omitted. Returns the watcher, or null when watching is disabled.
function startFileWatcher(roots) {
  stopFileWatcher();
  if (process.env.WATCH_FILES === '0') return null;
  const targets = (roots && roots.length ? roots : allRoots()).filter(p => {
    try {
      fs.statSync(p);
      return true;
    } catch {
      return false; // root does not exist yet; it can be added later via .add()
    }
  });
  fileWatcher = chokidar.watch(targets, {
    ignored: WATCH_IGNORED,
    ignoreInitial: true,
    persistent: true,
    // Never follow symlinks out of the allowed roots (same rule as resolveSafe):
    // only the links themselves are watched, never their targets.
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  const onEvent = p => scheduleFsChange(p);
  fileWatcher
    .on('add', onEvent)
    .on('change', onEvent)
    .on('unlink', onEvent)
    .on('addDir', onEvent)
    .on('unlinkDir', onEvent);
  return fileWatcher;
}

function stopFileWatcher() {
  if (fileWatcher !== null) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

// Start server (localhost only by default; set HOST to override).
// Export the app so tests can drive it via supertest without binding a port.
if (require.main === module) {
  startFileWatcher();
  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`Allowed roots: ${allRoots().join(', ')}`);
    if (fileWatcher !== null) console.log('File watching enabled (SSE at /api/events)');
  });
}

module.exports = app;
module.exports.startFileWatcher = startFileWatcher;
module.exports.stopFileWatcher = stopFileWatcher;
