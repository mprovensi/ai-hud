// Leitura dos logs locais dos CLIs de IA (Claude Code, Codex, Antigravity/Gemini)
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

function walk(dir, ext, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

const day = (ts) => new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD no fuso local

// Reprocessa um arquivo só quando muda (o servidor relê tudo a cada poucos segundos)
const cache = new Map();
function cached(file, parser) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = parser(file);
  if (value) value.mtime = st.mtimeMs;
  cache.set(file, { mtime: st.mtimeMs, size: st.size, value });
  return value;
}

function emptySession(tool, id, file) {
  return { tool, id, file, cwd: '', start: null, end: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    models: new Set(), subagent: false, context: 0, contextWindow: 0, lastStop: '', events: [],
    title: '', prompts: 0, firstPrompt: '', lastPrompt: '', lastReply: '', toolCalls: 0, lastTool: '', tools: {} };
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t).trim();

function prompt(s, text) {
  s.prompts++;
  s.lastPrompt = clip(text, 400);
  if (!s.firstPrompt) s.firstPrompt = clip(text, 120);
}

function toolCall(s, name) {
  s.toolCalls++;
  s.lastTool = name;
  s.tools[name] = (s.tools[name] || 0) + 1;
}

function touch(s, ts) {
  if (!ts) return;
  if (!s.start || ts < s.start) s.start = ts;
  if (!s.end || ts > s.end) s.end = ts;
}

