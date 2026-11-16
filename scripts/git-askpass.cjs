'use strict';

const net = require('node:net');

// Called only by Git's askpass process. The broker holds credentials in the
// server process; the Git process and its hooks receive no token in their env.
function runGitAskpass(prompt) {
  const port = Number(process.env.TERRACODE_GIT_PORT);
  const key = process.env.TERRACODE_GIT_KEY;
  if (!Number.isInteger(port) || port < 1 || !key || typeof prompt !== 'string') {
    process.exitCode = 1;
    return;
  }
  const socket = net.createConnection({ host: '127.0.0.1', port });
  let response = '';
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('connect', () => socket.write(JSON.stringify({ prompt, key }) + '\n'));
  socket.on('data', chunk => {
    response += chunk.toString();
    if (response.length > 4096) socket.destroy();
  });
  socket.on('end', () => {
    try {
      const result = JSON.parse(response);
      if (typeof result.value !== 'string' || result.value === '') throw new Error('No credential');
      process.stdout.write(result.value + '\n');
    } catch {
      process.exitCode = 1;
    }
  });
  socket.on('error', () => { process.exitCode = 1; });
  socket.on('timeout', () => { process.exitCode = 1; });
}

if (require.main === module) runGitAskpass(process.argv[2]);
module.exports = runGitAskpass;
