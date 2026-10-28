// Leitura dos logs locais dos CLIs de IA (Claude Code, Codex, Antigravity/Gemini)
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const { readCodexHistory } = require('./codex-history');

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
function codexWhere(meta) {
  if (meta.source === 'vscode' || meta.originator === 'codex_vscode') return 'vscode';
  return meta.originator === 'codex-tui' || meta.source === 'cli' ? 'terminal' : meta.originator || '';
}

function codexText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((c) => /^(input_text|output_text|text)$/.test(c.type)).map((c) => c.text || '').join('\n') : '';
}

function codexTime(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value) || 0;
}

function parseCodex(f) {
  const s = emptySession('Codex', path.basename(f, '.jsonl'), f);
  s.limitSamples = [];
  s.completedAt = 0;
  let prev = null, limits = null, limitsTs = '';
  const userPrompts = [], promptIds = new Set();
  let currentTurn = 'initial', turnIndex = 0;
  const collectPrompt = (text, source, p, timestamp) => {
    if (!text) return;
    const metadata = p.internal_chat_message_metadata_passthrough || {};
    const turn = p.turn_id || metadata.turn_id || currentTurn;
    const id = p.client_id || p.id;
    const identity = id && `${source}:${id}`;
    if (identity && promptIds.has(identity)) return;
    if (identity) promptIds.add(identity);
    // Os formatos antigo e novo podem registrar a mesma mensagem. Une cada par
    // dentro do turno, preservando mensagens que existem em apenas um formato.
    const duplicate = userPrompts.find((m) => m.turn === turn && m.text === text && !m.sources.has(source)
      && (turn !== 'initial' || Math.abs(Date.parse(timestamp) - Date.parse(m.timestamp)) < 1000));
    if (duplicate) duplicate.sources.add(source);
    else userPrompts.push({ text, turn, timestamp, sources: new Set([source]) });
  };
  let fallbackReply = '', fallbackReplyAt = '', legacyReplyAt = '';
  for (const line of readLines(f)) {
    const r = parse(line);
    if (!r) continue;
    touch(s, r.timestamp);
    const p = r.payload || {};
    // Um rollout de subagente pode conter session_meta herdado do pai.
    if (r.type === 'session_meta' && (!p.id || p.id === s.id.slice(-36))) {
      s.cwd = p.cwd || '';
      s.subagent = !!(p.source && p.source.subagent);
      s.where = codexWhere(p);
      s.contextWindow = p.context_window || s.contextWindow;
    }
    if (r.type === 'turn_context' && p.model) s.models.add(p.model);
    if (p.type === 'task_complete') {
      s.lastStop = 'end_turn';
      s.completedAt = codexTime(r.timestamp);
      currentTurn = `after:${++turnIndex}`;
    }
    if (p.type === 'task_started') { s.lastStop = ''; currentTurn = p.turn_id || `turn:${++turnIndex}`; }
    if (p.type === 'user_message' && p.message) collectPrompt(p.message, 'event', p, r.timestamp);
    if (p.type === 'agent_message' && p.message) { s.lastReply = clip(p.message, 4000); legacyReplyAt = r.timestamp; }
    // Novos rollouts não duplicam as mensagens nos eventos user_message/agent_message.
    if (r.type === 'response_item' && p.type === 'message') {
      const text = codexText(p.content);
      const kinds = p.internal_chat_message_metadata_passthrough && p.internal_chat_message_metadata_passthrough.content_item_kinds;
      const userContent = kinds && kinds.length ? kinds.some((k) => /^user\./.test(k))
        : !/^(<environment_context>|<turn_aborted>|<external_codex_apps_open_page>|# AGENTS\.md instructions)/.test(text);
      if (p.role === 'user' && userContent) collectPrompt(text, 'response', p, r.timestamp);
      if (p.role === 'assistant' && text) { fallbackReply = text; fallbackReplyAt = r.timestamp; }
    }
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
  for (const m of userPrompts) prompt(s, m.text);
  if (fallbackReply && fallbackReplyAt >= legacyReplyAt) s.lastReply = clip(fallbackReply, 4000);
  return s.start ? s : null;
}

function codexData() {
  const sessions = walk(path.join(CODEX_HOME, 'sessions'), '.jsonl').map((f) => cached(f, parseCodex)).filter(Boolean);
  const byId = new Map(sessions.map((s) => [s.id.slice(-36), s]));
  for (const { thread, messages, turn } of readCodexHistory(CODEX_HOME)) {
    let s = byId.get(thread.id);
    if (!s && thread.rollout_path) {
      s = cached(thread.rollout_path, parseCodex);
      if (s) { sessions.push(s); byId.set(thread.id, s); }
    }
    const sqliteOnly = !s;
    if (!s) {
      s = emptySession('Codex', thread.id, thread.rollout_path || '');
      const start = thread.created_at_ms || thread.created_at * 1000;
      const end = thread.updated_at_ms || thread.updated_at * 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      s.start = new Date(start).toISOString(); s.end = new Date(end).toISOString(); s.mtime = end;
      sessions.push(s);
    }
    s.title = thread.name || thread.title || s.title;
    s.cwd = thread.cwd || s.cwd;
    const source = parse(thread.source) || thread.source;
    s.subagent = !!(source && source.subagent);
    s.where = codexWhere({ source, originator: thread.originator }) || s.where;
    if (thread.model) s.models.add(thread.model);
    if (sqliteOnly) {
      for (const m of messages) {
        if (m.type === 'userMessage') { const text = codexText(m.content); if (text) prompt(s, text); }
        if (m.type === 'agentMessage' && m.text) s.lastReply = clip(m.text, 4000);
      }
      if (!s.prompts && thread.first_user_message) prompt(s, thread.first_user_message);
      s.lastStop = turn && turn.status === 'inProgress' ? '' : 'end_turn';
      s.completedAt = turn && turn.status === 'completed' ? codexTime(turn.completed_at) : 0;
    }
  }
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

module.exports = { claudeSessions, codexData, antigravitySessions, HOME };
