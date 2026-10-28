// Conversas do app do Ollama (Windows) como sessões do HUD.
// Lê o banco do app (%LOCALAPPDATA%\Ollama\db.sqlite) SÓ PARA LEITURA. A API interna do app exige um
// token que só existe na memória dele, então responder pelo HUD não passa pelo app: o servidor monta o
// histórico da conversa + a mensagem nova, gera no Ollama (:11434) e guarda essa continuação em
// ollama-replies.json. Ela aparece no HUD, não no app.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { generationMetrics } = require('./ollama-metrics');

const DB = path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'db.sqlite');
const STORE = path.join(__dirname, '..', 'data', 'ollama-replies.json');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {} // Node 22.5+; sem ele, nada de sessões do Ollama

// Datas do banco podem vir como texto ISO ou número (segundos/ms)
function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!Number.isNaN(n) && /^\d+(\.\d+)?$/.test(String(v))) return n < 1e12 ? n * 1000 : n;
  return Date.parse(v) || 0;
}

let cont = {}; // chatId -> { messages: [{ role, content, at, model, tokens }], generating }
try {
  const stored = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) cont = stored;
} catch {}
const save = () => { try { fs.writeFileSync(STORE, JSON.stringify(cont)); } catch {} };

// Uma geração pertence ao processo anterior e não pode continuar após um reinício.
let recovered = false;
for (const entry of Object.values(cont)) {
  if (!entry || !entry.generating) continue;
  entry.generating = false;
  if (!Array.isArray(entry.messages)) entry.messages = [];
  entry.messages.push({ role: 'assistant', content: '⚠ Geração interrompida pelo reinício do HUD. Envie uma nova mensagem para continuar.', at: Date.now() });
  recovered = true;
}
if (recovered) save();

let cache = { sig: '', at: 0, chats: [] };

// Lê chats e mensagens; relê só quando o banco (ou o WAL) mudou
function readChats() {
  if (!sqlite) return [];
  // Assinatura = data + tamanho do banco e do WAL. No Windows a data de um arquivo mantido aberto
  // (o app segura o db) não atualiza; o tamanho sim. E relê no máximo a cada 30 s de qualquer jeito.
  let sig = '';
  for (const f of [DB, `${DB}-wal`]) { try { const st = fs.statSync(f); sig += `${st.mtimeMs}:${st.size};`; } catch {} }
  if (!sig) return [];
  if (sig === cache.sig && Date.now() - cache.at < 30e3) return cache.chats;
  let db;
  try {
    db = new sqlite.DatabaseSync(DB, { readOnly: true });
    const chats = db.prepare('SELECT id, title, created_at FROM chats').all();
    const msgs = db.prepare('SELECT chat_id, role, content, model_name, created_at, updated_at FROM messages ORDER BY id').all();
    const byChat = {};
    for (const m of msgs) (byChat[m.chat_id] = byChat[m.chat_id] || []).push(m);
    cache = { sig, at: Date.now(), chats: chats.map((c) => ({ ...c, messages: byChat[c.id] || [] })) };
  } catch { /* banco ocupado: usa a leitura anterior */ } finally { try { db && db.close(); } catch {} }
  return cache.chats;
}

