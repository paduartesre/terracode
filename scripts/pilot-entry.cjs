'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { getAsset, getAssetKeys } = require('node:sea');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('TerraCode Community Edition\nUsage: ./terracode [--project /absolute/project/path]\nOpen http://localhost:5173. Stop with Ctrl+C.\nRequires local Git/Terraform; no Node.js or npm needed.\nCopyright (c) 2026 Pedro Duarte. AGPL-3.0-only; see LICENSE and SOURCE.txt.');
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('TerraCode pilot ' + PILOT_SOURCE_COMMIT);
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--project')) {
  console.error('Unknown arguments. Use --help.');
  process.exit(1);
}

const selected = args[1] || process.env.BASE_DIR;
const root = path.resolve(selected || path.join(os.homedir(), '.terracode-pilot', 'workspace'));
if (!selected) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (!fs.statSync(root).isDirectory()) throw new Error('Project path must be a directory');
process.env.BASE_DIR = fs.realpathSync(root);
process.env.HOST = '127.0.0.1';
process.env.PORT = '3001';

const api = require('../server.cjs');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const assets = new Set(getAssetKeys());
const web = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost:5173').pathname); }
  catch { res.writeHead(400); return res.end(); }
  const key = 'web' + (pathname === '/' ? '/index.html' : pathname);
  if (!assets.has(key)) { res.writeHead(404); return res.end(); }
  const data = Buffer.from(getAsset(key));
  res.writeHead(200, {
    'Content-Type': mime[path.extname(key)] || 'application/octet-stream',
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': key.endsWith('index.html') ? 'no-store' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
});
const backend = http.createServer(api);
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  api.stopFileWatcher();
  web.close();
  backend.close();
  web.closeAllConnections();
  backend.closeAllConnections();
  process.exitCode = code;
}
for (const server of [web, backend]) server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port 5173 or 3001 is already in use. Stop the other instance and retry.' : error.message);
  stop(1);
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
backend.listen(3001, '127.0.0.1', () => {
  if (stopping) return backend.close();
  web.listen(5173, '127.0.0.1', () => {
    api.startFileWatcher();
    console.log('TerraCode pilot: http://localhost:5173');
    console.log('Project root: ' + process.env.BASE_DIR);
    console.log('Local execution only. Press Ctrl+C to stop.');
  });
});
