// Conversas do app do Ollama (Windows) como sessões do HUD.
// Lê o banco do app (%LOCALAPPDATA%\Ollama\db.sqlite) SÓ PARA LEITURA. A API interna do app exige um
// token que só existe na memória dele, então responder pelo HUD não passa pelo app: o servidor monta o
// histórico da conversa + a mensagem nova, gera no Ollama (:11434) e guarda essa continuação em
// ollama-replies.json. Ela aparece no HUD, não no app.
const fs = require('fs');
const path = require('path');
const http = require('http');

const DB = path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'db.sqlite');
const STORE = path.join(__dirname, 'ollama-replies.json');

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
    prompts: users.length, models: new Set(model ? [model.model] : []), lastTool: generating ? 'gerando' : '',
    input: 0, output: extra.reduce((a, m) => a + (m.tokens || 0), 0), cacheRead: 0, cacheWrite: 0,
    context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    history: all, continued: extra.length > 0,
  };
}

function ollamaChatSessions() { return readChats().map(toSession); }

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
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      let j = {};
      try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const content = (j.message && j.message.content) || (j.error ? `⚠ ${j.error}` : '⚠ resposta vazia');
      entry.messages.push({ role: 'assistant', content, at: Date.now(), model, tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0) });
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
// A conversa do terminal não é gravada; só dá para mostrar que a sessão existe (modelo, desde quando),
// o último comando digitado (~/.ollama/history, compartilhado por todos os `ollama run`) e trazer o
// terminal para frente. Procura os processos a cada 15 s.
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
  let lastCmd = '', histAt = 0;
  try {
    const lines = fs.readFileSync(HISTORY, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('/'));
    lastCmd = lines.length ? lines[lines.length - 1] : '';
    histAt = fs.statSync(HISTORY).mtimeMs;
  } catch {}
  return runs.map((r) => ({
    tool: 'Ollama', id: `ollama-run-${r.pid}`, pid: r.pid, file: '', cwd: '', where: 'ollama-run',
    project: r.model, title: 'terminal · ollama run',
    start: new Date(r.start).toISOString(), end: new Date(Math.max(r.start, histAt)).toISOString(),
    // Processo aberto = sessão ativa esperando o usuário no terminal
    mtime: Date.now(), lastStop: 'end_turn',
    firstPrompt: '', lastPrompt: lastCmd.length > 400 ? lastCmd.slice(0, 399) + '…' : lastCmd, lastReply: '',
    prompts: 0, models: new Set([r.model]), lastTool: '',
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
  }));
}

module.exports = { ollamaChatSessions, ollamaRunSessions, replyToChat, available: () => !!sqlite };