// Uma conversa do app (+ continuação do HUD) no mesmo formato das sessões do Claude/Codex
function toSession(c) {
  const extra = (cont[c.id] && cont[c.id].messages) || [];
  const all = c.messages.map((m) => ({ role: m.role, content: m.content || '', at: toMs(m.updated_at || m.created_at), model: m.model_name }))
    .concat(extra.map((m) => ({ ...m })));
  const users = all.filter((m) => m.role === 'user');
  const replies = all.filter((m) => m.role === 'assistant' && m.content);
  const last = all[all.length - 1];
  const end = Math.max(toMs(c.created_at), ...all.map((m) => m.at || 0));
  const generating = !!(cont[c.id] && cont[c.id].generating);
  const model = [...all].reverse().find((m) => m.model);
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  return {
    tool: 'Ollama', id: `ollama-${c.id}`, chatId: c.id, file: DB, cwd: '', where: 'ollama-app',
    start: new Date(toMs(c.created_at) || end).toISOString(), end: new Date(end).toISOString(),
    mtime: generating ? Date.now() : end,
    lastStop: generating || (last && last.role === 'user') ? '' : 'end_turn',
    // Nome do cartão = título da conversa; linha de baixo = modelo
    project: clip(c.title || (users[0] ? users[0].content : '') || 'Conversa do Ollama', 60),
    title: model ? 'modelo ' + model.model : 'Ollama',
    firstPrompt: users[0] ? clip(users[0].content, 120) : '',
    lastPrompt: users.length ? clip(users[users.length - 1].content, 400) : '',
    lastReply: replies.length ? clip(replies[replies.length - 1].content, 4000) : '',
    lastReplyAt: replies.length ? replies[replies.length - 1].at || 0 : 0,
    prompts: users.length, models: new Set(model ? [model.model] : []), lastTool: generating ? 'gerando' : '',
    input: 0, output: extra.reduce((a, m) => a + (m.tokens || 0), 0), cacheRead: 0, cacheWrite: 0,
    context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    history: all, continued: extra.length > 0,
    generation: replies.length ? replies[replies.length - 1].metrics || null : null,
  };
}

function ollamaChatSessions() { return readChats().map(toSession); }

// ---- Conversas de qualquer cliente, gravadas pelo proxy -----------------------
// O ollama-proxy (~/ollama-proxy) fica na :11434 e grava pergunta + resposta de cada chamada em
// conversas.sqlite, agrupadas por session_id (IP + modelo + primeira pergunta). Só leitura aqui.
const PROXY_DB = process.env.AI_HUD_OLLAMA_PROXY_DB || path.join(require('os').homedir(), 'ollama-proxy', 'conversas.sqlite');
const LOCAL_IP = /^(127\.|::1$|::ffff:127\.)/;
let proxyCache = { sig: '', at: 0, calls: [] };

function readProxyCalls() {
  if (!sqlite) return [];
  let sig = '';
  for (const f of [PROXY_DB, `${PROXY_DB}-wal`]) { try { const st = fs.statSync(f); sig += `${st.mtimeMs}:${st.size};`; } catch {} }
  if (!sig) return [];
  if (sig === proxyCache.sig && Date.now() - proxyCache.at < 30e3) return proxyCache.calls;
  let db;
  try {
    db = new sqlite.DatabaseSync(PROXY_DB, { readOnly: true });
    // As 40 sessões mais recentes, chamada por chamada
    const calls = db.prepare(`SELECT id, ts, client_ip, user_agent, endpoint, model, session_id, last_user, response_text,
        prompt_tokens, completion_tokens, client_aborted FROM calls
      WHERE session_id IN (SELECT session_id FROM calls GROUP BY session_id ORDER BY MAX(id) DESC LIMIT 40)
      ORDER BY id`).all();
    // Respostas que o próprio HUD gerou já aparecem como continuação da conversa original
    proxyCache = { sig, at: Date.now(), calls: calls.filter((c) => c.user_agent !== 'ai-hud') };
  } catch { /* banco ocupado: usa a leitura anterior */ } finally { try { db && db.close(); } catch {} }
  return proxyCache.calls;
}

// Chamadas de um `ollama run` aberto agora: mesmo modelo, vindas deste PC, depois que ele começou
const runCalls = (r, calls) => calls.filter((c) => /^ollama\//.test(c.user_agent || '') && LOCAL_IP.test(c.client_ip)
  && c.model === r.model && toMs(c.ts) >= r.start - 5e3);

