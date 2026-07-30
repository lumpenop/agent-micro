const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SAFE_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function run(file, args, { timeout = 10000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.output = String(stderr || stdout || error.message).trim();
        reject(error);
      } else {
        resolve(String(stdout || stderr || '').trim());
      }
    });
  });
}

function executableAt(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function candidatePaths(name) {
  const fromEnvironment = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name));
  return [...new Set([...SAFE_PATHS.map((directory) => path.join(directory, name)), ...fromEnvironment])];
}

async function findWorkingBinary(name, args = ['--version']) {
  for (const candidate of candidatePaths(name)) {
    if (!executableAt(candidate)) continue;
    try {
      const output = await run(candidate, args, { timeout: 8000 });
      return { path: candidate, output };
    } catch {
      // macOS can expose /usr/bin/git before Command Line Tools are ready.
    }
  }
  return null;
}

async function detectGit() {
  const git = await findWorkingBinary('git');
  const brew = process.platform === 'darwin' ? await findWorkingBinary('brew', ['--version']) : null;
  return {
    ok: true,
    installed: !!git,
    path: git?.path || '',
    version: git?.output || '',
    installMethod: git ? 'ready' : brew ? 'homebrew' : process.platform === 'darwin' ? 'xcode' : 'manual',
  };
}

async function installGit({ openExternal } = {}) {
  const current = await detectGit();
  if (current.installed) return current;

  if (process.platform === 'darwin' && current.installMethod === 'homebrew') {
    const brew = await findWorkingBinary('brew', ['--version']);
    if (!brew) return { ok: false, installed: false, error: 'Homebrew is unavailable' };
    try {
      await run(brew.path, ['install', 'git'], { timeout: 20 * 60 * 1000 });
      return await detectGit();
    } catch (error) {
      return { ok: false, installed: false, installMethod: 'homebrew', error: error.output || error.message };
    }
  }

  if (process.platform === 'darwin') {
    try {
      await run('/usr/bin/xcode-select', ['--install'], { timeout: 15000 });
      return {
        ok: true,
        installed: false,
        installMethod: 'xcode',
        launched: true,
      };
    } catch (error) {
      const message = String(error.output || error.message || '');
      if (/already installed|not currently available/i.test(message)) {
        await openExternal?.('https://git-scm.com/download/mac');
        return {
          ok: true,
          installed: false,
          installMethod: 'manual',
          launched: true,
        };
      }
      return { ok: false, installed: false, installMethod: 'xcode', error: message };
    }
  }

  await openExternal?.('https://git-scm.com/downloads');
  return { ok: true, installed: false, installMethod: 'manual', launched: true };
}

async function detectGitHub() {
  const git = await detectGit();
  const gh = await findWorkingBinary('gh', ['--version']);
  if (!gh) {
    return {
      ok: true,
      connected: false,
      clientInstalled: false,
      gitInstalled: git.installed,
      installMethod: process.platform === 'darwin' ? 'homebrew-or-manual' : 'manual',
    };
  }

  try {
    await run(gh.path, ['auth', 'status', '--hostname', 'github.com'], { timeout: 10000 });
    let account = '';
    try {
      account = await run(gh.path, ['api', 'user', '--jq', '.login'], { timeout: 10000 });
    } catch {
      // Authentication is valid even if account lookup is unavailable.
    }
    return {
      ok: true,
      connected: true,
      clientInstalled: true,
      gitInstalled: git.installed,
      path: gh.path,
      version: gh.output.split(/\r?\n/, 1)[0],
      account: account.trim(),
    };
  } catch (error) {
    return {
      ok: true,
      connected: false,
      clientInstalled: true,
      gitInstalled: git.installed,
      path: gh.path,
      version: gh.output.split(/\r?\n/, 1)[0],
      error: error.output || error.message,
    };
  }
}

async function connectGitHub({ openExternal } = {}) {
  const current = await detectGitHub();
  if (current.connected) return current;

  let gh = await findWorkingBinary('gh', ['--version']);
  if (!gh && process.platform === 'darwin') {
    const brew = await findWorkingBinary('brew', ['--version']);
    if (brew) {
      try {
        await run(brew.path, ['install', 'gh'], { timeout: 20 * 60 * 1000 });
        gh = await findWorkingBinary('gh', ['--version']);
      } catch (error) {
        return { ok: false, connected: false, error: error.output || error.message };
      }
    }
  }

  if (!gh) {
    await openExternal?.('https://cli.github.com/');
    return {
      ok: true,
      connected: false,
      clientInstalled: false,
      launched: true,
      installMethod: 'manual',
    };
  }

  try {
    await run(
      gh.path,
      ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--clipboard'],
      { timeout: 5 * 60 * 1000 }
    );
    return await detectGitHub();
  } catch (error) {
    const status = await detectGitHub();
    if (status.connected) return status;
    return {
      ...status,
      ok: false,
      error: error.output || error.message,
    };
  }
}

module.exports = { detectGit, installGit, detectGitHub, connectGitHub };