// Claude Code: cada resposta do assistente traz message.usage (repetida por bloco; deduplicar por id)
function parseClaude(f) {
  const seen = new Set();
  const s = emptySession('Claude Code', path.basename(f, '.jsonl'), f);
  s.subagent = f.includes('subagents');
  for (const line of readLines(f)) {
    const r = parse(line);
    if (!r) continue;
    if (r.cwd && !s.cwd) s.cwd = r.cwd;
    if (r.entrypoint && !s.where) s.where = r.entrypoint === 'claude-vscode' ? 'vscode' : r.entrypoint === 'cli' ? 'terminal' : r.entrypoint;
    touch(s, r.timestamp);
    if (r.type === 'ai-title' && r.aiTitle) s.title = r.aiTitle;
    const m = r.message;
    // Pedido do usuário: texto puro (sem resultados de ferramenta nem avisos internos em <tags>)
    if (r.type === 'user' && m && !r.isMeta) {
      const c = m.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
      // "[Request interrupted by user]" é aviso do Claude Code, não pedido
      if (text && !text.startsWith('<') && !text.startsWith('[Request interrupted')) prompt(s, text);
    }
    if (r.type !== 'assistant' || !m || !m.usage) continue;
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text) s.lastReply = clip(b.text, 4000);
      if (b.type === 'tool_use') toolCall(s, b.name);
    }
    if (m.stop_reason) s.lastStop = m.stop_reason;
    const key = `${m.id}:${r.requestId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.model && !m.model.startsWith('<')) s.models.add(m.model);
    const u = m.usage;
    s.input += u.input_tokens || 0;
    s.output += u.output_tokens || 0;
    s.cacheRead += u.cache_read_input_tokens || 0;
    s.cacheWrite += u.cache_creation_input_tokens || 0;
    s.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    s.events.push({ ts: r.timestamp, fresh: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cacheRead: u.cache_read_input_tokens || 0 });
  }
  return s.events.length ? s : null;
}

// Subagentes ficam em <sessão>/subagents/agent-*.jsonl; somados na sessão que os iniciou
function claudeSessions() {
  const all = walk(path.join(HOME, '.claude', 'projects'), '.jsonl').map((f) => cached(f, parseClaude)).filter(Boolean);
  const byId = new Map(all.filter((s) => !s.subagent).map((s) => [s.id, s]));
  for (const s of byId.values()) { s.subagents = 0; s.subTokens = 0; }
  for (const s of all) {
    if (!s.subagent) continue;
    const parent = byId.get(path.basename(path.dirname(path.dirname(s.file))));
    if (!parent) continue;
    parent.subagents++;
    parent.subTokens += s.input + s.output + s.cacheWrite;
  }
  return all;
}

// Codex: eventos token_count trazem total acumulado da sessão + rate_limits do plano
function parseCodex(f) {
  const s = emptySession('Codex', path.basename(f, '.jsonl'), f);
  s.limitSamples = [];
  let prev = null, limits = null, limitsTs = '';
  for (const line of readLines(f)) {
    const r = parse(line);
    if (!r) continue;
    touch(s, r.timestamp);
    const p = r.payload || {};
    if (r.type === 'session_meta') {
      s.cwd = p.cwd || '';
      s.subagent = !!(p.source && p.source.subagent);
      s.where = p.originator === 'codex_vscode' ? 'vscode' : p.originator === 'codex-tui' ? 'terminal' : p.originator || '';
    }
    if (r.type === 'turn_context' && p.model) s.models.add(p.model);
    if (p.type === 'task_complete') s.lastStop = 'end_turn';
    if (p.type === 'task_started') s.lastStop = '';
    if (p.type === 'user_message' && p.message) prompt(s, p.message);
    if (p.type === 'agent_message' && p.message) s.lastReply = clip(p.message, 4000);
    if (r.type === 'response_item' && /^(custom_tool_call|function_call|local_shell_call)$/.test(p.type)) {
      toolCall(s, p.name || p.type);
    }
    if (p.type !== 'token_count') continue;
    if (p.rate_limits && r.timestamp > limitsTs) { limits = p.rate_limits; limitsTs = r.timestamp; }
    // Cada chamada registra a cota: histórico gratuito para o gráfico da janela de 5h
    const primary = p.rate_limits && p.rate_limits.primary;
    if (primary && primary.resets_at) s.limitSamples.push([Date.parse(r.timestamp), primary.used_percent, primary.resets_at * 1000]);
    const info = p.info;
    if (!info || !info.total_token_usage) continue;
    const t = info.total_token_usage;
    s.input = (t.input_tokens || 0) - (t.cached_input_tokens || 0);
    s.cacheRead = t.cached_input_tokens || 0;
    s.cacheWrite = t.cache_write_input_tokens || 0;
    s.output = t.output_tokens || 0;
    if (info.last_token_usage) s.context = info.last_token_usage.input_tokens || 0;
    s.contextWindow = info.model_context_window || 0;
    // O total é acumulado; o evento do gráfico é a diferença para a leitura anterior
    const fresh = s.input + s.output + s.cacheWrite, read = s.cacheRead;
    const d = prev ? { fresh: fresh - prev.fresh, cacheRead: read - prev.cacheRead } : { fresh, cacheRead: read };
    if (d.fresh > 0 || d.cacheRead > 0) s.events.push({ ts: r.timestamp, fresh: d.fresh, cacheRead: d.cacheRead });
    prev = { fresh, cacheRead: read };
  }
  s.limits = limits;
  s.limitsTs = limitsTs;
  return s.start ? s : null;
}

function codexData() {
  const sessions = walk(path.join(HOME, '.codex', 'sessions'), '.jsonl').map((f) => cached(f, parseCodex)).filter(Boolean);
  let limits = null, limitsTs = '';
  for (const s of sessions) if (s.limits && s.limitsTs > limitsTs) { limits = s.limits; limitsTs = s.limitsTs; }
  return { sessions, limits, limitsTs };
}

// Antigravity (Gemini): não registra tokens; só o histórico de prompts por conversa
function antigravitySessions() {
  const byConv = new Map();
  for (const line of readLines(path.join(HOME, '.gemini', 'antigravity-cli', 'history.jsonl'))) {
    const r = parse(line);
    if (!r || !r.timestamp) continue;
    const id = r.conversationId || `sem-id-${day(r.timestamp)}`;
    const ts = new Date(r.timestamp).toISOString();
    const s = byConv.get(id) || Object.assign(emptySession('Antigravity', id, ''), { cwd: r.workspace || '' });
    touch(s, ts);
    prompt(s, r.display || '');
    s.mtime = new Date(s.end).getTime();
    byConv.set(id, s);
  }
  return [...byConv.values()];
}

module.exports = { claudeSessions, codexData, antigravitySessions, day, HOME };