function proxyToSession(sid, calls) {
  const extra = (cont[sid] && cont[sid].messages) || [];
  const all = [];
  for (const c of calls) {
    all.push({ role: 'user', content: c.last_user || '', at: toMs(c.ts), model: c.model });
    all.push({ role: 'assistant', content: (c.response_text || '') + (c.client_aborted ? ' [interrompida]' : ''), at: toMs(c.ts), model: c.model });
  }
  for (const m of extra) all.push({ ...m });
  const first = calls[0], last = calls[calls.length - 1];
  const users = all.filter((m) => m.role === 'user' && m.content);
  const replies = all.filter((m) => m.role === 'assistant' && m.content);
  const generating = !!(cont[sid] && cont[sid].generating);
  const end = Math.max(...all.map((m) => m.at || 0));
  const ip = String(first.client_ip).replace(/^::ffff:/, '');
  const client = (first.user_agent || '').split(/[\s/]/)[0] || 'cliente';
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  return {
    tool: 'Ollama', id: `ollama-api-${sid}`, chatId: sid, file: PROXY_DB, cwd: '', where: 'ollama-api',
    start: new Date(toMs(first.ts)).toISOString(), end: new Date(end).toISOString(),
    mtime: generating ? Date.now() : end,
    lastStop: generating ? '' : 'end_turn',
    project: clip(users[0] ? users[0].content : 'Conversa via API', 60),
    title: `${last.model || 'Ollama'} · ${LOCAL_IP.test(first.client_ip) ? 'este PC' : ip} (${client})`,
    firstPrompt: users[0] ? clip(users[0].content, 120) : '',
    lastPrompt: users.length ? clip(users[users.length - 1].content, 400) : '',
    lastReply: replies.length ? clip(replies[replies.length - 1].content, 4000) : '',
    lastReplyAt: replies.length ? replies[replies.length - 1].at || 0 : 0,
    prompts: users.length, models: new Set(calls.map((c) => c.model).filter(Boolean)), lastTool: generating ? 'gerando' : '',
    input: calls.reduce((a, c) => a + (c.prompt_tokens || 0), 0),
    output: calls.reduce((a, c) => a + (c.completion_tokens || 0), 0) + extra.reduce((a, m) => a + (m.tokens || 0), 0),
    cacheRead: 0, cacheWrite: 0, context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    history: all, continued: extra.length > 0,
    generation: replies.length ? replies[replies.length - 1].metrics || null : null,
  };
}

function ollamaProxySessions() {
  const calls = readProxyCalls();
  if (!calls.length) return [];
  // Conversas do app passam pelo proxy também: já aparecem pelo db.sqlite (com título), então ficam de fora
  const appFirst = new Set(readChats().map((c) => {
    const u = c.messages.find((m) => m.role === 'user');
    return u ? String(u.content).trim() : null;
  }).filter(Boolean));
  // Chamadas de um `ollama run` aberto vão para o cartão dele
  const claimed = new Set(runs.flatMap((r) => runCalls(r, calls).map((c) => c.id)));
  const bySid = new Map();
  for (const c of calls) if (!claimed.has(c.id)) (bySid.get(c.session_id) || bySid.set(c.session_id, []).get(c.session_id)).push(c);
  return [...bySid].filter(([, cs]) => !appFirst.has(String(cs[0].last_user || '').trim()))
    .map(([sid, cs]) => proxyToSession(sid, cs));
}

// Responder: histórico da conversa + mensagem nova → Ollama /api/chat; guarda a continuação
function replyToChat(session, text, ollamaUrl) {
  const chatId = session.chatId;
  const model = [...session.models][0];
  if (!model) return Promise.reject(new Error('não sei qual modelo esta conversa usa'));
  const entry = cont[chatId] = cont[chatId] || { messages: [] };
  if (entry.generating) return Promise.reject(new Error('ainda gerando a resposta anterior'));
  const messages = session.history.filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: text }]);
  entry.messages.push({ role: 'user', content: text, at: Date.now() });
  entry.generating = true;
  save();
  const body = JSON.stringify({ model, messages, stream: false });
  const req = http.request(new URL('/api/chat', ollamaUrl), { method: 'POST', timeout: 10 * 60e3,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'ai-hud' } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      let j = {};
      try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const content = (j.message && j.message.content) || (j.error ? `⚠ ${j.error}` : '⚠ resposta vazia');
      entry.messages.push({ role: 'assistant', content, at: Date.now(), model,
        tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0), metrics: generationMetrics(j) });
      entry.generating = false;
      save();
    });
  });
  const fail = (e) => { entry.messages.push({ role: 'assistant', content: `⚠ ${e.message}`, at: Date.now(), model }); entry.generating = false; save(); };
  req.on('timeout', () => req.destroy(new Error('o Ollama demorou demais')));
  req.on('error', fail);
  req.end(body);
  return Promise.resolve({ sent: true });
}

