// Hook "Stop" do Antigravity (IDE / Antigravity 2.0) — 100% automático, sem precisar de botão:
//   - Entrega imediatamente (0 ms) qualquer mensagem já enfileirada pelo celular/iPad.
//   - Fica escutando por até 30 min (`● ao vivo` no AI HUD) para respostas vindas do celular/iPad.
//   - No Windows, um monitor leve (GetForegroundWindow + GetLastInputInfo) detecta em <= 300 ms
//     quando você volta a clicar/digitar na janela do Antigravity no PC e libera o hook na hora!
//   - Execuções headless do `agy` CLI (`antigravity-cli/`), cancelamentos e erros saem na hora.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const WAIT_MS = 30 * 60e3;
const POLL_MS = 1000;
const PORT = Number(process.env.AI_HUD_PORT) || 8787;
const WATCH_SCRIPT = path.join(__dirname, '..', '..', 'platform', 'windows', 'watch-ide-input.ps1');

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

function startIdeInputWatcher(onLocalInput) {
  if (process.platform !== 'win32' || process.env.AI_HUD_NO_IDE_WATCH === '1') return null;
  if (!fs.existsSync(WATCH_SCRIPT)) return null;
  const grace = String(Number(process.env.AI_HUD_IDE_WATCH_GRACE_MS) || 2000);
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCH_SCRIPT,
      '-ProcessName', 'Antigravity', '-GraceMs', grace, '-PollMs', '250',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      if (String(chunk || '').includes('LOCAL_INPUT')) onLocalInput();
    });
    child.on('error', () => {});
    return child;
  } catch {
    return null;
  }
}

function stopWatcher(child) {
  if (!child) return;
  try { child.kill(); } catch {}
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

  // 1. Entrega imediata (0 ms) se já existe mensagem enfileirada pelo celular/iPad
  try {
    const first = await call(PORT, token, 'GET', `/hook/next?session=${encodeURIComponent(session)}`);
    if (first.status === 200 && first.json && first.json.text) {
      return writeOut({ decision: 'continue', reason: first.json.text });
    }
  } catch {
    return writeOut({});
  }

  const transcript = input.transcriptPath || '';
  let from = 0;
  try { if (transcript) from = fs.statSync(transcript).size; } catch {}

  const waitMs = Number(process.env.AI_HUD_HOOK_WAIT_MS) || WAIT_MS;
  const pollMs = Number(process.env.AI_HUD_HOOK_POLL_MS) || POLL_MS;
  const until = Date.now() + waitMs;

  try {
    const r = await call(PORT, token, 'POST', '/hook/listen', { session, tool: 'Gemini', until });
    if (r.status !== 200) return writeOut({});
  } catch { return writeOut({}); }

  let localDetected = false;
  let wake = null;
  const triggerLocal = () => {
    localDetected = true;
    if (wake) { const fn = wake; wake = null; fn(); }
  };
  const watcher = startIdeInputWatcher(triggerLocal);
  const onSig = () => { stopWatcher(watcher); process.exit(0); };
  process.once('SIGTERM', onSig);
  process.once('SIGINT', onSig);

  const waitStep = (ms) => new Promise((resolve) => {
    if (localDetected) return resolve();
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); resolve(); };
  });

  try {
    while (Date.now() < until && !localDetected) {
      try {
        const r = await call(PORT, token, 'GET', `/hook/next?session=${encodeURIComponent(session)}`);
        if (r.status === 200 && r.json && r.json.text) {
          stopWatcher(watcher);
          return writeOut({ decision: 'continue', reason: r.json.text });
        }
      } catch {
        return writeOut({});
      }
      if (localDetected || (transcript && typedLocally(transcript, from))) break;
      await waitStep(pollMs);
    }
    try { await call(PORT, token, 'POST', '/hook/unlisten', { session }); } catch {}
    return writeOut({});
  } finally {
    stopWatcher(watcher);
  }
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
