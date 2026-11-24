// Leitura somente leitura da Base de Memória Compartilhada por projeto (camada collect/).
const fs = require('fs');
const path = require('path');
const { MEMORY_FILES, projectSlug, selectDeltaSessions } = require('../../core/memory');
const { hashContent } = require('../../infra/workspace-paths');

function resolveProjectMemoryDir({ workspaceRoot, project = '', cwd = '', mode = '' }) {
  const slug = projectSlug(project || cwd);
  const inRepoDir = cwd ? path.join(cwd, '.ai-memory') : '';
  const hubDir = path.join(workspaceRoot, 'memory', slug);

  if (mode === 'in-repo' && inRepoDir) return { dir: inRepoDir, mode: 'in-repo', slug };
  if (mode === 'workspace-hub') return { dir: hubDir, mode: 'workspace-hub', slug };
  if (inRepoDir && fs.existsSync(inRepoDir)) return { dir: inRepoDir, mode: 'in-repo', slug };
  return { dir: hubDir, mode: 'workspace-hub', slug };
}

function readTextSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function readDreamState(memDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(memDir, 'dream-state.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { lastDreamAt: 0, lastEngine: '', sessions: {} };
  } catch {
    return { lastDreamAt: 0, lastEngine: '', sessions: {} };
  }
}

function listEpisodicNotes(memDir) {
  const dir = path.join(memDir, 'sessions');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, 30);
  } catch { return []; }
}

function readProjectMemory({ workspaceRoot, project = '', cwd = '', mode = '', sessions = [] }) {
  const resolved = resolveProjectMemoryDir({ workspaceRoot, project, cwd, mode });
  const files = {};
  const hashes = {};
  let hasAny = false;
  for (const name of MEMORY_FILES) {
    const full = path.join(resolved.dir, name);
    const content = readTextSafe(full);
    if (content) hasAny = true;
    files[name] = content;
    hashes[name] = hashContent(content);
  }
  const dreamState = readDreamState(resolved.dir);
  const delta = selectDeltaSessions(sessions, dreamState, { project: project || resolved.slug, cwd });
  return {
    project: project || resolved.slug,
    slug: resolved.slug,
    cwd: cwd || '',
    mode: resolved.mode,
    dir: resolved.dir,
    hasMemory: hasAny,
    files,
    hashes,
    episodic: listEpisodicNotes(resolved.dir),
    lastDreamAt: dreamState.lastDreamAt || 0,
    lastEngine: dreamState.lastEngine || '',
    lastSummary: dreamState.lastSummary || '',
    lastUsage: dreamState.lastUsage || null,
    pendingCount: delta.length,
    pendingIds: delta.map((s) => s.id),
  };
}

function listAllProjectMemories({ workspaceRoot, sessions = [], workspaceEntities = [] }) {
  const map = new Map(); // slug -> { project, cwd }
  for (const e of workspaceEntities || []) {
    const slug = projectSlug(e.id || e.title);
    const firstBinding = Array.isArray(e.projectBindings) && e.projectBindings[0];
    if (!map.has(slug)) map.set(slug, { project: e.title || slug, cwd: firstBinding ? firstBinding.cwd : '' });
  }
  for (const s of sessions || []) {
    if (!s || s.subagent) continue;
    const label = s.project || s.cwd;
    if (!label) continue;
    const slug = projectSlug(label);
    const prev = map.get(slug);
    if (!prev) map.set(slug, { project: s.project || slug, cwd: s.cwd || '' });
    else if (!prev.cwd && s.cwd) prev.cwd = s.cwd;
  }
  const hubMemRoot = path.join(workspaceRoot, 'memory');
  try {
    for (const e of fs.readdirSync(hubMemRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const slug = projectSlug(e.name);
      if (!map.has(slug)) map.set(slug, { project: slug, cwd: '' });
    }
  } catch {}

  const out = [];
  for (const [slug, info] of map.entries()) {
    const mem = readProjectMemory({ workspaceRoot, project: info.project, cwd: info.cwd, sessions });
    out.push({
      slug,
      project: info.project,
      cwd: info.cwd,
      mode: mem.mode,
      hasMemory: mem.hasMemory,
      lastDreamAt: mem.lastDreamAt,
      lastEngine: mem.lastEngine,
      lastSummary: mem.lastSummary,
      pendingCount: mem.pendingCount,
    });
  }
  out.sort((a, b) => (b.pendingCount - a.pendingCount) || (b.lastDreamAt - a.lastDreamAt) || a.project.localeCompare(b.project));
  return out;
}

function toIsoTime(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return '';
}

// Combina sessões locais do coletor com sessões federadas dos peers presentes no snapshot (inclusive peer-cache offline)
function collectMemorySessions(collector) {
  const cur = collector && typeof collector.current === 'function' ? collector.current() : null;
  const local = Array.isArray(cur && cur.sessions) ? cur.sessions : [];
  const out = local.slice();
  const seen = new Set(local.map((s) => s && s.id).filter(Boolean));
  const snap = cur && cur.snapshot;
  const cards = [...((snap && snap.active) || []), ...((snap && snap.recent) || [])];
  for (const c of cards) {
    if (!c || !c.id || seen.has(c.id)) continue;
    // Sessões locais já entraram completas em `local`; aqui entram principalmente sessões de peers (id `m0:...`)
    if (!String(c.id).includes(':')) continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      tool: c.tool || 'AI',
      project: c.project || '',
      title: c.title || '',
      cwd: c.cwd || '',
      machine: c.machine || '',
      start: toIsoTime(c.start),
      end: toIsoTime(c.end),
      prompts: c.prompts || 0,
      lastPrompt: c.lastPrompt || '',
      lastReply: c.lastReply || '',
    });
  }
  return out;
}

function readDreamUsageLog(workspaceRoot, { limit = 50 } = {}) {
  const file = path.join(workspaceRoot, 'dream-usage.jsonl');
  const raw = readTextSafe(file);
  const rows = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (!e || typeof e !== 'object') continue;
      inputTokens += Number(e.inputTokens) || 0;
      outputTokens += Number(e.outputTokens) || 0;
      cacheReadTokens += Number(e.cacheReadTokens) || 0;
      totalTokens += Number(e.totalTokens) || 0;
      if (typeof e.costUsd === 'number') costUsd += e.costUsd;
      rows.push(e);
    } catch {}
  }
  return {
    runs: rows.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    recent: rows.slice(-Math.max(1, limit)).reverse(),
  };
}

module.exports = {
  resolveProjectMemoryDir,
  readDreamState,
  readProjectMemory,
  listAllProjectMemories,
  collectMemorySessions,
  readDreamUsageLog,
};
