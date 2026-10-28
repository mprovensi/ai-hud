// Hook "Stop" do Claude Code e do Codex: ao fim de cada turno espera até 30 min por uma resposta
// enviada pelo AI HUD (iPad/Android). Se chegar, devolve {"decision":"block","reason":<texto>} e a
// sessão continua com o texto como novo pedido. Libera na hora se o HUD estiver fora do ar ou se o
// usuário digitar algo no próprio PC.
//   uso: node hook-stop.js claude|codex   (JSON do evento chega pelo stdin)
const fs = require('fs');
const path = require('path');
const http = require('http');

const WAIT_MS = 30 * 60e3;
const POLL_MS = 2000;
const PORT = Number(process.env.AI_HUD_PORT) || 8787;
const tool = process.argv[2] === 'codex' ? 'Codex' : 'Claude Code';

// Execuções sem tela (claude -p, SDK, o leitor de cotas do HUD) não têm ninguém para responder
const entry = process.env.CLAUDE_CODE_ENTRYPOINT || '';
if (/^sdk|^ai-hud/.test(entry)) process.exit(0);

let token = '';
try { token = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8')).token; } catch { process.exit(0); }

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: PORT, method, timeout: 3000,
      path: `${route}${route.includes('?') ? '&' : '?'}t=${token}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// O usuário digitou no PC enquanto o hook esperava: Claude registra "queue-operation enqueue",
// Codex um "user_message". Nesse caso libera o turno para a mensagem local seguir.
function typedLocally(file, from) {
  try {
    const size = fs.statSync(file).size;
    if (size <= from) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return /"operation":"enqueue"|"type":"user_message"/.test(buf.toString('utf8'));
  } catch { return false; }
}

async function main(input) {
  const session = input.session_id;
  if (!session) return;
  const transcript = input.transcript_path;
  let from = 0;
  try { from = fs.statSync(transcript).size; } catch {}
  const until = Date.now() + WAIT_MS;
  try {
    const r = await call('POST', '/hook/listen', { session, tool, until });
    if (r.status !== 200) return;
  } catch { return; } // HUD fora do ar: não segura a sessão

  while (Date.now() < until) {
    try {
      const r = await call('GET', `/hook/next?session=${encodeURIComponent(session)}`);
      if (r.status === 200 && r.json && r.json.text) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: r.json.text }));
        return;
      }
    } catch { return; }
    if (transcript && typedLocally(transcript, from)) break;
    await sleep(POLL_MS);
  }
  try { await call('POST', '/hook/unlisten', { session }); } catch {}
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  main(input).then(() => process.exit(0), () => process.exit(0));
});
