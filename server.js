// Servidor do AI HUD: serve a página e /api/snapshot para iPad/Android na rede local ou no Tailscale
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { claudeSessions, codexData, antigravitySessions } = require('./lib');
const { claudeQuota, codexQuota, CODEX } = require('./quotas');
const { execFile } = require('child_process');

const PORT = Number(process.env.AI_HUD_PORT) || 8787;
const QUOTA_EVERY_MS = 5 * 60 * 1000;
const QUOTA_BUSY_MS = 60 * 1000;
const ACTIVE_MS = 2 * 60 * 1000;   // log mexido há menos disso: trabalhando
const RECENT_MS = 30 * 60 * 1000;  // até isso: sessão aberta, ociosa

// Token de acesso, gerado na primeira execução
const configFile = path.join(__dirname, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
// O HUD envia respostas às sessões (executam comandos no PC): PIN de 8 dígitos
if (!config.token || !config.pin || config.pin.length < 8) {
  config.token = config.token || crypto.randomBytes(12).toString('hex');
  config.pin = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

// PIN para digitar no aparelho; troca pelo token. 5 erros bloqueiam o IP por 5 min,
// e 20 erros de qualquer origem bloqueiam o login por 15 min (contra quem troca de IP)
const failures = new Map();
let globalFailures = [];
function blocked(ip) {
  const f = failures.get(ip);
  globalFailures = globalFailures.filter((t) => Date.now() - t < 15 * 60e3);
  return (f && f.count >= 5 && Date.now() - f.at < 5 * 60e3) || globalFailures.length >= 20;
}
function failed(ip) {
  const f = failures.get(ip);
  failures.set(ip, { count: f && Date.now() - f.at < 5 * 60e3 ? f.count + 1 : 1, at: Date.now() });
  globalFailures.push(Date.now());
}
const loginPage = (msg) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AI HUD</title>
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="AI HUD">
<link rel="apple-touch-icon" sizes="76x76" href="/icon-76.png"><link rel="apple-touch-icon" sizes="152x152" href="/icon-152.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png"><link rel="icon" type="image/png" href="/icon-192.png">
<style>body{background:#121211;color:#ecece8;font:16px -apple-system,Roboto,sans-serif;text-align:center;padding:60px 16px}
input{font-size:28px;width:230px;text-align:center;letter-spacing:6px;padding:8px;border-radius:8px;border:1px solid #3a3a36;background:#1c1c1a;color:#ecece8}
button{font-size:17px;margin-top:16px;padding:10px 28px;border-radius:8px;border:0;background:#5fb8a4;color:#121211;font-weight:700}
p{color:#e87070}</style></head><body><h1>AI HUD</h1>
<form method="POST" action="/login"><input name="pin" type="tel" pattern="[0-9]*" maxlength="8" autofocus placeholder="PIN"><br>
<button>Entrar</button></form>${msg ? `<p>${msg}</p>` : ''}</body></html>`;

// Só loopback, redes privadas e Tailscale (100.64.0.0/10)
function allowed(addr) {
  const ip = String(addr || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const [a, b] = ip.split('.').map(Number);
  return (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || /^fd/i.test(ip);
}

// --- Cotas ---------------------------------------------------------------
// Ritmo (como CodexBar/ccburn): compara o uso com o tempo já passado da janela e projeta o reset.
// A taxa vem das leituras da última hora; sem amostras suficientes, da média desde o início da janela.
const WINDOW_MS = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 };
const historyFile = path.join(__dirname, 'quota-history.json');
let history = {};
try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {}

function record(name, q) {
  const now = Date.now();
  for (const [key, w] of Object.entries(q.windows || {})) {
    if (!w) continue;
    let h = history[`${name}.${key}`];
    // resetsAt mudou: começou uma janela nova, as amostras antigas não servem
    if (!h || Math.abs(h.resetsAt - w.resetsAt) > 60e3) h = history[`${name}.${key}`] = { resetsAt: w.resetsAt, samples: [] };
    // Guarda a janela inteira (o gráfico de 5h usa todas); ~2000 amostras numa semana a cada 5 min
    h.samples = h.samples.concat([[now, w.used]]).slice(-2500);
  }
  try { fs.writeFileSync(historyFile, JSON.stringify(history)); } catch {}
}

function pace(name, key, w, now) {
  const dur = WINDOW_MS[key];
  if (!w || !dur || !w.resetsAt) return null;
  const left = Math.max(0, w.resetsAt - now);
  const elapsed = Math.min(1, Math.max(0, 1 - left / dur));
  const samples = ((history[`${name}.${key}`] || {}).samples || []).filter((s) => now - s[0] <= 3600e3);
  let rate = null, basis = 'average'; // % por ms
  if (key === 'five_hour' && samples.length >= 2 && samples[samples.length - 1][0] - samples[0][0] >= 15 * 60e3) {
    const [t0, u0] = samples[0], [t1, u1] = samples[samples.length - 1];
    rate = Math.max(0, (u1 - u0) / (t1 - t0));
    basis = 'recent';
  } else if (elapsed > 0.1) { // antes disso uma única chamada grande distorce a projeção
    rate = w.used / (elapsed * dur);
  }
  const projected = rate == null ? null : Math.round(w.used + rate * left);
  const runsOutIn = rate > 0 && w.used < 100 && projected >= 100 ? Math.round((100 - w.used) / rate) : null;
  return { expected: Math.round(elapsed * 100), projected, runsOutIn, basis };
}

// Burn-up da janela de 5h: % usado ao longo da janela, para o gráfico com projeção até o reset
function burn(now, codexSessions) {
  const out = {};
  for (const name of ['claude', 'codex']) {
    const w = quotas[name] && quotas[name].windows && quotas[name].windows.five_hour;
    if (!w || !w.resetsAt) continue;
    const start = w.resetsAt - WINDOW_MS.five_hour;
    let points = ((history[`${name}.five_hour`] || {}).samples || []).filter((s) => s[0] >= start);
    if (name === 'codex') {
      for (const s of codexSessions) {
        for (const [t, used, resetsAt] of s.limitSamples || []) {
          if (t >= start && Math.abs(resetsAt - w.resetsAt) < 60e3) points.push([t, used]);
        }
      }
    }
    points = [[start, 0], ...points].sort((a, b) => a[0] - b[0]);
    // Uma amostra por ~3 min basta para o desenho
    const thin = [];
    for (const p of points) if (!thin.length || p[0] - thin[thin.length - 1][0] >= 180e3) thin.push(p);
    thin.push([Math.min(now, w.resetsAt), w.used]);
    const p = pace(name, 'five_hour', w, now);
    out[name] = { start, end: w.resetsAt, used: w.used, points: thin, projected: p && p.projected, runsOutIn: p && p.runsOutIn };
  }
  return out;
}

function quotasView(now) {
  const out = {};
  for (const [name, q] of Object.entries(quotas)) {
    if (!q) { out[name] = null; continue; }
    const windows = {};
    for (const [key, w] of Object.entries(q.windows || {})) windows[key] = w && { ...w, pace: pace(name, key, w, now) };
    out[name] = { ...q, windows };
  }
  return out;
}
const quotas = { claude: null, codex: null };
async function refresh(name, fn) {
  const prev = quotas[name] || {};
  try {
    quotas[name] = { ...(await fn()), at: Date.now(), error: null };
    record(name, quotas[name]);
  } catch (e) {
    quotas[name] = { ...prev, error: e.message, errorAt: Date.now() };
  }
}
let lastRefresh = 0;
function refreshQuotas() {
  lastRefresh = Date.now();
  return Promise.all([refresh('claude', claudeQuota), refresh('codex', codexQuota)]);
}
refreshQuotas();
// Com alguma sessão trabalhando, lê a cada 1 min (o gráfico da janela de 5h fica mais detalhado)
setInterval(() => {
  const now = Date.now();
  let busy = false;
  try { busy = allSessions().some((s) => !s.subagent && state(s, now) === 'working'); } catch {}
  if (now - lastRefresh >= (busy ? QUOTA_BUSY_MS : QUOTA_EVERY_MS)) refreshQuotas();
}, 30e3);

// --- Snapshot ------------------------------------------------------------
const base = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');

// O log do Claude não traz o tamanho da janela de contexto: usa o que a statusline viu para a
// sessão, senão o modelo configurado ([1m] = 1M tokens), senão 200k
function claudeWindow(s) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const sl = read(path.join(__dirname, 'last-statusline.json'));
  if (sl.session_id === s.id && sl.context_window && sl.context_window.context_window_size) return sl.context_window.context_window_size;
  const model = String(read(path.join(os.homedir(), '.claude', 'settings.json')).model || '');
  return model.includes('[1m]') || s.context > 200e3 ? 1e6 : 200e3;
}

const ORDER = { permission: -1, waiting: 0, working: 1, idle: 2, closed: 3 };

// --- Respostas rápidas ---------------------------------------------------
// O HUD enfileira uma resposta por sessão; o hook-stop.js de cada sessão parada busca a cada 2 s.
// A chave é o id que o próprio CLI passa ao hook: Claude = nome do .jsonl, Codex = uuid no fim do rollout.
const replyKey = (s) => (s.tool === 'Codex' ? s.id.slice(-36) : s.id);
// A fila fica em disco: um reinício do servidor não perde respostas ainda não entregues
const repliesFile = path.join(__dirname, 'replies.json');
const replies = new Map();   // chave -> { text, at }
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(repliesFile, 'utf8')))) replies.set(k, v); } catch {}
function saveReplies() {
  try { fs.writeFileSync(repliesFile, JSON.stringify(Object.fromEntries(replies))); } catch {}
}
const listening = new Map(); // chave -> { tool, until, seen }
function listenState(key, now) {
  const l = listening.get(key);
  // Hook encerrado sem avisar (Esc, sessão fechada): some se parar de consultar
  if (!l || l.until < now || now - l.seen > 15e3) { listening.delete(key); return null; }
  return l.until;
}
// --- Permissões no modo remoto -------------------------------------------
// Ligado pelo HUD quando o usuário sai do PC: o hook-permission.js segura cada pedido de permissão
// do Claude até Permitir/Negar no HUD. Desligado, o hook sai na hora e o pedido aparece no PC.
let remoteMode = !!config.remoteMode;
const permissions = new Map(); // id -> { session, tool, summary, at, decision, seen }
function pendingPermission(key, now) {
  for (const [id, p] of permissions) {
    if (now - p.seen > 15e3) { permissions.delete(id); continue; } // hook encerrou (respondido no PC, Esc, timeout)
    if (p.session === key && !p.decision) return { id, tool: p.tool, summary: p.summary, at: p.at };
  }
  return null;
}

function replyInfo(s, now) {
  const key = replyKey(s), q = replies.get(key);
  return { key, listening: listenState(key, now), queued: q ? q.text : null, permission: pendingPermission(key, now) };
}

// --- Abrir no PC ---------------------------------------------------------
// Foca a janela da sessão (focus.ps1) e, no VS Code, abre a aba da sessão pelo link da extensão.
// O link vai para a última janela ativa: só é enviado depois de focar a janela certa.
const VSCODE_STORAGE = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'storage.json');
const winPath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const noPipe = (t) => String(t || '').replace(/\|/g, ' ');

function vscodeFolders() {
  try {
    const w = JSON.parse(fs.readFileSync(VSCODE_STORAGE, 'utf8')).windowsState || {};
    return [w.lastActiveWindow, ...(w.openedWindows || [])]
      .filter((x) => x && x.folder && x.folder.startsWith('file:///'))
      .map((x) => winPath(decodeURIComponent(x.folder.slice(8))));
  } catch { return []; }
}

// App do Claude: cada sessão tem um local_<uuid>.json cujo cliSessionId é o id do log
function claudeDesktopId(cliId) {
  const root = path.join(process.env.APPDATA || '', 'Claude', 'claude-code-sessions');
  try {
    for (const org of fs.readdirSync(root)) {
      for (const acct of fs.readdirSync(path.join(root, org))) {
        const dir = path.join(root, org, acct);
        for (const f of fs.readdirSync(dir)) {
          if (!/^local_[0-9a-f-]{36}\.json$/.test(f)) continue;
          try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (m.cliSessionId === cliId && !m.isArchived) return m.sessionId;
          } catch {}
        }
      }
    }
  } catch {}
  return null;
}

function focusPlan(s) {
  const key = replyKey(s);
  if (s.where === 'claude-desktop') {
    const local = claudeDesktopId(s.id);
    if (!local) return null;
    // O link abre a conversa no app; depois traz a janela do app para frente
    return { uriFirst: true, uri: `claude://claude.ai/epitaxy/${local}`, process: 'claude', include: 'Claude', exclude: '', label: 'Sessão aberta no app do Claude.' };
  }
  const folders = [...new Set(vscodeFolders())];
  const cwd = winPath(s.cwd);
  const own = folders.filter((f) => cwd === f || cwd.startsWith(f + '\\')).sort((a, b) => b.length - a.length)[0];
  const title = (f) => `${path.win32.basename(f)} - Visual Studio Code`;
  // CLI rodando no terminal integrado do VS Code: a janela é a do VS Code daquela pasta
  // (não há link para a aba do terminal, então só foca a janela)
  if (s.where === 'terminal' && own) return { process: 'Code', include: noPipe(title(own)), exclude: '', label: 'Janela do VS Code em primeiro plano (terminal integrado).' };
  if (s.where === 'vscode') {
    return {
      process: 'Code',
      // Janela sem pasta (ex.: sessão na pasta do usuário): a do VS Code que não é de nenhuma pasta aberta
      include: own ? noPipe(title(own)) : 'Visual Studio Code',
      exclude: own ? '' : folders.map((f) => noPipe(title(f))).join('|'),
      uri: s.tool === 'Codex' ? `vscode://openai.chatgpt/local/${key}` : `vscode://anthropic.claude-code/open?session=${key}`,
    };
  }
  if (s.where === 'terminal') {
    // O Claude põe o título da sessão no título do terminal; senão a pasta; senão qualquer terminal
    return { process: 'WindowsTerminal|pwsh|powershell|cmd', include: [noPipe((s.title || '').slice(0, 24)), noPipe(base(s.cwd)), ''].join('|'), exclude: '' };
  }
  return null;
}

function focusWindow(plan) {
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-File', path.join(__dirname, 'focus.ps1'), '-Process', plan.process,
    '-Include', plan.include, '-Exclude', plan.exclude], { windowsHide: true, timeout: 20e3 },
  (err, out) => resolve(String(out || '').trim().startsWith('ok'))));
}
const openUri = (uri) => new Promise((resolve) => execFile('explorer.exe', [uri], { windowsHide: true }, () => resolve()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function focusSession(s) {
  const plan = focusPlan(s);
  if (!plan) {
    return { ok: false, message: s.where === 'claude-desktop' ? 'Essa sessão não está mais no app do Claude.'
      : 'Abrir no PC funciona para sessões no VS Code, no terminal ou no app do Claude.' };
  }
  // App do Claude: o link abre a conversa (e o app, se fechado); depois só garante a janela na frente
  if (plan.uriFirst) {
    await openUri(plan.uri);
    await wait(800);
    await focusWindow(plan);
    return { ok: true, message: plan.label };
  }
  if (!(await focusWindow(plan))) return { ok: false, message: `Nenhuma janela aberta no PC para ${base(s.cwd) || 'esta sessão'}.` };
  if (!plan.uri) return { ok: true, message: plan.label || 'Janela em primeiro plano.' };
  // VS Code: o link vai para a última janela ativa; dá tempo de registrar o foco antes
  await wait(500);
  await openUri(plan.uri);
  return { ok: true, message: 'Sessão aberta no VS Code.' };
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size < 20e3) chunks.push(c); });
    // Junta os bytes antes de decodificar: um acento pode vir partido entre dois pacotes
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({}); } });
  });
}

