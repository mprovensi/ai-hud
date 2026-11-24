const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createVoice, sanitizeForSpeech } = require('../../src/actions/voice');
const { createTerminal } = require('../../src/actions/terminal');
const { createApp } = require('../../src/main');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function reqJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(token ? { Cookie: `hud=${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('createVoice: sanitiza Markdown, consulta voiceUrl para STT/TTS e trata ausência de backend', async () => {
  const clean = sanitizeForSpeech('## Título\nVeja `foo()` e [link](https://x.com)\n```js\nconst a=1;\n```');
  assert.doesNotMatch(clean, /```|##|https:\/\/x\.com/);
  assert.match(clean, /Título/);
  assert.match(clean, /bloco de código/);

  // Sem voiceUrl em Linux -> stt/tts false
  const vOff = createVoice({ config: {}, platform: 'linux' });
  const stOff = await vOff.status();
  assert.equal(stOff.stt, false);
  assert.equal(stOff.tts, false);
  assert.equal((await vOff.transcribe({ audioBase64: 'AAAA' })).status, 503);
  assert.equal((await vOff.speak({ text: 'olá' })).status, 503);

  // Com voiceUrl mockado
  const fakeWav = Buffer.from('RIFF....WAVE');
  const vOn = createVoice({
    config: { voiceUrl: 'http://127.0.0.1:8790' },
    platform: 'linux',
    fetchUrl: async (url) => {
      if (url.endsWith('/health')) return { ok: true, status: 200, text: JSON.stringify({ ok: true, stt: true, tts: true, whisperModel: 'small' }) };
      if (url.endsWith('/transcribe')) return { ok: true, status: 200, text: JSON.stringify({ ok: true, text: 'rodar testes agora', language: 'pt' }) };
      if (url.endsWith('/speak')) return { ok: true, status: 200, contentType: 'audio/wav', buffer: fakeWav, text: '' };
      return { ok: false, status: 404, text: '' };
    },
  });

  const stOn = await vOn.status();
  assert.equal(stOn.stt, true);
  assert.equal(stOn.tts, true);

  const tr = await vOn.transcribe({ audioBase64: 'data:audio/wav;base64,UklGRg==', mimeType: 'audio/wav' });
  assert.equal(tr.status, 200);
  assert.equal(tr.body.text, 'rodar testes agora');

  const sp = await vOn.speak({ text: 'Teste de fala' });
  assert.equal(sp.status, 200);
  assert.equal(sp.contentType, 'audio/wav');
  assert.deepEqual(sp.buffer, fakeWav);
});

test('createTerminal: executa comando na pasta, redacta segredos na saída e respeita disableTerminal', async () => {
  const proj = tmpDir('hud-term-');
  const term = createTerminal();
  const res = await term({ cwd: proj, command: 'echo ok-fase5 sk-proj-1234567890abcdefghijklmnop' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.stdout, /ok-fase5/);
  assert.doesNotMatch(res.body.stdout, /sk-proj-1234/);
  assert.equal(res.body.redacted, true);

  const disabled = createTerminal({ config: { disableTerminal: true } });
  const rDis = await disabled({ cwd: proj, command: 'echo hi' });
  assert.equal(rDis.status, 403);
});

test('Fase 5 end-to-end: /api/voice/status e /api/fs/exec com contenção de pastas autorizadas', async () => {
  const dataDir = tmpDir('hud-p5-data-');
  const projOk = tmpDir('hud-p5-ok-');
  const projNo = tmpDir('hud-p5-no-');
  const token = '55667788aabbccdd11223344';

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token,
    pin: '12345678',
    name: 'TestP5',
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
  try {
    const vs = await reqJson(port, 'GET', '/api/voice/status', token);
    assert.equal(vs.status, 200);
    assert.equal(vs.json.ok, true);

    // Pasta autorizada (pinned) -> executa
    const exOk = await reqJson(port, 'POST', '/api/fs/exec', token, { cwd: projOk, command: 'echo hello-ws' });
    assert.equal(exOk.status, 200);
    assert.equal(exOk.json.ok, true);
    assert.match(exOk.json.stdout, /hello-ws/);

    // Pasta não autorizada -> 403
    const exNo = await reqJson(port, 'POST', '/api/fs/exec', token, { cwd: projNo, command: 'echo nope' });
    assert.equal(exNo.status, 403);

    // Englobadores de projetos (Workspaces: TRT, Jogos)
    const g1 = await reqJson(port, 'POST', '/api/workspace/group', token, { name: 'TRT' });
    assert.equal(g1.status, 200);
    assert.ok(g1.json.groups.includes('TRT'));

    const ent = await reqJson(port, 'POST', '/api/workspace/entity', token, {
      title: 'PJe Calc',
      group: 'TRT',
      category: 'project',
    });
    assert.equal(ent.status, 200);
    assert.equal(ent.json.entity.group, 'TRT');

    const moved = await reqJson(port, 'PUT', '/api/workspace/entity', token, {
      id: ent.json.entity.id,
      group: 'Jogos',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.entity.group, 'Jogos');

    const idx = await reqJson(port, 'GET', '/api/workspace/index', token);
    assert.equal(idx.status, 200);
    assert.ok(idx.json.groups.includes('TRT'));
    assert.ok(idx.json.groups.includes('Jogos'));
    assert.equal(idx.json.entities[0].group, 'Jogos');
  } finally {
    app.server.close();
  }
});
