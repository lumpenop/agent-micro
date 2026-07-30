const assert = require('assert');
const fs = require('fs');
const path = require('path');
const gitSetup = require('../src/git-setup');

(async () => {
  const status = await gitSetup.detectGit();
  assert.equal(status.ok, true);
  assert.equal(typeof status.installed, 'boolean');
  assert.ok(['ready', 'homebrew', 'xcode', 'manual'].includes(status.installMethod));
  if (status.installed) {
    assert.ok(status.path);
    assert.match(status.version, /git version/i);
  }
  const github = await gitSetup.detectGitHub();
  assert.equal(github.ok, true);
  assert.equal(typeof github.connected, 'boolean');
  assert.equal(typeof github.clientInstalled, 'boolean');
  if (github.connected) {
    assert.equal(github.clientInstalled, true);
    assert.ok(github.path);
  }
  const sourceRoot = path.join(__dirname, '..', 'src');
  const html = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(sourceRoot, 'app.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(sourceRoot, 'preload.js'), 'utf8');
  assert.match(html, /id="onboarding-step-github"/);
  assert.match(html, /data-i18n="onboarding\.optional"/);
  assert.ok(!html.includes('id="onboarding-step-git"'), 'first-run flow must check GitHub, not local Git installation');
  assert.match(renderer, /getGitHubStatus/);
  assert.match(renderer, /connectGitHub/);
  assert.match(preload, /github:status/);
  assert.match(preload, /github:connect/);
  console.log(`PASS Git + optional GitHub detection · Git ${status.installed ? 'ready' : status.installMethod} · GitHub ${github.connected ? `@${github.account || 'connected'}` : 'optional'}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
