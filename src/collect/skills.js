// Catálogo somente leitura de comandos `/` e skills locais (Claude, Codex, Antigravity e AI Workspace).
// Camada collect/.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILTIN_COMMANDS = [
  { cmd: '/plan', name: 'plan', description: 'Planejar passo a passo antes de implementar', source: 'builtin' },
  { cmd: '/compact', name: 'compact', description: 'Compactar contexto da conversa', source: 'builtin' },
  { cmd: '/review', name: 'review', description: 'Revisar alterações e buscar falhas/melhorias', source: 'builtin' },
  { cmd: '/test', name: 'test', description: 'Executar a suíte de testes e reportar falhas', source: 'builtin' },
];

function extractDescription(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').slice(0, 1000);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (fm) {
      const desc = /^\s*description:\s*["']?([^\r\n"']+)/m.exec(fm[1]);
      if (desc) return desc[1].trim().slice(0, 120);
    }
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('---') && !l.startsWith('#'));
    return line ? line.slice(0, 120) : '';
  } catch { return ''; }
}

function scanFlatMdDir(dir, source, out, seen) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
      const name = e.name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const cmd = `/${name}`;
      if (!name || seen.has(cmd)) continue;
      seen.add(cmd);
      out.push({ cmd, name, description: extractDescription(path.join(dir, e.name)), source });
    }
  } catch {}
}

function scanSkillFolders(dir, source, out, seen) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const skillFile = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const name = e.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const cmd = `/${name}`;
      if (!name || seen.has(cmd)) continue;
      seen.add(cmd);
      out.push({ cmd, name, description: extractDescription(skillFile), source });
    }
  } catch {}
}

function collectSkills({ workspaceRoot = '', cwd = '', home = os.homedir() } = {}) {
  const out = [];
  const seen = new Set();

  // 1. Skills/comandos do projeto atual
  if (cwd) {
    scanFlatMdDir(path.join(cwd, '.claude', 'commands'), 'projeto', out, seen);
    scanSkillFolders(path.join(cwd, '.claude', 'skills'), 'projeto', out, seen);
    scanSkillFolders(path.join(cwd, '.agents', 'skills'), 'projeto', out, seen);
  }
  // 2. Skills do AI Workspace
  if (workspaceRoot) {
    scanFlatMdDir(path.join(workspaceRoot, 'skills'), 'workspace', out, seen);
    scanSkillFolders(path.join(workspaceRoot, 'skills'), 'workspace', out, seen);
  }
  // 3. Skills/comandos globais das IAs
  scanFlatMdDir(path.join(home, '.claude', 'commands'), 'claude', out, seen);
  scanSkillFolders(path.join(home, '.claude', 'skills'), 'claude', out, seen);
  scanSkillFolders(path.join(home, '.codex', 'skills'), 'codex', out, seen);
  scanSkillFolders(path.join(home, '.gemini', 'config', 'skills'), 'antigravity', out, seen);

  // 4. Comandos úteis padrão
  for (const b of BUILTIN_COMMANDS) {
    if (!seen.has(b.cmd)) {
      seen.add(b.cmd);
      out.push(b);
    }
  }

  return out.slice(0, 60);
}

module.exports = { collectSkills };
