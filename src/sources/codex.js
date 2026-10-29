// Codex: rollouts .jsonl em ~/.codex/sessions; eventos token_count trazem total acumulado da sessão
// + rate_limits do plano. Conversas antigas podem existir só nos bancos SQLite (codex-history.js).
const path = require('path');
const os = require('os');
const { walk, readLines, parse, cached, emptySession, clip, prompt, toolCall, touch } = require('./common');
const { readCodexHistory } = require('./codex-history');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// Onde a sessão roda: vale o originator (o Codex grava source "vscode" também no CLI e no app);
// source só decide quando o originator não é conhecido
function codexWhere(meta) {
  const o = String(meta.originator || '');
  if (o === 'codex_vscode') return 'vscode';
  if (o === 'codex-tui' || o === 'codex_exec' || o === 'codex_cli_rs') return 'terminal';
  if (/^codex desktop$/i.test(o)) return 'codex-desktop';
  if (meta.source === 'vscode') return 'vscode';
  return meta.source === 'cli' ? 'terminal' : o;
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
    if (p.type === 'agent_message' && p.message) { s.lastReply = clip(p.message, 4000); legacyReplyAt = r.timestamp; s.lastReplyAt = codexTime(r.timestamp); }
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
  if (fallbackReply && fallbackReplyAt >= legacyReplyAt) { s.lastReply = clip(fallbackReply, 4000); s.lastReplyAt = codexTime(fallbackReplyAt); }
  return s.start ? s : null;
}

function codexData(root = CODEX_HOME) {
  const sessions = walk(path.join(root, 'sessions'), '.jsonl').map((f) => cached(f, parseCodex)).filter(Boolean);
  const byId = new Map(sessions.map((s) => [s.id.slice(-36), s]));
  for (const { thread, messages, turn } of readCodexHistory(root)) {
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

module.exports = { codexData, codexWhere };