const allSessions = () => {
  const claude = claudeSessions();
  for (const s of claude) if (!s.contextWindow) s.contextWindow = claudeWindow(s);
  return [...claude, ...codexData().sessions, ...antigravitySessions()];
};

// Atividade pelo último registro do log: no Windows a data de modificação de um arquivo
// mantido aberto (Codex retomando uma sessão antiga) só atualiza quando ele é fechado
function state(s, now) {
  const idle = now - Math.max(s.mtime || 0, Date.parse(s.end) || 0);
  if (idle < ACTIVE_MS && s.lastStop !== 'end_turn') return 'working';
  if (idle >= RECENT_MS) return 'closed';
  // Terminou o turno e está parada: é a vez do usuário
  return s.lastStop === 'end_turn' ? 'waiting' : 'idle';
}

// Tudo o que a tela de detalhe mostra ao tocar numa sessão
function sessionDetail(id) {
  const s = allSessions().find((x) => x.id === id && !x.subagent);
  if (!s) return null;
  const now = Date.now();
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    tool: s.tool, id: s.id, title: s.title || s.firstPrompt, project: base(s.cwd) || '—', cwd: s.cwd,
    models: [...s.models], start: Date.parse(s.start), end: Date.parse(s.end), state: state(s, now), now,
    input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
    context: s.context, contextWindow: s.contextWindow, prompts: s.prompts, toolCalls: s.toolCalls,
    lastTool: s.lastTool, tools, lastPrompt: s.lastPrompt, lastReply: s.lastReply,
    subagents: s.subagents || 0, subTokens: s.subTokens || 0, ...replyInfo(s, now), where: s.where || '',
    turns: s.events.slice(-10).reverse().map((e) => ({ t: Date.parse(e.ts), fresh: e.fresh, cacheRead: e.cacheRead })),
  };
}

