// Hook "Stop" do Antigravity (IDE / Antigravity 2.0):
// Como o hook Stop do Antigravity é síncrono (bloqueia a caixa de entrada da IDE exibindo
// "na fila / enviar agora" enquanto fica esperando), este hook NÃO segura o turno:
//   - Verifica em 0 ms se já existe mensagem enfileirada pelo celular/iPad durante o turno e entrega na hora.
//   - Caso contrário, sai imediatamente (< 50 ms) deixando o app Antigravity 100% livre no PC.
//   - Para conversar ao vivo pelo celular/iPad com Gemini sem bloqueio, use sessões `+ Nova -> Gemini`
//     ou `Handoff -> Gemini` (que usam o `agy` CLI com resposta direta via `agy --conversation`).
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.AI_HUD_PORT) || 8787;

function readToken() {
  if (process.env.AI_HUD_TOKEN) return process.env.AI_HUD_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'config.json'), 'utf8')).token || '';
  } catch { return ''; }
}

function call(port, token, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      timeout: 1500,
      path: `${route}${route.includes('?') ? '&' : '?'}t=${token}`,
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function isCliExecution(input) {
  const tp = String((input && input.transcriptPath) || '');
  const ap = String((input && input.artifactDirectoryPath) || '');
  return /antigravity-cli/i.test(tp) || /antigravity-cli/i.test(ap);
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

  // Só entrega se já houver mensagem enfileirada (0 ms); nunca bloqueia o app Antigravity
  try {
    const r = await call(PORT, token, 'GET', `/hook/next?session=${encodeURIComponent(session)}`);
    if (r.status === 200 && r.json && r.json.text) {
      return writeOut({ decision: 'continue', reason: r.json.text });
    }
  } catch {}
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

module.exports = { isCliExecution };
