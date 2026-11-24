const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpload } = require('../../src/actions/upload');
const createFsRoutes = require('../../src/api/routes/fs');

// 1x1 PNG mínimo válido (magic bytes 89 50 4E 47 0D 0A 1A 0A)
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=';

test('uploadAttachment detecta formato por magic bytes (inclusive blob colado sem extensão) e rejeita payloads inválidos', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-upload-'));
  try {
    const upload = createUpload({ dataDir, config: {} });

    // Imagem colada do clipboard sem extensão explícita
    const ok = upload({ fileName: 'clipboard', base64Data: `data:image/png;base64,${TINY_PNG_B64}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.match(ok.body.name, /\.png$/);
    assert.ok(fs.existsSync(ok.body.path));

    // Arquivo texto disfarçado sem extensão de imagem → rejeitado
    const bad = upload({ fileName: 'script.txt', base64Data: Buffer.from('not an image').toString('base64') });
    assert.equal(bad.status, 400);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET /api/fs/image serve imagens de inbox/attachments da sessão mas continua bloqueando arquivos fora do projeto', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-fsimg-'));
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-proj-'));
  const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.png`);
  try {
    fs.writeFileSync(outsideFile, Buffer.from(TINY_PNG_B64, 'base64'));
    const upload = createUpload({ dataDir, config: {} });
    const up = upload({ fileName: 'colada.png', base64Data: TINY_PNG_B64 });
    assert.equal(up.status, 200);

    let lastResp = null;
    const routes = createFsRoutes({
      collector: {
        find: (fn) => [{ id: 'sess-1', cwd: projDir, subagent: false }].find(fn),
        current: () => ({ sessions: [] }),
      },
      peers: { byId: () => null, list: [] },
      dataDir,
      config: {},
      machineName: 'local',
      send: (_res, status, contentType, body) => { lastResp = { status, contentType, body }; },
      text: (_res, status, body) => { lastResp = { status, contentType: 'text/plain', body }; },
      json: (_res, body, status = 200) => { lastResp = { status, contentType: 'application/json', body }; },
    });

    const imgRoute = routes.find((r) => r.method === 'GET' && r.path === '/api/fs/image');
    assert.ok(imgRoute);

    // 1. Imagem anexada em inbox/attachments → permitida (200 image/png)
    await imgRoute.handler({
      res: {},
      url: new URL(`http://localhost/api/fs/image?id=sess-1&path=${encodeURIComponent(up.body.path)}`),
    });
    assert.equal(lastResp.status, 200);
    assert.equal(lastResp.contentType, 'image/png');
    assert.ok(Buffer.isBuffer(lastResp.body) && lastResp.body.length > 0);

    // 2. Imagem arbitrária fora do projeto e fora de inbox/attachments → bloqueada (403)
    lastResp = null;
    await imgRoute.handler({
      res: {},
      url: new URL(`http://localhost/api/fs/image?id=sess-1&path=${encodeURIComponent(outsideFile)}`),
    });
    assert.equal(lastResp.status, 403);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projDir, { recursive: true, force: true });
    try { fs.unlinkSync(outsideFile); } catch {}
  }
});
