// Chamada HTTP a outro PC do HUD, pela mesma API pública que os aparelhos usam (token na URL).
// Resolve { status, json, text }; rejeita se o PC não responder.
const http = require('http');

function call(peer, method, route, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, peer.url);
    url.searchParams.set('t', peer.token);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(url, { method, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { call };
