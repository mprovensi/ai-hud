// Hook "PermissionRequest" do Claude Code: só no "modo remoto" do AI HUD (usuário longe do PC),
// segura o pedido de permissão até 10 min esperando Permitir/Negar pelo iPad/Android.
// Fora do modo remoto (ou com o HUD desligado) sai na hora e o pedido aparece normalmente no PC.
//   uso: node hook-permission.js   (JSON do evento chega pelo stdin)
const fs = require('fs');
const path = require('path');
const http = require('http');

const WAIT_MS = 10 * 60e3;
const POLL_MS = 1500;
const PORT = Number(process.env.AI_HUD_PORT) || 8787;

if (/^sdk|^ai-hud/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '')) process.exit(0);

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

// Resumo legível do que a ferramenta quer fazer
function summary(tool, input) {
  input = input || {};
  const text = input.command || input.file_path || input.url || input.pattern || input.prompt || JSON.stringify(input);
  return String(text).slice(0, 400);
}

async function main(input) {
  if (!input.session_id || !input.tool_name) return;
  let open;
  try {
    open = await call('POST', '/hook/permission', { session: input.session_id, tool: input.tool_name, summary: summary(input.tool_name, input.tool_input) });
  } catch { return; }
  if (!open.json || !open.json.hold) return; // modo remoto desligado: segue o fluxo normal no PC

  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    let r;
    try { r = await call('GET', `/hook/permission?id=${encodeURIComponent(open.json.id)}`); } catch { return; }
    const decision = r.json && r.json.decision;
    if (decision === 'allow' || decision === 'deny') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
        decision: decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Negado pelo usuário no AI HUD.' } } }));
      return;
    }
    if (!r.json || r.json.gone) return; // pedido cancelado (modo remoto desligado no meio)
  }
  try { await call('POST', '/hook/permission-expire', { id: open.json.id }); } catch {}
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  main(input).then(() => process.exit(0), () => process.exit(0));
});
