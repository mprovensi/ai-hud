// Proxy de registro para o Ollama.
//
// Escuta na porta pública do Ollama (11434), repassa tudo para o servidor real (127.0.0.1:11435) e grava
// requisição + resposta das chamadas de inferência num SQLite, independente do cliente (app, `ollama run`,
// CLIs, SDKs, curl...). Só Node 22.5+ (node:sqlite), sem dependências.
//
//   node proxy.js --spawn-ollama
//   node proxy.js --listen 0.0.0.0:11434 --upstream 127.0.0.1:11435
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATA = path.join(__dirname, '..', 'data'); // mesma pasta de dados do AI HUD, fora do git

// Endpoints de inferência que são gravados (POST). O resto só é repassado.
const LOGGED_PATHS = new Set(['/api/chat', '/api/generate', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages']);

// Cabeçalhos que não devem ser repassados entre conexões.
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers',
  'transfer-encoding', 'upgrade', 'content-length', 'expect', 'host', 'accept-encoding']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    client_ip         TEXT,
    user_agent        TEXT,
    endpoint          TEXT,
    model             TEXT,
    session_id        TEXT,
    stream            INTEGER,
    status            INTEGER,
    duration_ms       INTEGER,
    client_aborted    INTEGER DEFAULT 0,
    message_count     INTEGER,
    last_user         TEXT,
    response_text     TEXT,
    thinking          TEXT,
    tool_calls        TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    request_json      TEXT,
    response_raw      TEXT
);
CREATE INDEX IF NOT EXISTS calls_session ON calls(session_id);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE VIEW IF NOT EXISTS sessions AS
    SELECT session_id,
           MIN(ts)               AS started,
           MAX(ts)               AS last_call,
           COUNT(*)              AS calls,
           client_ip,
           GROUP_CONCAT(DISTINCT user_agent) AS clients,
           GROUP_CONCAT(DISTINCT model)      AS models,
           SUM(prompt_tokens)    AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           (SELECT last_user FROM calls c2 WHERE c2.session_id = c.session_id
             ORDER BY id LIMIT 1) AS first_question
      FROM calls c
     GROUP BY session_id;
