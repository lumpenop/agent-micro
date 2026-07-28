const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const { findCodexNative } = require('../src/providers/codex-bridge');

(async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'intentional Agent Micro compatibility probe' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const bin = findCodexNative();
  assert.ok(bin, 'Codex CLI binary not found');

  const args = [
    '-c', 'model_provider="agent-micro-probe"',
    '-c', 'model="agent-micro-probe-model"',
    '-c', 'model_providers.agent-micro-probe.name="Agent Micro Probe"',
    '-c', `model_providers.agent-micro-probe.base_url="http://127.0.0.1:${port}/v1"`,
    '-c', 'model_providers.agent-micro-probe.wire_api="responses"',
    '-c', 'model_providers.agent-micro-probe.request_max_retries=0',
    '-c', 'model_providers.agent-micro-probe.stream_max_retries=0',
    'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    'Reply with ok.',
  ];
  const command = typeof bin === 'object' ? process.execPath : bin;
  const commandArgs = typeof bin === 'object' ? [bin.path, ...args] : args;
  const env = {
    ...process.env,
    ...(typeof bin === 'object' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  const child = spawn(command, commandArgs, { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Codex provider probe timed out'));
    }, 20000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  await new Promise((resolve) => server.close(resolve));

  const responseRequest = requests.find((request) => request.method === 'POST' && /\/v1\/responses(?:\?|$)/.test(request.url));
  assert.ok(responseRequest, `Codex did not call the Responses endpoint; requests=${JSON.stringify(requests)}`);
  const payload = JSON.parse(responseRequest.body);
  assert.equal(payload.model, 'agent-micro-probe-model');
  assert.notEqual(exitCode, 0, 'intentional 400 probe should not succeed');
  assert.match(output, /intentional Agent Micro compatibility probe|400 Bad Request/);
  process.stdout.write('live Codex custom-provider route reached POST /v1/responses: ok\n');
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
