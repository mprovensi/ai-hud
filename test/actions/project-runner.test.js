const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { detectProjectRunProfiles } = require('../../src/collect/workspace/project-run');
const { createApp } = require('../../src/main');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function reqJson(port, method, route, token, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const sep = route.includes('?') ? '&' : '?';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `${route}${sep}t=${token}`,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, text: raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('detectProjectRunProfiles detecta Godot (GUI) e projetos Full-Stack (Back + Front composto)', () => {
  const godotDir = tmpDir('hud-run-godot-');
  fs.writeFileSync(path.join(godotDir, 'project.godot'), 'config_version=5\n');
  const gCfg = detectProjectRunProfiles(godotDir);
  assert.ok(gCfg.profiles.some((p) => p.id === 'godot-play' && p.kind === 'gui' && p.processes[0].gui === true));
  assert.ok(gCfg.profiles.some((p) => p.id === 'godot-editor'));

  const fullDir = tmpDir('hud-run-full-');
  fs.mkdirSync(path.join(fullDir, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(fullDir, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(fullDir, 'backend', 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  fs.writeFileSync(path.join(fullDir, 'frontend', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const fCfg = detectProjectRunProfiles(fullDir);
  const comp = fCfg.profiles.find((p) => p.id === 'fullstack-dev');
  assert.ok(comp);
  assert.equal(comp.kind, 'compound');
  assert.equal(comp.processes.length, 2);
});

test('API /api/run/* salva run.json, inicia perfil composto, captura logs/URL e para processos', async () => {
  const dataDir = tmpDir('hud-run-data-');
  const projDir = tmpDir('hud-run-proj-');
  const tok = '11223344556677889900aabb';
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token: tok,
    pin: '12345678',
    name: 'NoteLocal',
    pinnedProjects: [projDir],
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
    const nodeBin = `"${process.execPath}"`;
    const saveRes = await reqJson(port, 'PUT', '/api/run/config', tok, {
      cwd: projDir,
      config: {
        defaultProfile: 'comp',
        profiles: [
          {
            id: 'comp',
            name: 'Servidor + Worker',
            kind: 'compound',
            processes: [
              { id: 'api', name: 'API', cmd: `${nodeBin} -e "console.log('ready on http://127.0.0.1:4321'); setTimeout(() => {}, 15000);"` },
              { id: 'worker', name: 'Worker', cmd: `${nodeBin} -e "console.log('worker started'); setTimeout(() => {}, 15000);"` },
            ],
          },
        ],
      },
    });
    assert.equal(saveRes.status, 200);
    assert.ok(fs.existsSync(path.join(projDir, '.ai-workspace', 'run.json')));

    const cfgRes = await reqJson(port, 'GET', `/api/run/config?cwd=${encodeURIComponent(projDir)}`, tok);
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.json.source, 'saved');
    assert.equal(cfgRes.json.config.profiles[0].processes.length, 2);

    const startRes = await reqJson(port, 'POST', '/api/run/start', tok, { cwd: projDir, profileId: 'comp' });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.json.running, true);
    assert.equal(startRes.json.processes.length, 2);

    // Aguarda log e detecção de URL local
    let stRes = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 120));
      stRes = await reqJson(port, 'GET', `/api/run/status?cwd=${encodeURIComponent(projDir)}`, tok);
      const apiProc = stRes.json.processes.find((p) => p.id === 'api');
      if (apiProc && apiProc.detectedUrls.includes('http://127.0.0.1:4321')) break;
    }
    const apiProc = stRes.json.processes.find((p) => p.id === 'api');
    assert.ok(apiProc.detectedUrls.includes('http://127.0.0.1:4321'));

    const stopRes = await reqJson(port, 'POST', '/api/run/stop', tok, { cwd: projDir });
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.json.running, false);
  } finally {
    app.server.close();
  }
});