`;

function openStore(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  return {
    insert(row) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO calls (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------- leitura das chamadas

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Troca imagens em base64 por um marcador, para o banco não explodir
function stripImages(obj) {
  if (Array.isArray(obj)) return obj.map(stripImages);
  if (isObj(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === 'images' && Array.isArray(v) ? v.map((i) => (typeof i === 'string' ? `<imagem ${i.length} chars>` : i)) : stripImages(v);
    }
    return out;
  }
  if (typeof obj === 'string' && obj.startsWith('data:') && obj.slice(0, 100).includes(';base64,')) return `<${obj.slice(0, obj.indexOf(';'))} ${obj.length} chars>`;
  return obj;
}

function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (isObj(p)) {
        const value = p.text || p.content || '';
        parts.push(typeof value === 'string' ? value : '');
      } else if (typeof p === 'string') parts.push(p);
    }
    return parts.filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

// { model, stream, count, first, last } — primeira e última pergunta do usuário
function summarizeRequest(req) {
  const model = req.model ?? null;
  const stream = req.stream ?? null;
  let messages = req.messages;
  if (messages == null && Array.isArray(req.input)) messages = req.input; // /v1/responses
  if (Array.isArray(messages)) {
    const users = messages.filter((m) => isObj(m) && m.role === 'user');
    return { model, stream, count: messages.length,
      first: users.length ? asText(users[0].content) : '', last: users.length ? asText(users[users.length - 1].content) : '' };
  }
  let prompt = req.prompt;
  if (prompt == null && typeof req.input === 'string') prompt = req.input;
  prompt = asText(prompt);
  return { model, stream, count: null, first: prompt, last: prompt };
}

// Decodifica JSON único, NDJSON (API nativa) ou SSE (API OpenAI/Anthropic)
function iterEvents(raw) {
  const text = raw.toString('utf8').trim();
  if (!text) return [];
  try { return [JSON.parse(text)]; } catch {}
  const events = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('event:') || line.startsWith(':')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line === '[DONE]') continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function summarizeResponse(raw) {
  const content = [], thinking = [], fullTools = [];
  const tools = new Map(); // índice -> { name, arguments } (streaming OpenAI)
  const usage = { prompt: null, completion: null };
  const addUsage = (p, c) => { if (p != null) usage.prompt = p; if (c != null) usage.completion = c; };

  for (const ev of iterEvents(raw)) {
    if (!isObj(ev)) continue;
    // API nativa: /api/chat e /api/generate
    if (isObj(ev.message)) {
      content.push(ev.message.content || '');
      thinking.push(ev.message.thinking || '');
      fullTools.push(...(ev.message.tool_calls || []));
    }
    if (typeof ev.response === 'string') {
      content.push(ev.response);
      thinking.push(ev.thinking || '');
    }
    addUsage(ev.prompt_eval_count, ev.eval_count);

    // API OpenAI: /v1/chat/completions e /v1/completions
    for (const ch of ev.choices || []) {
      const part = ch.delta || ch.message || {};
      if (typeof ch.text === 'string') content.push(ch.text);
      content.push(part.content || '');
      thinking.push(part.reasoning || part.reasoning_content || '');
      for (const tc of part.tool_calls || []) {
        const fn = tc.function || {};
        const index = tc.index ?? tools.size;
        if (!tools.has(index)) tools.set(index, { name: '', arguments: '' });
        const slot = tools.get(index);
        slot.name += fn.name || '';
        slot.arguments += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || '');
      }
    }
    if (isObj(ev.usage)) addUsage(ev.usage.prompt_tokens ?? ev.usage.input_tokens, ev.usage.completion_tokens ?? ev.usage.output_tokens);

    // API Anthropic (/v1/messages) e Responses (/v1/responses)
    const type = ev.type || '';
    const delta = ev.delta;
    if (type === 'content_block_delta' && isObj(delta)) {
      content.push(delta.text || '');
      thinking.push(delta.thinking || '');
    } else if (type === 'response.output_text.delta' && typeof delta === 'string') {
      content.push(delta);
    } else if ((type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') && typeof delta === 'string') {
      thinking.push(delta);
    } else if (type === 'message_start' && isObj(ev.message)) {
      addUsage((ev.message.usage || {}).input_tokens, null);
    } else if (type === 'response.completed' && isObj(ev.response)) {
      const u = ev.response.usage || {};
      addUsage(u.input_tokens, u.output_tokens);
    }
    if (ev.object === 'response' || (type === 'message' && 'content' in ev)) {
      for (const b of ev.output || ev.content || []) {
        if (!isObj(b)) continue;
        if (b.type === 'thinking') thinking.push(b.thinking || '');
        else if (b.type === 'text') content.push(b.text || '');
        for (const c of Array.isArray(b.content) ? b.content : []) {
          if (isObj(c) && (c.type === 'output_text' || c.type === 'text')) content.push(c.text || '');
        }
      }
    }
  }
  const allTools = fullTools.concat([...tools.values()]);
  return {
    response_text: content.join(''),
    thinking: thinking.join(''),
    tool_calls: allTools.length ? JSON.stringify(allTools) : null,
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
  };
}

// Data local com milissegundos e sem fuso (como o proxy em Python gravava): 2026-10-28T15:59:09.123
function localIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Mesma chave do proxy em Python (o modelo ausente vira "None"): as sessões antigas continuam agrupadas
function sessionId(ip, model, first) {
  return crypto.createHash('sha1').update(`${ip}|${model == null ? 'None' : model}|${first}`, 'utf8').digest('hex').slice(0, 16);
}

function buildRow({ ip, userAgent, endpoint, body, raw, status, started, aborted, keepRaw }) {
  let req = {};
  try { req = JSON.parse(body.length ? body.toString('utf8') : '{}'); } catch {}
  if (!isObj(req)) req = {};
  const s = summarizeRequest(req);
  return {
    ts: localIso(),
    client_ip: ip,
    user_agent: userAgent ?? null,
    endpoint,
    model: typeof s.model === 'string' ? s.model : s.model == null ? null : JSON.stringify(s.model),
    session_id: sessionId(ip, s.model, s.first),
    stream: s.stream == null ? null : s.stream ? 1 : 0,
    status,
    duration_ms: Date.now() - started,
    client_aborted: aborted ? 1 : 0,
    message_count: s.count,
    last_user: s.last,
    request_json: JSON.stringify(stripImages(req)),
    response_raw: keepRaw ? raw.toString('utf8') : null,
    ...summarizeResponse(raw),
  };
}

// ---------------------------------------------------------------- proxy

function createProxy({ upstream, store, allow = new Set(), maxCapture = 20 * 1024 * 1024, keepRaw = true, log = () => {} }) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (allow.size && !allow.has(ip)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('IP nao autorizado'); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const endpoint = new URL(req.url, 'http://x').pathname;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) headers[k] = v;
      headers.host = `${upstream.host}:${upstream.port}`;
      if (body.length || ['POST', 'PUT', 'PATCH'].includes(req.method)) headers['content-length'] = body.length;

      const logged = req.method === 'POST' && LOGGED_PATHS.has(endpoint);
      const captured = [];
      let size = 0, aborted = false, done = false;
      const up = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers }, (upRes) => {
        const out = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_HEADERS.has(k)) out[k] = v;
        // Sem Content-Length o Node responde em chunked, repassando cada pedaço assim que chega
        if (upRes.headers['content-length'] != null) out['content-length'] = upRes.headers['content-length'];
        res.writeHead(upRes.statusCode, upRes.statusMessage, out);
        upRes.on('data', (chunk) => {
          if (logged && size < maxCapture) { captured.push(chunk); size += chunk.length; }
          res.write(chunk);
        });
        upRes.on('end', () => { done = true; res.end(); finish(upRes.statusCode); });
        upRes.on('error', () => { aborted = true; res.destroy(); finish(upRes.statusCode); });
      });
      // Cliente desconectou antes do fim: fecha o upstream para o Ollama parar de gerar
      res.on('close', () => { if (!done) { aborted = true; up.destroy(); } });
      up.on('error', (e) => {
        if (res.headersSent) return;
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Ollama indisponivel em ${upstream.host}:${upstream.port}: ${e.message}`);
      });
      let recorded = false;
      function finish(status) {
        if (!logged || recorded) return;
        recorded = true;
        try {
          store.insert(buildRow({ ip, userAgent: req.headers['user-agent'], endpoint, body, raw: Buffer.concat(captured),
            status, started, aborted, keepRaw }));
        } catch (e) { log(`[erro ao gravar] ${e.message}`); } // nunca derrubar o proxy por erro de log
      }
      up.on('close', () => { if (aborted) finish(up.res ? up.res.statusCode : 0); });
      up.end(body);
    });
  });
}

