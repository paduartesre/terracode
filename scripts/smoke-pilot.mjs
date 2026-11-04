import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const terraform = process.env.PILOT_TEST_TERRAFORM;
if (!terraform || !path.isAbsolute(terraform)) throw new Error('Set PILOT_TEST_TERRAFORM to a real Terraform executable (>=1.4).');
const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
assert.ok(git, 'Git must be installed');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'terracode-pilot-smoke-'));
const bin = path.join(sandbox, 'bin');
const project = path.join(sandbox, 'project');
await fs.mkdir(bin);
await fs.mkdir(project);
await fs.symlink(terraform, path.join(bin, 'terraform'));
await fs.symlink(git, path.join(bin, 'git'));
// Only the executable is copied: no source, dist, package.json or node_modules.
const executable = path.join(sandbox, 'terracode');
await fs.copyFile(path.join(root, 'release/terracode-pilot-linux-x64/terracode'), executable);
await fs.chmod(executable, 0o755);
await fs.copyFile(path.join(root, 'examples/local-demo/main.tf'), path.join(project, 'main.tf'));
const env = { ...process.env, HOME: sandbox, PATH: bin, NODE_PATH: '', NODE_OPTIONS: '', TFENV_DISABLE: '1', TF_CODE_CRED_DIR: path.join(sandbox, 'credentials'), CLOUD_CLI_EXTRA_PATH: '' };
assert.notEqual(spawnSync('node', ['--version'], { env }).status, 0, 'Node must not be available on the test PATH');
assert.equal(spawnSync(executable, ['--help'], { cwd: sandbox, env }).status, 0);
const invalidProject = spawnSync(executable, ['--project', path.join(sandbox, 'missing')], { cwd: sandbox, env, encoding: 'utf8' });
assert.equal(invalidProject.status, 1);
assert.match(invalidProject.stderr, /could not start/);
assert.ok(invalidProject.stderr.length < 2000, 'Startup errors should not dump the bytecode dummy source');
assert.equal(spawnSync(git, ['init', '-q', project], { env }).status, 0);
let logs = '';
const child = spawn(executable, ['--project', project], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
const exited = once(child, 'exit');
let failures;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Startup timeout: ' + logs)), 15000);
    const ready = data => {
      if (!logs.includes('TerraCode pilot:')) return;
      clearTimeout(timeout);
      child.stdout.off('data', ready);
      resolve();
    };
    child.stdout.on('data', ready);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Exited ${code}: ${logs}`)); });
  });
  async function api(url, body, status = 200) {
    const res = await fetch('http://127.0.0.1:3001' + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    assert.equal(res.status, status, JSON.stringify(data));
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    return data;
  }
  const page = await fetch('http://127.0.0.1:5173/');
  assert.equal(page.status, 200);
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch('http://127.0.0.1:5173' + asset)).status, 200);
  assert.equal((await fetch('http://127.0.0.1:5173' + asset + '.map')).status, 404);
  assert.equal((await fetch('http://127.0.0.1:5173/server.cjs')).status, 404);
  assert.deepEqual((await api('/api/roots')).roots, [project]);
  assert.ok((await api('/api/files?path=' + encodeURIComponent(project))).some(entry => entry.name === 'main.tf'));
  const fileUrl = '/api/file-content?path=' + encodeURIComponent(path.join(project, 'main.tf'));
  const file = await api(fileUrl);
  const write = await fetch('http://127.0.0.1:3001/api/file-content', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file.path, content: file.content + '\n# usability pilot\n', mtimeMs: file.mtimeMs }) });
  assert.equal(write.status, 200);
  await api('/api/file-content?path=' + encodeURIComponent('/etc/passwd'), undefined, 403);
  assert.equal((await api('/api/git/status?path=' + encodeURIComponent(project))).isRepo, true);
  for (const [key, value] of [['user.name', 'Pilot smoke'], ['user.email', 'pilot@example.invalid']]) assert.equal(spawnSync(git, ['-C', project, 'config', key, value], { env }).status, 0);
  assert.equal((await api('/api/git/commit', { path: project, message: 'Pilot local demo' })).committed, true);
  const run = command => api('/api/tf/run', { command, path: project });
  for (const command of ['version', 'init', 'fmt']) assert.equal((await run(command)).exitCode, 0, command);
  assert.equal((await run('validate')).valid, true);
  assert.equal((await run('plan-file')).exitCode, 0);
  assert.match((await run('show-plan')).output, /terraform_data\.demo/);
  assert.equal((await run('apply')).exitCode, 0);
  assert.equal((await run('output')).outputs.demo_message.value, 'TerraCode local demo');
  assert.ok((await run('state-list')).addresses.includes('terraform_data.demo'));
  assert.equal((await run('plan-file-destroy')).exitCode, 0);
  assert.equal((await run('apply')).exitCode, 0);
  assert.deepEqual((await run('state-list')).addresses, []);
  const contender = spawn(executable, ['--project', project], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let contenderLogs = '';
  contender.stderr.on('data', data => { contenderLogs += data; });
  const [code] = await once(contender, 'exit');
  assert.equal(code, 1);
  assert.match(contenderLogs, /already in use/);
  console.log('PASS: isolated executable, frontend assets, no source/maps, file read/write, path denial, Git commit, real Terraform init/validate/plan/apply/outputs/state/destroy, port conflict.');
} catch (error) { failures = error; }
finally {
  child.kill('SIGTERM');
  const [code] = await exited;
  await fs.rm(sandbox, { recursive: true, force: true });
  if (failures) throw new Error(failures.message + '\nExecutable output:\n' + logs, { cause: failures });
  assert.equal(code, 0, 'Executable should stop cleanly');
}
