import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const workspace = await mkdtemp(path.join(tmpdir(), 'terracode-integration-'));
const api = spawn(process.execPath, ['server.cjs'], {
  env: { ...process.env, BASE_DIR: workspace, TF_CODE_CRED_DIR: path.join(workspace, 'credentials'), WATCH_FILES: '0', TFENV_DISABLE: '1', HOST: '127.0.0.1', PORT: '3001' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let startupError;
let apiLog = '';
api.once('error', error => { startupError = error; });
api.stdout.on('data', data => { apiLog += data; });
api.stderr.on('data', data => { apiLog += data; });
const exited = once(api, 'exit');
try {
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (api.exitCode !== null || api.signalCode !== null) throw new Error('Test API exited: ' + apiLog);
    try {
      const response = await fetch('http://localhost:3001/api/roots', { signal: AbortSignal.timeout(500) });
      const data = await response.json();
      if (response.ok && data.roots?.length === 1 && data.roots[0] === workspace) { ready = true; break; }
    } catch { /* Wait only for this isolated API to become ready. */ }
    await delay(100);
  }
  if (!ready) throw new Error('The isolated test API did not start; port 3001 must be free. ' + apiLog);
  const tests = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.mts'], { stdio: 'inherit' });
  const [code] = await once(tests, 'exit');
  if (code !== 0) throw new Error('API integration tests failed (' + code + ')');
} finally {
  if (api.exitCode === null && api.signalCode === null) api.kill('SIGTERM');
  await Promise.race([exited, delay(5000).then(() => { if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL'); })]);
  await rm(workspace, { recursive: true, force: true });
}