// ---------------------------------------------------------------- ollama serve

function findOllama() {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') dirs.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama'));
  for (const d of dirs) { const p = path.join(d, exe); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}

// Mantém um `ollama serve` rodando só no endereço interno; reinicia 5 s depois se cair
function superviseOllama(exe, upstream, logFile, log) {
  let child = null;
  const run = () => {
    log(`iniciando ollama serve em ${upstream}`);
    const out = fs.openSync(logFile, 'a');
    child = spawn(exe, ['serve'], { env: { ...process.env, OLLAMA_HOST: upstream }, stdio: ['ignore', out, out], windowsHide: true });
    child.on('exit', () => { fs.closeSync(out); log('ollama serve saiu; reiniciando em 5s'); setTimeout(run, 5000); });
    child.on('error', (e) => log(`ollama serve: ${e.message}`));
  };
  const stop = () => { if (child && child.exitCode == null) child.kill(); };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(0); });
  run();
}

// ---------------------------------------------------------------- linha de comando

function hostPort(value, defaultHost) {
  const i = value.lastIndexOf(':');
  return { host: value.slice(0, i) || defaultHost, port: Number(value.slice(i + 1)) };
}

function parseArgs(argv) {
  const opts = { listen: '0.0.0.0:11434', upstream: '127.0.0.1:11435', db: path.join(DATA, 'ollama-conversas.sqlite'),
    spawnOllama: false, allow: '', maxCaptureMb: 20, raw: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--listen') opts.listen = next();
    else if (a === '--upstream') opts.upstream = next();
    else if (a === '--db') opts.db = next();
    else if (a === '--spawn-ollama') opts.spawnOllama = true;
    else if (a === '--allow') opts.allow = next();
    else if (a === '--max-capture-mb') opts.maxCaptureMb = Number(next());
    else if (a === '--no-raw') opts.raw = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`opção desconhecida: ${a}`);
  }
  return opts;
}

const HELP = `node proxy.js [opções]
  --listen HOST:PORTA     endereço público (padrão 0.0.0.0:11434)
  --upstream HOST:PORTA   Ollama real (padrão 127.0.0.1:11435)
  --db ARQUIVO            arquivo SQLite (padrão data/ollama-conversas.sqlite)
  --spawn-ollama          inicia e supervisiona o \`ollama serve\` no upstream
  --allow IP,IP           IPs permitidos (vazio = todos)
  --max-capture-mb N      limite de resposta gravada por chamada (padrão 20)
  --no-raw                não guardar a resposta bruta (só o texto montado)`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  // Sem console (tarefa agendada): o registro vai para data/ollama-proxy.log
  const logFile = process.stderr.isTTY ? null : path.join(DATA, 'ollama-proxy.log');
  if (logFile) fs.mkdirSync(DATA, { recursive: true });
  const log = (msg) => (logFile ? fs.appendFileSync(logFile, `${localIso()} ${msg}\n`) : console.error(msg));

  const listen = hostPort(opts.listen, '0.0.0.0');
  const upstream = hostPort(opts.upstream, '127.0.0.1');
  const store = openStore(opts.db);
  if (opts.spawnOllama) {
    const exe = findOllama();
    if (!exe) { log('ollama não encontrado'); process.exit(1); }
    fs.mkdirSync(DATA, { recursive: true });
    superviseOllama(exe, `${upstream.host}:${upstream.port}`, path.join(DATA, 'ollama-server.log'), log);
  }
  const allow = new Set(opts.allow.split(',').map((ip) => ip.trim()).filter(Boolean));
  createProxy({ upstream, store, allow, maxCapture: opts.maxCaptureMb * 1024 * 1024, keepRaw: opts.raw, log })
    .listen(listen.port, listen.host, () => log(`proxy ${listen.host}:${listen.port} -> ${upstream.host}:${upstream.port}  gravando em ${opts.db}`));
}

if (require.main === module) main();

module.exports = { createProxy, openStore, summarizeRequest, summarizeResponse, iterEvents, stripImages, asText, sessionId, buildRow };
