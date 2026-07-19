const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const root = () => path.join(os.homedir(), '.codex', 'skills');

function parseSkill(text, fallback) {
  const front = String(text || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const meta = front?.[1] || '';
  const unquote = (value = '') => {
    const v = value.trim();
    if (v.startsWith('"')) { try { return JSON.parse(v); } catch {} }
    return v.replace(/^['"]|['"]$/g, '');
  };
  return {
    name: unquote(meta.match(/^name:\s*(.+)$/m)?.[1]) || fallback,
    description: unquote(meta.match(/^description:\s*(.+)$/m)?.[1]),
    instructions: front ? text.slice(front[0].length).trim() : '',
  };
}

function personalSkills() {
  const dir = root(); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => {
    const file = path.join(dir, entry.name, 'SKILL.md'); if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(path.join(dir, entry.name)); if (stat.isSymbolicLink()) return null;
    const parsed = parseSkill(fs.readFileSync(file, 'utf8'), entry.name);
    return { ...parsed, folder: entry.name, path: file };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function validate(input) {
  const name = String(input?.name || '').trim().toLowerCase();
  const description = String(input?.description || '').trim();
  const instructions = String(input?.instructions || '').trim();
  if (!NAME_RE.test(name) || name.length > 63) throw new Error('Skill name must use lowercase letters, digits, and hyphens');
  if (!description || description.length > 2000) throw new Error('Skill description is required (max 2000 characters)');
  if (!instructions || instructions.length > 100000) throw new Error('Skill instructions are required (max 100000 characters)');
  return { name, description, instructions };
}

function saveSkill(input) {
  const skill = validate(input); const dir = root(); fs.mkdirSync(dir, { recursive: true });
  const original = String(input?.originalName || '').trim();
  if (original && !NAME_RE.test(original)) throw new Error('Invalid original skill name');
  const source = original ? path.join(dir, original) : null;
  const dest = path.join(dir, skill.name);
  if (source && source !== dest) {
    if (!fs.existsSync(source)) throw new Error('Original skill no longer exists');
    if (fs.existsSync(dest)) throw new Error('A skill with that name already exists');
    fs.renameSync(source, dest);
  } else if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  if (fs.lstatSync(dest).isSymbolicLink()) throw new Error('Refusing to edit a linked skill folder');
  const markdown = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
  fs.writeFileSync(path.join(dest, 'SKILL.md'), markdown, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, skill: { ...skill, folder: skill.name, path: path.join(dest, 'SKILL.md') } };
}

function skillPath(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('Invalid skill name');
  const dest = path.join(root(), name);
  if (!fs.existsSync(path.join(dest, 'SKILL.md')) || fs.lstatSync(dest).isSymbolicLink()) throw new Error('Personal skill not found');
  return dest;
}

module.exports = { personalSkills, saveSkill, skillPath, parseSkill, validate };