// ---- `ollama run` no terminal ---------------------------------------------
// O Ollama não grava a conversa do terminal: o cartão mostra que a sessão existe (modelo, desde quando),
// o último comando digitado (~/.ollama/history, compartilhado por todos os `ollama run`) e traz o
// terminal para frente. Com o ollama-proxy, pergunta e resposta vêm do banco dele.
// Procura os processos a cada 15 s.
const { execFile } = require('child_process');
const HISTORY = path.join(require('os').homedir(), '.ollama', 'history');
let runs = []; // [{ pid, model, start }]

function modelFrom(cmd) {
  const args = String(cmd).trim().split(/\s+/);
  const i = args.findIndex((a) => a === 'run');
  for (let j = i + 1; i >= 0 && j < args.length; j++) if (!args[j].startsWith('-')) return args[j].replace(/^"|"$/g, '');
  return null;
}

function scanRuns() {
  if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='ollama.exe'\" | Where-Object { $_.CommandLine -match '\\srun\\s' } | " +
      "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToString('o'))|$($_.CommandLine)\" }";
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15e3 }, (err, out) => {
      if (err) return;
      runs = String(out).split(/\r?\n/).filter(Boolean).map((l) => {
        const [pid, start, ...cmd] = l.split('|');
        return { pid: Number(pid), start: Date.parse(start) || Date.now(), model: modelFrom(cmd.join('|')) };
      }).filter((r) => r.model);
    });
  } else {
    execFile('ps', ['-eo', 'pid=,etimes=,args='], { timeout: 15e3 }, (err, out) => {
      if (err) return;
      runs = String(out).split('\n').filter((l) => /\bollama\s+run\s/.test(l)).map((l) => {
        const [, pid, secs, cmd] = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/) || [];
        return { pid: Number(pid), start: Date.now() - Number(secs) * 1000, model: modelFrom(cmd) };
      }).filter((r) => r.pid && r.model);
    });
  }
}
scanRuns();
setInterval(scanRuns, 15e3);

function ollamaRunSessions() {
  if (!runs.length) return [];
  let lastCmd = '', histAt = 0, cmds = [];
  try {
    const lines = fs.readFileSync(HISTORY, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('/'));
    lastCmd = lines.length ? lines[lines.length - 1] : '';
    histAt = fs.statSync(HISTORY).mtimeMs;
    // Últimos comandos digitados (o terminal não grava as respostas)
    cmds = lines.slice(-12).map((l) => ({ role: 'user', content: l }));
  } catch {}
  const calls = readProxyCalls();
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  return runs.map((r) => {
    const mine = runCalls(r, calls);
    const last = mine[mine.length - 1];
    // Com o proxy, a conversa inteira; sem ele, só os comandos digitados
    const history = mine.length ? mine.flatMap((c) => [
      { role: 'user', content: c.last_user || '', at: toMs(c.ts), model: c.model },
      { role: 'assistant', content: c.response_text || '', at: toMs(c.ts), model: c.model },
    ]) : cmds;
    return {
      tool: 'Ollama', id: `ollama-run-${r.pid}`, pid: r.pid, file: '', cwd: '', where: 'ollama-run',
      project: r.model, title: 'terminal · ollama run',
      start: new Date(r.start).toISOString(), end: new Date(Math.max(r.start, histAt, last ? toMs(last.ts) : 0)).toISOString(),
      // Processo aberto = sessão ativa esperando o usuário no terminal
      mtime: Date.now(), lastStop: 'end_turn',
      firstPrompt: mine.length ? clip(mine[0].last_user || '', 120) : '',
      lastPrompt: clip(last ? last.last_user || '' : lastCmd, 400),
      lastReply: last ? clip(last.response_text || '', 4000) : '',
      lastReplyAt: last ? toMs(last.ts) : 0,
      prompts: mine.length, models: new Set([r.model]), lastTool: '', history,
      input: mine.reduce((a, c) => a + (c.prompt_tokens || 0), 0), output: mine.reduce((a, c) => a + (c.completion_tokens || 0), 0),
      cacheRead: 0, cacheWrite: 0, context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    };
  });
}

module.exports = { ollamaChatSessions, ollamaRunSessions, ollamaProxySessions, replyToChat };
