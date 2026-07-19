const fs = require('fs');
const path = require('path');

function has(cwd, name) { return fs.existsSync(path.join(cwd, name)); }
function read(cwd, name, limit = 262144) {
  try { return fs.readFileSync(path.join(cwd, name), 'utf8').slice(0, limit); } catch { return ''; }
}

function nodeCommand(cwd) {
  if (!has(cwd, 'package.json')) return null;
  let pkg;
  try { pkg = JSON.parse(read(cwd, 'package.json')); } catch { throw new Error('package.json is invalid'); }
  const script = ['dev', 'start', 'serve', 'preview'].find((name) => pkg?.scripts?.[name]);
  if (!script) return null;
  if (has(cwd, 'pnpm-lock.yaml')) return { kind: 'Node · pnpm', command: `pnpm ${script}` };
  if (has(cwd, 'yarn.lock')) return { kind: 'Node · Yarn', command: `yarn ${script}` };
  if (has(cwd, 'bun.lock') || has(cwd, 'bun.lockb')) return { kind: 'Node · Bun', command: `bun run ${script}` };
  return { kind: 'Node · npm', command: `npm run ${script}` };
}

function pythonCommand(cwd) {
  if (has(cwd, 'manage.py')) return { kind: 'Python · Django', command: 'python3 manage.py runserver' };
  const files = ['app.py', 'main.py', 'server.py'].filter((name) => has(cwd, name));
  const source = files.map((name) => read(cwd, name)).join('\n');
  const prefix = has(cwd, 'uv.lock') ? 'uv run ' : has(cwd, 'poetry.lock') ? 'poetry run ' : '';
  const entry = files.find((name) => /FastAPI\s*\(/.test(read(cwd, name)));
  if (entry) return { kind: 'Python · FastAPI', command: `${prefix}uvicorn ${path.basename(entry, '.py')}:app --reload` };
  const flaskEntry = files.find((name) => /Flask\s*\(/.test(read(cwd, name)));
  if (flaskEntry) return { kind: 'Python · Flask', command: `${prefix}flask --app ${flaskEntry} run --debug` };
  if ((has(cwd, 'pyproject.toml') || has(cwd, 'requirements.txt')) && source) {
    const entryFile = files[0];
    return { kind: 'Python', command: `${prefix}python3 ${entryFile}` };
  }
  return null;
}

function makeCommand(cwd) {
  const body = read(cwd, 'Makefile');
  if (!body) return null;
  const target = ['dev', 'serve', 'run', 'start'].find((name) => new RegExp(`^${name}:`, 'm').test(body));
  return target ? { kind: 'Make', command: `make ${target}` } : null;
}

function detectDevCommand(cwd) {
  const node = nodeCommand(cwd);
  if (node) return node;
  const python = pythonCommand(cwd);
  if (python) return python;
  const make = makeCommand(cwd);
  if (make) return make;
  if (has(cwd, 'compose.yaml') || has(cwd, 'compose.yml') || has(cwd, 'docker-compose.yml') || has(cwd, 'docker-compose.yaml')) return { kind: 'Docker Compose', command: 'docker compose up' };
  if (has(cwd, 'Cargo.toml')) return { kind: 'Rust · Cargo', command: 'cargo run' };
  if (has(cwd, 'go.mod')) return { kind: 'Go', command: 'go run .' };
  if (has(cwd, 'artisan')) return { kind: 'PHP · Laravel', command: 'php artisan serve' };
  if (has(cwd, 'Gemfile') && has(cwd, 'bin/rails')) return { kind: 'Ruby · Rails', command: 'bin/rails server' };
  if (has(cwd, 'gradlew')) return { kind: 'Java · Gradle', command: './gradlew bootRun' };
  if (has(cwd, 'pom.xml')) return { kind: 'Java · Maven', command: 'mvn spring-boot:run' };
  if (fs.readdirSync(cwd).some((name) => name.endsWith('.csproj') || name.endsWith('.sln'))) return { kind: '.NET', command: 'dotnet watch run' };
  if (has(cwd, 'Package.swift')) return { kind: 'Swift', command: 'swift run' };
  if (has(cwd, 'index.html')) return { kind: 'Static web', command: 'python3 -m http.server 8000' };
  throw new Error('No runnable development setup detected in this project');
}

module.exports = { detectDevCommand };