function snapshot() {
  const now = Date.now();
  // Uma janela acabou de virar: relê na hora em vez de esperar o próximo ciclo de 5 min
  const expired = Object.values(quotas).some((q) => q && Object.values(q.windows || {}).some((w) => w && w.resetsAt < now));
  if (expired && now - lastRefresh > 60e3) refreshQuotas();
  const all = allSessions();

  // Tokens por hora nas últimas 24h (inclui subagentes: é uso real)
  const hourMs = 3600e3;
  const firstHour = Math.floor(now / hourMs) * hourMs - 23 * hourMs;
  const hours = Array.from({ length: 24 }, (_, i) => ({ t: firstHour + i * hourMs, 'Claude Code': 0, Codex: 0 }));
  const today = { 'Claude Code': { fresh: 0, cacheRead: 0 }, Codex: { fresh: 0, cacheRead: 0 } };
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  // Tokens por dia nos últimos 7 dias (meia-noite local de cada dia)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(midnight); d.setDate(d.getDate() - 6 + i);
    return { t: d.getTime(), 'Claude Code': 0, Codex: 0 };
  });
  const sessionsToday = { 'Claude Code': 0, Codex: 0, Antigravity: 0 };
  for (const s of all) {
    if (!s.subagent && Date.parse(s.end) >= midnight.getTime()) sessionsToday[s.tool]++;
    for (const e of s.events) {
      const t = Date.parse(e.ts);
      const i = Math.floor((t - firstHour) / hourMs);
      if (i >= 0 && i < 24) hours[i][s.tool] += e.fresh;
      if (t >= midnight.getTime()) { today[s.tool].fresh += e.fresh; today[s.tool].cacheRead += e.cacheRead; }
      for (let d = days.length - 1; d >= 0; d--) if (t >= days[d].t) { days[d][s.tool] += e.fresh; break; }
    }
  }

  const view = (s) => ({
    tool: s.tool, id: s.id, project: base(s.cwd) || '—', title: s.title || s.firstPrompt,
    start: Date.parse(s.start), end: Date.parse(s.end), state: state(s, now), lastTool: s.lastTool,
    tokens: s.input + s.output + s.cacheWrite + (s.subTokens || 0), prompts: s.prompts,
    lastPrompt: (s.lastPrompt || '').replace(/\s+/g, ' ').slice(0, 160),
    context: s.context, contextWindow: s.contextWindow, ...replyInfo(s, now),
  });
  const sessions = all.filter((s) => !s.subagent).map(view).sort((a, b) => b.end - a.end);
  // Uma sessão ouvindo respostas está parada esperando o usuário, mesmo que o log pareça antigo
  for (const v of sessions) if (v.listening && v.state === 'closed') v.state = 'waiting';
  // Pedido de permissão aberto: a sessão está parada esperando o usuário
  for (const v of sessions) if (v.permission) v.state = 'permission';

  return {
    now, remoteMode, quotas: quotasView(now), hours, days, today, sessionsToday,
    burn: burn(now, all.filter((s) => s.tool === 'Codex')),
    // Quem espera por você primeiro, depois quem trabalha (como no agent-hud)
    active: sessions.filter((s) => s.state !== 'closed')
      .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.end - a.end),
    recent: sessions.filter((s) => s.state === 'closed').slice(0, 20),
  };
}

