// Capacidades desta máquina para criar novas sessões pelo HUD: quais IAs estão disponíveis,
// modelos sugeridos/instalados (incluindo `agy models` e `/api/tags` do Ollama) e pastas recentes.
// Somente leitura (camada collect/).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ROOT } = require('../infra/paths');
const { normalizePath } = require('../core/path-guard');

const AGY_CACHE_MS = 10 * 60e3;
const AGY_RETRY_MS = 30e3;
const CLAUDE_PRESETS = [
  { id: '', label: 'Padrão' },
  { id: 'sonnet', label: 'Sonnet (mais recente)' },
  { id: 'opus', label: 'Opus (mais recente)' },
  { id: 'haiku', label: 'Haiku (mais recente)' },
];
const CODEX_PRESETS = [
  { id: '', label: 'Padrão' },
];

// Lê `model = "..."` de ~/.codex/config.toml para sugerir primeiro o modelo real da conta
function readCodexConfigModel(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  try {
    const raw = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(raw);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// Verifica se um executável existe de fato (caminho absoluto ou no PATH)
function hasExe(exe) {
  if (!exe || typeof exe !== 'string') return false;
  if (path.isAbsolute(exe) || exe.includes('/') || exe.includes('\\')) {
    try { return fs.statSync(exe).isFile(); } catch { return false; }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try { if (fs.statSync(path.join(dir, exe)).isFile()) return true; } catch {}
  }
  return false;
}

function parseAgyModels(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('\t')) continue;
    const [id, ...rest] = trimmed.split('\t');
    const cleanId = id.trim();
    const label = rest.join(' ').trim() || cleanId;
    if (cleanId && /^[a-z0-9._-]+$/i.test(cleanId)) out.push({ id: cleanId, label });
  }
  return out;
}

function mergeModels(presets, recentSet) {
  const out = presets.slice();
  const seen = new Set(out.map((m) => m.id.toLowerCase()));
  for (const m of recentSet) {
    const id = String(m || '').trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({ id, label: id });
  }
  return out;
}

function recentCwds(sessions, pinned = []) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const norm = normalizePath(raw);
    if (!norm) return;
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(norm);
  };
  for (const p of pinned || []) add(p);
  const sorted = (sessions || [])
    .filter((s) => s && !s.subagent && s.cwd && typeof s.cwd === 'string')
    .slice()
    .sort((a, b) => (Date.parse(b.end) || 0) - (Date.parse(a.end) || 0));
  for (const s of sorted) {
    add(s.cwd);
    if (out.length >= 16) break;
  }
  return out;
}

function createCapabilities({ claudeExe, codexExe, agyExe, ollama, showOllama = true, exec = execFile, getPinned = () => [], getStrictRemoteCwd = () => false } = {}) {
  let agyModels = [];
  let agyAt = 0;
  let agyRetryAt = 0;
  let agyPending = null;

  function refreshAgyModels() {
    if (!hasExe(agyExe)) return Promise.resolve([]);
    if (agyPending) return agyPending;
    agyPending = new Promise((resolve) => {
      exec(agyExe, ['models'], { windowsHide: true, cwd: ROOT, timeout: 45e3, maxBuffer: 512 * 1024 }, (err, stdout) => {
        agyPending = null;
        const now = Date.now();
        if (!err && stdout) {
          const parsed = parseAgyModels(stdout);
          if (parsed.length) {
            agyModels = parsed;
            agyAt = now;
            agyRetryAt = 0;
            return resolve(agyModels);
          }
        }
        // Em erro/timeout (ex.: cold start em VPS Micro), tenta de novo em 30s em vez de travar por 10 min
        agyRetryAt = now + AGY_RETRY_MS;
        resolve(agyModels);
      });
    });
    return agyPending;
  }

  function start() {
    // Aguarda 6s para não competir por CPU com as leituras de cota no arranque de VMs pequenas
    if (hasExe(agyExe)) {
      const t = setTimeout(() => refreshAgyModels(), 6000);
      if (t.unref) t.unref();
    }
  }

  function get(sessions = [], machineName = os.hostname()) {
    const hasClaude = hasExe(claudeExe);
    const hasCodex = hasExe(codexExe);
    const hasAgy = hasExe(agyExe);
    const now = Date.now();
    if (hasAgy && ((agyAt && now - agyAt > AGY_CACHE_MS) || (!agyAt && now >= agyRetryAt))) refreshAgyModels();

    const claudeRecent = new Set();
    const codexRecent = new Set();
    const cfgCodexModel = hasCodex ? readCodexConfigModel() : '';
    if (cfgCodexModel) codexRecent.add(cfgCodexModel);
    for (const s of sessions || []) {
      if (!s || s.subagent || !s.models) continue;
      if (s.tool === 'Claude Code') for (const m of s.models) claudeRecent.add(m);
      if (s.tool === 'Codex') for (const m of s.models) codexRecent.add(m);
    }

    const ollamaOnline = !!(showOllama && ollama && ollama.state && ollama.state.online);
    const ollamaNames = ollamaOnline
      ? (Array.isArray(ollama.installedModels) && ollama.installedModels.length
        ? ollama.installedModels
        : (ollama.state.models || []).map((m) => m.name).filter(Boolean))
      : [];

    const tools = {};
    if (hasClaude) tools['Claude Code'] = { models: mergeModels(CLAUDE_PRESETS, claudeRecent) };
    if (hasCodex) tools.Codex = { models: mergeModels(CODEX_PRESETS, codexRecent) };
    // Gemini usa exclusivamente Antigravity CLI (`agy`) — Gemini CLI OAuth foi descontinuado
    if (hasAgy) tools.Gemini = { models: [{ id: '', label: 'Padrão' }].concat(agyModels) };
    if (ollamaOnline && ollamaNames.length) tools.Ollama = { models: ollamaNames.map((m) => ({ id: m, label: m })) };

    const pinnedList = (getPinned() || []).map((p) => normalizePath(p)).filter(Boolean);
    return {
      name: machineName,
      online: true,
      platform: process.platform,
      home: os.homedir(),
      pinned: pinnedList,
      strictRemoteCwd: !!getStrictRemoteCwd(),
      cwds: recentCwds(sessions, pinnedList),
      tools,
    };
  }

  return { start, get, refreshAgyModels };
}

module.exports = { createCapabilities, parseAgyModels, hasExe, recentCwds };
