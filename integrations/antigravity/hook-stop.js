// Hook "Stop" do Antigravity (IDE / Antigravity 2.0):
//   - Sempre entrega imediatamente (0 ms) qualquer mensagem que já foi enfileirada pelo celular/iPad enquanto a IA trabalhava.
//   - Como o hook Stop do Antigravity é síncrono (bloqueia novas mensagens digitadas na IDE enquanto aguarda),
//     só mantém a escuta contínua (até 30 min) quando o "Modo remoto" estiver LIGADO no AI HUD.
//   - Com Modo remoto DESLIGADO, libera a IDE na hora para você digitar normalmente no PC sem travar.
//   - Se o Modo remoto for desligado durante a espera, libera a IDE em até 2 s.
//   - Execuções headless do `agy` CLI (`antigravity-cli/`) saem imediatamente para não bloquear `--print`.
const fs = require('fs');
const path = require('path');
const http = require('http');

const WAIT_MS = 30 * 60e3;
const POLL_MS = 2000;
const PORT = Number(process.env.AI_HUD_PORT) || 8787;

function readToken() {
  if (process.env.AI_HUD_TOKEN) return process.env.AI_HUD_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'config.json'), 'utf8')).token || '';
  } catch { return ''; }
}

function call(port, token, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      timeout: 3000,
      path: `${route}${route.includes('?') ? '&' : '?'}t=${token}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, headers: res.headers || {}, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isCliExecution(input) {
  const tp = String((input && input.transcriptPath) || '');
  const ap = String((input && input.artifactDirectoryPath) || '');
  return /antigravity-cli/i.test(tp) || /antigravity-cli/i.test(ap);
}

function typedLocally(file, from) {
  try {
    const size = fs.statSync(file).size;
    if (size <= from) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return /"type"\s*:\s*"USER_INPUT"/.test(buf.toString('utf8'));
  } catch { return false; }
}

function writeOut(obj) {
  process.stdout.write(JSON.stringify(obj || {}));
}

async function main(input) {
  const session = input && input.conversationId;
  if (!session) return writeOut({});
  if (isCliExecution(input)) return writeOut({});
  const reason = String(input.terminationReason || '');
  if (reason === 'USER_CANCELED' || reason === 'ERROR') return writeOut({});

  const token = readToken();
  if (!token) return writeOut({});

  // 1. Verifica imediatamente se já existe mensagem enfileirada pelo celular/iPad (0 ms de bloqueio)
  let remoteMode = false;
  try {
    const first = await call(PORT, token, 'GET', `/hook/next?session=${encodeURIComponent(session)}`);
    if (first.status === 200 && first.json && first.json.text) {
      return writeOut({ decision: 'continue', reason: first.json.text });
    }
    remoteMode = first.headers['x-ai-hud-remote'] === '1';
  } catch {
    return writeOut({});
  }

  // 2. Com Modo remoto desligado (usuário no PC), libera a IDE imediatamente para não travar o chat local
  if (!remoteMode) return writeOut({});

  const transcript = input.transcriptPath || '';
  let from = 0;
  try { if (transcript) from = fs.statSync(transcript).size; } catch {}

  const waitMs = Number(process.env.AI_HUD_HOOK_WAIT_MS) || WAIT_MS;
  const pollMs = Number(process.env.AI_HUD_HOOK_POLL_MS) || POLL_MS;
  const until = Date.now() + waitMs;

  try {
    const r = await call(PORT, token, 'POST', '/hook/listen', { session, tool: 'Gemini', until, requireRemote: true });
    if (r.status !== 200 || (r.json && r.json.remoteMode === false)) return writeOut({});
  } catch { return writeOut({}); }

  while (Date.now() < until) {
    try {
      const r = await call(PORT, token, 'GET', `/hook/next?session=${encodeURIComponent(session)}`);
      if (r.status === 200 && r.json && r.json.text) {
        return writeOut({ decision: 'continue', reason: r.json.text });
      }
      // Se o usuário desligou o Modo remoto, libera a IDE imediatamente
      if (r.headers && r.headers['x-ai-hud-remote'] === '0') break;
    } catch { return writeOut({}); }
    if (transcript && typedLocally(transcript, from)) break;
    await sleep(pollMs);
  }
  try { await call(PORT, token, 'POST', '/hook/unlisten', { session }); } catch {}
  return writeOut({});
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let input = {};
    try { input = JSON.parse(raw); } catch {}
    main(input).then(() => process.exit(0), () => { writeOut({}); process.exit(0); });
  });
}

module.exports = { isCliExecution, typedLocally };
