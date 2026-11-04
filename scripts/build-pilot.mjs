import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { inject } from 'postject';

const require = createRequire(import.meta.url);
const bytenode = require('bytenode');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This pilot build currently targets Linux x64 only. Build it on Linux x64.');
if (process.version !== 'v24.22.1') throw new Error('Use Node.js v24.22.1 to build this bytecode/runtime pair.');
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
};
const sourceCommit = process.env.PILOT_SOURCE_COMMIT || spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Set PILOT_SOURCE_COMMIT to the full source commit SHA.');
const sourceUrl = 'https://github.com/paduartesre/terracode/tree/' + sourceCommit;
const buildInstructionsUrl = 'https://github.com/paduartesre/terracode/blob/' + sourceCommit + '/docs/PILOT-BUILD.md';
const nodeLicensePath = process.env.NODE_LICENSE_FILE;
if (!nodeLicensePath) throw new Error('Set NODE_LICENSE_FILE to the matching Node.js distribution LICENSE file.');
const nodeLicense = await fs.readFile(nodeLicensePath, 'utf8');
if (!nodeLicense.includes('Node.js') || !nodeLicense.includes('Permission is hereby granted')) throw new Error('Invalid Node.js license file');
const staging = path.join(root, '.pilot-build');
const release = path.join(root, 'release', 'terracode-pilot-linux-x64');
await fs.rm(staging, { recursive: true, force: true });
await fs.rm(release, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
await fs.mkdir(release, { recursive: true });
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
// Vite's default is no source maps. Explicitly reject any accidental maps.
async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(e => e.isDirectory() ? walk(path.join(directory, e.name)) : [path.join(directory, e.name)]));
  return nested.flat();
}
const webFiles = await walk('dist');
if (webFiles.some(f => f.endsWith('.map'))) throw new Error('Source maps must not be distributed');
const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: true, sourcemap: false, legalComments: 'none', metafile: true };
const backend = await build({ ...common, entryPoints: ['scripts/pilot-entry.cjs'], outfile: '.pilot-build/application.cjs', external: ['fsevents'], define: { PILOT_SOURCE_COMMIT: JSON.stringify(sourceCommit) } });
await bytenode.compileFile({ filename: path.join(staging, 'application.cjs'), output: path.join(staging, 'application.jsc'), compileAsModule: true, sourceMap: false });
const loader = await build({ ...common, entryPoints: ['scripts/sea-bootstrap.cjs'], outfile: '.pilot-build/bootstrap.cjs', external: ['electron'] });
const assets = { 'application.jsc': path.join(staging, 'application.jsc') };
for (const file of webFiles) assets['web/' + path.relative('dist', file).split(path.sep).join('/')] = path.resolve(file);
const config = { main: path.join(staging, 'bootstrap.cjs'), output: path.join(staging, 'sea.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, execArgvExtension: 'none', assets };
await fs.writeFile(path.join(staging, 'sea.json'), JSON.stringify(config, null, 2));
run(process.execPath, ['--experimental-sea-config', path.join(staging, 'sea.json')]);
const executable = path.join(release, 'terracode');
await fs.copyFile(process.execPath, executable);
await inject(executable, 'NODE_SEA_BLOB', await fs.readFile(config.output), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
await fs.chmod(executable, 0o755);
// Preserve license notices for bundled dependencies, without application source.
const packages = new Map();
for (const file of [...Object.keys(backend.metafile.inputs), ...Object.keys(loader.metafile.inputs)]) {
  if (!file.includes('node_modules/')) continue;
  let directory = path.dirname(path.resolve(file));
  while (directory !== root && directory !== path.dirname(directory)) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.set(directory, pkg); break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
}
// React and other browser dependencies are included in the minified frontend.
for (const name of Object.keys(require('../package.json').dependencies)) {
  const directory = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  packages.set(directory, pkg);
}
for (const [directory, pkg] of packages) {
  for (const name of Object.keys(pkg.dependencies || {})) {
    let parent = directory;
    for (;;) {
      const candidate = path.join(parent, 'node_modules', name);
      try {
        const dependency = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
        packages.set(candidate, dependency);
        break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (parent === root) throw new Error('Missing dependency notice: ' + name);
      parent = path.dirname(parent);
    }
  }
}
let notices = 'THIRD-PARTY NOTICES\n\nNode.js v24.22.1 and its bundled components:\n\n' + nodeLicense;
for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  notices += `\n\n===== ${pkg.name} ${pkg.version} (${pkg.license || 'see notice'}) =====\n`;
  const licenseFiles = (await fs.readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  if (!licenseFiles.length) throw new Error('Missing license notice: ' + pkg.name);
  for (const file of licenseFiles) notices += '\n' + await fs.readFile(path.join(directory, file), 'utf8');
}
await fs.writeFile(path.join(release, 'THIRD-PARTY-NOTICES.txt'), notices);
await fs.copyFile('docs/PILOT-LEIA-ME.txt', path.join(release, 'LEIA-ME.txt'));
await fs.copyFile('docs/PILOT-README.txt', path.join(release, 'README.txt'));
await fs.copyFile('examples/local-demo/main.tf', path.join(release, 'demo.tf.example'));
await fs.copyFile('docs/PILOT-FEEDBACK.txt', path.join(release, 'FEEDBACK.txt'));
await fs.copyFile('LICENSE', path.join(release, 'LICENSE'));
await fs.writeFile(path.join(release, 'SOURCE.txt'), 'TerraCode\nCopyright (c) 2026 Pedro Duarte\nLicense: AGPL-3.0-only; see LICENSE.\nCorresponding source and build instructions:\n' + sourceUrl + '\n' + buildInstructionsUrl + '\nKeep this source version available with the executable release.\n');
const artifactHash = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
await fs.writeFile(path.join(release, 'BUILD-INFO.json'), JSON.stringify({ edition: 'community', license: 'AGPL-3.0-only', sourceUrl, buildInstructionsUrl, platform: 'linux-x64', sourceCommit, node: process.version, v8: process.versions.v8, executableSha256: artifactHash, backend: 'V8 bytecode', frontend: 'minified browser assets; no source maps' }, null, 2) + '\n');
await fs.writeFile(path.join(release, 'SHA256SUMS'), artifactHash + '  terracode\n');
const archive = release + '.tar.gz';
const shippedFiles = ['terracode', 'BUILD-INFO.json', 'FEEDBACK.txt', 'LEIA-ME.txt', 'README.txt', 'SHA256SUMS', 'THIRD-PARTY-NOTICES.txt', 'demo.tf.example', 'LICENSE', 'SOURCE.txt'];
run('tar', ['-czf', archive, '-C', path.dirname(release), ...shippedFiles.map(file => path.basename(release) + '/' + file)]);
console.log('Pilot package: ' + archive);
