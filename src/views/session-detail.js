// /api/session: tudo o que a gaveta mostra ao tocar numa sessão. Mesmo contrato do snapshot: só acrescentar.
const { sessionState, base } = require('../core/session');
const { extractTextQuestions, suggestReplies } = require('../core/questions');

function canReplyRemote(s) {
  if (s.where === 'ollama-run' || s.tool === 'Antigravity') return false;
  if (s.tool === 'Gemini') return s.where !== 'antigravity' && /^[0-9a-f-]{36}$/.test(String(s.id || ''));
  return true;
}

function resolveQuestion(s, state, pending) {
  if (pending.permission && Array.isArray(pending.permission.questions) && pending.permission.questions.length) {
    return { mode: 'permission', permissionId: pending.permission.id, questions: pending.permission.questions };
  }
  const readonly = !canReplyRemote(s);
  if (Array.isArray(s.pendingQuestion) && s.pendingQuestion.length) {
    return { mode: readonly ? 'readonly' : 'reply', questions: s.pendingQuestion };
  }
  if (state === 'waiting' && s.lastReply) {
    const detected = extractTextQuestions(s.lastReply);
    if (detected.length) return { mode: readonly ? 'readonly' : 'reply', questions: detected };
  }
  return null;
}

function relPath(raw, cwd) {
  const p = String(raw || '').replace(/\\/g, '/');
  const baseDir = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (baseDir && p.toLowerCase().startsWith(baseDir.toLowerCase() + '/')) return p.slice(baseDir.length + 1);
  return p;
}

function buildFilesList(files, cwd) {
  const map = new Map();
  for (const [p, count] of Object.entries(files || {})) {
    const rel = relPath(p, cwd);
    if (!rel) continue;
    const prev = map.get(rel) || 0;
    map.delete(rel);
    map.set(rel, prev + count);
  }
  return [...map.entries()].reverse().slice(0, 12);
}

function buildSessionDetail(s, now, pendingInfo) {
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const files = buildFilesList(s.files, s.cwd);
  const state = sessionState(s, now);
  const pending = pendingInfo(s, now);
  const rawHistory = Array.isArray(s.history) && s.history.length
    ? s.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-20)
        .map((m) => ({
          role: m.role,
          content: String(m.content || '').slice(0, 4000),
          at: m.at || 0,
          tools: Array.isArray(m.tools) && m.tools.length ? m.tools.slice(0, 6) : undefined,
        }))
    : null;
  const question = resolveQuestion(s, state, pending);
  return {
    tool: s.tool, id: s.id, title: s.title || s.firstPrompt, project: s.project || base(s.cwd) || '—', cwd: s.cwd,
    models: [...s.models], start: Date.parse(s.start), end: Date.parse(s.end), state, now,
    completedAt: s.completedAt || 0,
    ollamaGeneration: s.tool === 'Ollama' ? s.generation || null : undefined,
    input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
    context: s.context, contextWindow: s.contextWindow, prompts: s.prompts, toolCalls: s.toolCalls,
    lastTool: s.lastTool, tools, files, lastPrompt: s.lastPrompt, lastReply: s.lastReply,
    // Hora da última resposta; sem ela (Codex só no SQLite), o fim do último turno
    lastReplyAt: s.lastReply ? s.lastReplyAt || s.completedAt || 0 : 0,
    testRun: s.testRun || null,
    subagents: s.subagents || 0, subTokens: s.subTokens || 0, ...pending, where: s.where || '',
    canFocus: process.platform === 'win32',
    turns: s.events.slice(-10).reverse().map((e) => ({ t: Date.parse(e.ts), fresh: e.fresh, cacheRead: e.cacheRead })),
    history: rawHistory,
    question,
    suggestions: suggestReplies({ lastReply: s.lastReply, state, testFailed: !!(s.testRun && !s.testRun.ok), hasQuestion: !!question }),
  };
}

module.exports = { buildSessionDetail };
