const assert = require('assert');
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
  console.log(`PASS git setup detection · ${status.installed ? status.version : status.installMethod}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
