// Claude Code: um .jsonl por sessão em ~/.claude/projects; subagentes em <sessão>/subagents/agent-*.jsonl
const path = require('path');
const os = require('os');
const { walk, readLines, parse, cached, emptySession, touchFile, pushHistory, clip, prompt, toolCall, touch } = require('./common');
const { readJson } = require('../../infra/store');
const { isTestCommand, testOutcome } = require('../../core/tests');
const { normalizeQuestions } = require('../../core/questions');

// Resultado de uma ferramenta: texto puro ou lista de blocos de texto
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

// Cada resposta do assistente traz message.usage (repetida por bloco; deduplicar por id)
function parseClaude(f) {
  const seen = new Set();
  const tests = new Map(); // id da chamada → comando de teste, até chegar o resultado
  const asks = new Map();  // id da chamada AskUserQuestion → perguntas normalizadas, até chegar o resultado
  let turnTools = [];
  let lastAssistMsgId = '';
  const s = emptySession('Claude Code', path.basename(f, '.jsonl'), f);
  s.subagent = f.includes('subagents');
  for (const line of readLines(f)) {
    const r = parse(line);
    if (!r) continue;
    if (r.cwd && !s.cwd) s.cwd = r.cwd;
    if (r.entrypoint && !s.where) s.where = r.entrypoint === 'claude-vscode' ? 'vscode' : r.entrypoint === 'cli' ? 'terminal' : r.entrypoint;
    touch(s, r.timestamp);
    if (r.type === 'ai-title' && r.aiTitle) s.title = r.aiTitle;
    // Nome dado no Claude (/rename): vira o nome do cartão no lugar da pasta; o último vale
    if (r.type === 'custom-title' && r.customTitle) s.project = r.customTitle;
    const m = r.message;
    // Pedido do usuário: texto puro (sem resultados de ferramenta nem avisos internos em <tags>)
    if (r.type === 'user' && m && !r.isMeta) {
      const c = m.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
      // "[Request interrupted by user]" é aviso do Claude Code, não pedido
      if (text && !text.startsWith('<') && !text.startsWith('[Request interrupted')) {
        prompt(s, text);
        pushHistory(s, 'user', text, r.timestamp);
        turnTools = [];
        lastAssistMsgId = '';
        asks.clear();
      }
      // Resultado de ferramenta: teste ou resposta a AskUserQuestion
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type !== 'tool_result') continue;
        if (asks.has(b.tool_use_id)) asks.delete(b.tool_use_id);
        if (!tests.has(b.tool_use_id)) continue;
        s.testRun = { command: tests.get(b.tool_use_id), at: Date.parse(r.timestamp) || 0, ...testOutcome(resultText(b.content), b.is_error) };
        tests.delete(b.tool_use_id);
      }
    }
    // Resposta enviada pelo HUD: o hook Stop (hook-stop.js) a entrega como "erro de bloqueio", não como pedido
    const a = r.type === 'attachment' && r.attachment;
    if (a && a.type === 'hook_blocking_error' && a.hookEvent === 'Stop' && a.blockingError
      && /hook-stop\.js/.test(a.blockingError.command || '') && a.blockingError.blockingError) {
      prompt(s, a.blockingError.blockingError);
      pushHistory(s, 'user', a.blockingError.blockingError, r.timestamp);
      turnTools = [];
      lastAssistMsgId = '';
    }
    if (r.type !== 'assistant' || !m || !m.usage) continue;
    const textParts = [];
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text) {
        s.lastReply = clip(b.text, 4000);
        s.lastReplyAt = Date.parse(r.timestamp) || 0;
        textParts.push(b.text);
      }
      if (b.type === 'tool_use') {
        toolCall(s, b.name);
        if (b.name) turnTools.push(b.name);
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name || '') && b.input) {
          touchFile(s, b.input.file_path || b.input.path || b.input.notebook_path);
        }
        if (b.name === 'AskUserQuestion' && b.input) {
          const qs = normalizeQuestions(b.input);
          if (qs.length) asks.set(b.id, qs);
        }
      }
      if (b.type === 'tool_use' && b.input && isTestCommand(b.input.command)) tests.set(b.id, clip(b.input.command, 200));
    }
    if (textParts.length) {
      const joined = textParts.join('\n').trim();
      const prev = s.history[s.history.length - 1];
      if (m.id && m.id === lastAssistMsgId && prev && prev.role === 'assistant') {
        prev.content = clip(`${prev.content}\n${joined}`, 4000);
        prev.at = Date.parse(r.timestamp) || prev.at;
      } else {
        pushHistory(s, 'assistant', joined, r.timestamp, turnTools);
        turnTools = [];
        lastAssistMsgId = m.id || '';
      }
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
  const lastAsk = [...asks.values()].pop();
  s.pendingQuestion = lastAsk || null;
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