// --- HTTP ----------------------------------------------------------------
const page = path.join(__dirname, 'public', 'index.html');

// Ícones oficiais que as extensões do VS Code já trazem, pintados nas cores do HUD (só para esta rede)
function extensionIcon(prefix, file, color) {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const latest = fs.readdirSync(dir).filter((d) => d.startsWith(prefix))
      .map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    const svg = fs.readFileSync(path.join(dir, latest.d, 'resources', file), 'utf8');
    return svg.replace(/fill="(?!none)[^"]*"/g, `fill="${color}"`);
  } catch { return null; }
}
const BRANDS = {
  '/brand-claude.svg': extensionIcon('anthropic.claude-code-', 'claude-logo.svg', '#e08a66'),
  '/brand-codex.svg': extensionIcon('openai.chatgpt-', 'blossom-white.svg', '#5fb8a4'),
};
const PUBLIC_ASSETS = {
  '/manifest.json': 'application/manifest+json', '/sw.js': 'text/javascript; charset=utf-8',
  '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-180.png': 'image/png',
  '/icon-152.png': 'image/png', '/icon-120.png': 'image/png', '/icon-76.png': 'image/png',
  '/app.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8',
};

function authorized(req, url) {
  const cookie = /(?:^|;\s*)hud=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const token = url.searchParams.get('t') || (cookie && cookie[1]) || '';
  return token.length === config.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.token));
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (!allowed(req.socket.remoteAddress)) return send(res, 403, 'text/plain', 'proibido');
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;
  // Registro de acessos vindos de outros aparelhos (diagnóstico); só o caminho, nunca o token da query
  if (!/^(::1|127\.|::ffff:127\.)/.test(ip) && !url.pathname.startsWith('/hook/')) {
    console.log(`${new Date().toLocaleTimeString('pt-BR')} ${String(ip).replace(/^::ffff:/, '')} ${req.method} ${url.pathname}`);
  }
  // Arquivos do PWA não têm segredo; o navegador os busca sem cookie
  if (BRANDS[url.pathname]) return send(res, 200, 'image/svg+xml', BRANDS[url.pathname], { 'Cache-Control': 'max-age=86400' });
  // O iOS também procura o ícone nesses endereços fixos, mesmo sem <link> na página
  if (url.pathname === '/apple-touch-icon.png' || url.pathname === '/apple-touch-icon-precomposed.png' || url.pathname === '/favicon.ico') {
    return send(res, 200, 'image/png', fs.readFileSync(path.join(__dirname, 'public', 'icon-180.png')));
  }
  const asset = PUBLIC_ASSETS[url.pathname];
  if (asset) return send(res, 200, asset, fs.readFileSync(path.join(__dirname, 'public', url.pathname)),
    url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {});
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { if (body.length < 200) body += c; });
    return req.on('end', () => {
      if (blocked(ip)) return send(res, 429, 'text/html; charset=utf-8', loginPage('Muitas tentativas. Aguarde 5 minutos.'));
      if (new URLSearchParams(body).get('pin') !== config.pin) {
        failed(ip);
        return send(res, 401, 'text/html; charset=utf-8', loginPage('PIN incorreto.'));
      }
      failures.delete(ip);
      // O token vai na URL para sobreviver ao "Adicionar à Tela de Início" (cookies separados no iOS)
      send(res, 303, 'text/plain', '', { Location: `/?t=${config.token}` });
    });
  }
  if (!authorized(req, url)) {
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', loginPage(''));
    return send(res, 401, 'text/plain; charset=utf-8', 'acesso negado');
  }
  const cookie = { 'Set-Cookie': `hud=${config.token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` };

  if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(page), cookie);
  if (url.pathname === '/api/snapshot') return send(res, 200, 'application/json', JSON.stringify(snapshot()));
  // Resposta rápida do HUD. Codex: fila nativa (`codex queue`), que a extensão do VS Code atende sozinha.
  // Claude: fila do HUD, entregue pelo hook-stop.js da sessão (substitui a anterior; "" cancela).
  if (url.pathname === '/api/reply' && req.method === 'POST') {
    return readJson(req).then(({ key, text, tool }) => {
      if (!key || typeof key !== 'string') return send(res, 400, 'text/plain', 'sessão inválida');
      text = String(text || '').trim().slice(0, 4000);
      if (tool === 'Codex') {
        if (!/^[0-9a-f-]{36}$/.test(key) || !text) return send(res, 400, 'text/plain', 'sessão inválida');
        // --message=… : um texto começando com "-" não vira opção
        return execFile(CODEX, ['queue', '--thread', key, `--message=${text}`], { windowsHide: true, timeout: 60e3 }, (err, out, errOut) => {
          if (err) return send(res, 502, 'text/plain; charset=utf-8', String(errOut || err.message).slice(0, 300));
          send(res, 200, 'application/json', JSON.stringify({ sent: true }));
        });
      }
      if (text) replies.set(key, { text, at: Date.now() }); else replies.delete(key);
      saveReplies();
      send(res, 200, 'application/json', JSON.stringify({ queued: text || null, listening: listenState(key, Date.now()) }));
    });
  }
  if (url.pathname === '/api/remote' && req.method === 'POST') {
    return readJson(req).then(({ on }) => {
      remoteMode = !!on;
      config.remoteMode = remoteMode;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      // Desligou: pedidos em espera voltam para o PC na próxima consulta do hook
      if (!remoteMode) for (const p of permissions.values()) if (!p.decision) p.decision = 'release';
      send(res, 200, 'application/json', JSON.stringify({ remoteMode }));
    });
  }
  if (url.pathname === '/api/permission' && req.method === 'POST') {
    return readJson(req).then(({ id, decision }) => {
      const p = permissions.get(id);
      if (!p || p.decision) return send(res, 410, 'text/plain; charset=utf-8', 'Esse pedido já foi respondido ou expirou.');
      if (decision !== 'allow' && decision !== 'deny') return send(res, 400, 'text/plain', 'decisão inválida');
      p.decision = decision;
      send(res, 200, 'application/json', '{}');
    });
  }
  // Rotas do hook-permission.js
  if (url.pathname === '/hook/permission' && req.method === 'POST') {
    return readJson(req).then(({ session, tool, summary }) => {
      if (!remoteMode || !session) return send(res, 200, 'application/json', '{"hold":false}');
      const id = crypto.randomBytes(8).toString('hex');
      permissions.set(id, { session, tool: String(tool || ''), summary: String(summary || ''), at: Date.now(), decision: null, seen: Date.now() });
      send(res, 200, 'application/json', JSON.stringify({ hold: true, id }));
    });
  }
  if (url.pathname === '/hook/permission' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const p = permissions.get(id);
    if (!p) return send(res, 200, 'application/json', '{"gone":true}');
    p.seen = Date.now();
    if (p.decision === 'release') { permissions.delete(id); return send(res, 200, 'application/json', '{"gone":true}'); }
    if (p.decision) permissions.delete(id);
    return send(res, 200, 'application/json', JSON.stringify({ decision: p.decision }));
  }
  if (url.pathname === '/hook/permission-expire' && req.method === 'POST') {
    return readJson(req).then(({ id }) => { permissions.delete(id); send(res, 200, 'application/json', '{}'); });
  }
  if (url.pathname === '/api/focus' && req.method === 'POST') {
    return readJson(req).then(async ({ id }) => {
      const s = allSessions().find((x) => x.id === id && !x.subagent);
      if (!s) return send(res, 404, 'text/plain', 'sessão não encontrada');
      send(res, 200, 'application/json', JSON.stringify(await focusSession(s)));
    });
  }
  // Rotas do hook-stop.js (mesmo PC, mesmo token)
  if (url.pathname === '/hook/listen' && req.method === 'POST') {
    return readJson(req).then(({ session, tool, until }) => {
      if (session) listening.set(session, { tool, until: Number(until) || Date.now() + 30 * 60e3, seen: Date.now() });
      send(res, 200, 'application/json', '{}');
    });
  }
  if (url.pathname === '/hook/unlisten' && req.method === 'POST') {
    return readJson(req).then(({ session }) => { listening.delete(session); send(res, 200, 'application/json', '{}'); });
  }
  if (url.pathname === '/hook/next') {
    const key = url.searchParams.get('session') || '';
    const l = listening.get(key);
    if (l) l.seen = Date.now();
    const q = replies.get(key);
    if (!q) return send(res, 204, 'application/json', '');
    replies.delete(key);
    saveReplies();
    listening.delete(key);
    return send(res, 200, 'application/json', JSON.stringify({ text: q.text }));
  }
  if (url.pathname === '/api/session') {
    const d = sessionDetail(url.searchParams.get('id') || '');
    return d ? send(res, 200, 'application/json', JSON.stringify(d)) : send(res, 404, 'text/plain', 'sessão não encontrada');
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    if (Date.now() - lastRefresh < 30e3) return send(res, 429, 'text/plain', 'aguarde');
    return refreshQuotas().then(() => send(res, 200, 'application/json', JSON.stringify(snapshot())));
  }
  send(res, 404, 'text/plain', 'não encontrado');
});
// A página consulta a cada 10 s: manter a conexão aberta evita um novo handshake a cada vez
// (caro no Wi-Fi em economia de energia do iPad)
server.keepAliveTimeout = 65e3;
server.headersTimeout = 70e3;
server.listen(PORT, '0.0.0.0', () => {
  snapshot(); // aquece o cache de logs: a primeira leitura de todos os arquivos leva ~1,5 s
  console.log(`AI HUD na porta ${PORT} · PIN ${config.pin}. Abra em um destes endereços:`);
  // Pelo nome (mDNS do Windows) o endereço não muda quando o roteador troca o IP do PC
  console.log(`  http://${os.hostname()}.local:${PORT}  (pelo nome, recomendado)`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${PORT}`);
  }
});
