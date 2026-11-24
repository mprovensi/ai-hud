const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { acceptKey, encodeFrame, decodeFrames } = require('../../src/core/websocket');
const { buildInteractiveCommand } = require('../../src/actions/pty');
const { createApp } = require('../../src/main');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('websocket core: vetor oficial RFC 6455 e round-trip de frames mascarados (curtos e > 126B)', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const small = encodeFrame('olá mundo', 0x1, true);
  const largeText = 'x'.repeat(500);
  const large = encodeFrame(largeText, 0x1, true);
  const combined = Buffer.concat([small, large]);

  const { frames, rest } = decodeFrames(combined);
  assert.equal(rest.length, 0);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.toString('utf8'), 'olá mundo');
  assert.equal(frames[1].payload.toString('utf8'), largeText);
});

test('buildInteractiveCommand monta comandos interativos corretos para Claude, Codex, Gemini e Shell', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  assert.match(buildInteractiveCommand({ mode: 'resume', tool: 'Claude Code', sessionId: `m0:${uuid}`, claudeExe: 'claude' }), /claude --resume 11111111/);
  assert.match(buildInteractiveCommand({ mode: 'resume', tool: 'Codex', sessionId: uuid, codexExe: 'codex' }), /codex resume 11111111/);
  assert.match(buildInteractiveCommand({ mode: 'resume', tool: 'Gemini', sessionId: uuid, agyExe: 'agy' }), /agy --conversation 11111111/);
  assert.match(buildInteractiveCommand({ mode: 'shell', platform: 'win32' }), /powershell\.exe/i);
});

test('WebSocket /ws/pty end-to-end: bloqueia sem auth/pasta não autorizada e roda PTY real interativo', async () => {
  const dataDir = tmpDir('hud-pty-data-');
  const projOk = tmpDir('hud-pty-ok-');
  const projNo = tmpDir('hud-pty-no-');
  const token = 'a1b2c3d4e5f60718293a4b5c';

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token,
    pin: '12345678',
    name: 'TestPty',
    pinnedProjects: [projOk],
  }));

  const app = createApp({
    dataDir,
    sources: { all: () => [] },
    quotaFetchers: {},
    brands: false,
    log: () => {},
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();

  const tryUpgrade = (urlPath) => new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (res, socket, head) => resolve({ upgraded: true, res, socket, head }));
    req.on('response', (res) => { res.resume(); resolve({ upgraded: false, status: res.statusCode }); });
    req.on('error', (err) => resolve({ upgraded: false, error: err.message }));
    req.end();
  });

  try {
    // 1. Sem token -> 401
    const r401 = await tryUpgrade(`/ws/pty?cwd=${encodeURIComponent(projOk)}&mode=shell`);
    assert.equal(r401.upgraded, false);
    assert.equal(r401.status, 401);

    // 2. Pasta não autorizada -> 403
    const r403 = await tryUpgrade(`/ws/pty?t=${token}&cwd=${encodeURIComponent(projNo)}&mode=shell`);
    assert.equal(r403.upgraded, false);
    assert.equal(r403.status, 403);

    // 3. Pasta autorizada -> Upgrade 101 + PTY interativo real
    const up = await tryUpgrade(`/ws/pty?t=${token}&cwd=${encodeURIComponent(projOk)}&mode=shell&key=test-shell`);
    assert.equal(up.upgraded, true);

    const output = await new Promise((resolve, reject) => {
      let rx = up.head ? Buffer.from(up.head) : Buffer.alloc(0);
      let text = '';
      let sent = false;
      const timer = setTimeout(() => {
        up.socket.destroy();
        reject(new Error(`Timeout aguardando saída do PTY. Recebido até agora: ${JSON.stringify(text.slice(-200))}`));
      }, 15000);

      up.socket.on('data', (chunk) => {
        rx = Buffer.concat([rx, chunk]);
        const { frames, rest } = decodeFrames(rx);
        rx = rest;
        for (const f of frames) {
          if (f.opcode !== 0x1) continue;
          const msg = JSON.parse(f.payload.toString('utf8'));
          if (msg.type === 'ready' && !sent) {
            sent = true;
            up.socket.write(encodeFrame(JSON.stringify({ type: 'resize', cols: 90, rows: 26 }), 0x1, true));
            up.socket.write(encodeFrame(JSON.stringify({ type: 'in', data: 'echo PTY_E2E_LIVE_OK\r' }), 0x1, true));
          } else if (msg.type === 'out' && msg.data) {
            text += Buffer.from(msg.data, 'base64').toString('utf8');
            if (text.includes('PTY_E2E_LIVE_OK')) {
              clearTimeout(timer);
              up.socket.write(encodeFrame(JSON.stringify({ type: 'kill' }), 0x1, true));
              up.socket.destroy();
              resolve(text);
            }
          }
        }
      });
    });

    assert.match(output, /PTY_E2E_LIVE_OK/);
  } finally {
    app.server.close();
  }
});
