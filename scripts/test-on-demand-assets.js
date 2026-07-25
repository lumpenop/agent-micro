const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-micro-assets-test-'));
const fixtures = {};

function makePackage(provider, executableParts) {
  const root = path.join(temporary, `fixture-${provider}`);
  const packageRoot = path.join(root, 'package');
  const executable = path.join(packageRoot, ...executableParts);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(executable, 0o755);
  const archive = path.join(temporary, `${provider}.tgz`);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', root, 'package']);
  const bytes = fs.readFileSync(archive);
  fixtures[provider] = {
    archive,
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
  };
}

makePackage('codex', ['vendor', 'aarch64-apple-darwin', 'bin', 'codex']);

const server = http.createServer((request, response) => {
  const provider = 'codex';
  if (request.url.endsWith('.tgz')) {
    const data = fs.readFileSync(fixtures[provider].archive);
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    response.end(data);
    return;
  }
  const address = server.address();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ dist: {
    tarball: `http://127.0.0.1:${address.port}/${provider}.tgz`,
    integrity: fixtures[provider].integrity,
  } }));
});

server.listen(0, '127.0.0.1', async () => {
  try {
    process.env.AGENT_MICRO_TOOL_REGISTRY_URL = `http://127.0.0.1:${server.address().port}`;
    const installer = require('../src/tool-installer');
    const packageJson = require('../package.json');
    assert.equal(packageJson.devDependencies['@openai/codex'], installer.PINNED_VERSIONS.codex);
    installer.setUserDataPath(path.join(temporary, 'user-data'));
    for (const provider of ['codex']) {
      const first = await installer.install(provider);
      assert.equal(first.ok, true);
      assert.equal(first.downloaded, true);
      assert.ok(installer.findInstalled(provider));
      const second = await installer.install(provider);
      assert.equal(second.downloaded, false);
    }
    console.log('on-demand tool install and existing-install skip: ok');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
