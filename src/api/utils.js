const crypto = require('crypto');

function authorized(req, url, expectedToken) {
  const cookie = /(?:^|;\s*)hud=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const token = url.searchParams.get('t') || (cookie && cookie[1]) || '';
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20e3) {
        chunks.length = 0;
        reject(requestError(413, 'corpo da requisição muito grande'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 20e3) return;
      try {
        // Decodifica depois de juntar os bytes: acentos podem atravessar pacotes.
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('objeto esperado');
        resolve(body);
      } catch {
        reject(requestError(400, 'o corpo deve ser um objeto JSON válido'));
      }
    });
    req.on('aborted', () => reject(requestError(400, 'requisição interrompida')));
    req.on('error', reject);
  });
}

// O servidor HTTP não captura exceções nem rejeições do callback por conta própria.
function handleRequest(handler) {
  return (req, res) => Promise.resolve().then(() => handler(req, res)).catch((error) => {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    const status = error.statusCode === 400 || error.statusCode === 413 ? error.statusCode : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(status === 500 ? 'erro interno do servidor' : error.message);
  });
}

// Resposta sem cache, com a versão do app (o aparelho percebe que há versão nova)
function createSend(version) {
  return function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-AI-HUD-Version': version, ...headers });
    res.end(body);
  };
}

module.exports = { authorized, readJson, handleRequest, createSend };
