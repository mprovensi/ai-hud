// Claude Code: um .jsonl por sessão em ~/.claude/projects; subagentes em <sessão>/subagents/agent-*.jsonl
const path = require('path');
const os = require('os');
const { walk, readLines, parse, cached, emptySession, clip, prompt, toolCall, touch } = require('./common');
const { readJson } = require('../store');

// Cada resposta do assistente traz message.usage (repetida por bloco; deduplicar por id)
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
      if (b.type === 'text' && b.text) { s.lastReply = clip(b.text, 4000); s.lastReplyAt = Date.parse(r.timestamp) || 0; }
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

// O log não traz o tamanho da janela de contexto: usa o que a statusline viu para a sessão,
// senão o modelo configurado ([1m] = 1M tokens), senão 200k
function contextWindow(s, home, statuslineFile) {
  const sl = statuslineFile ? readJson(statuslineFile, {}) : {};
  if (sl.session_id === s.id && sl.context_window && sl.context_window.context_window_size) return sl.context_window.context_window_size;
  const model = String(readJson(path.join(home, '.claude', 'settings.json'), {}).model || '');
  return model.includes('[1m]') || s.context > 200e3 ? 1e6 : 200e3;
}

// Subagentes são somados na sessão que os iniciou
function claudeSessions({ home = os.homedir(), statuslineFile } = {}) {
  const all = walk(path.join(home, '.claude', 'projects'), '.jsonl').map((f) => cached(f, parseClaude)).filter(Boolean);
  const byId = new Map(all.filter((s) => !s.subagent).map((s) => [s.id, s]));
  for (const s of byId.values()) {
    s.subagents = 0; s.subTokens = 0;
    if (!s.contextWindow) s.contextWindow = contextWindow(s, home, statuslineFile);
  }
  for (const s of all) {
    if (!s.subagent) continue;
    const parent = byId.get(path.basename(path.dirname(path.dirname(s.file))));
    if (!parent) continue;
    parent.subagents++;
    parent.subTokens += s.input + s.output + s.cacheWrite;
  }
  return all;
}

module.exports = { claudeSessions };
