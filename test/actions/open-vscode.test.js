const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenVsCode } = require('../../src/actions/open-vscode');
const createFsRoutes = require('../../src/api/routes/fs');

test('createOpenVsCode abre pasta válida no VS Code com detached+unref e trata ausência de VS Code em Linux headless', () => {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-vsc-'));
  const fakeCode = path.join(projDir, 'Code.exe');
  fs.writeFileSync(fakeCode, '');
  try {
    const calls = [];
    const openOk = createOpenVsCode({
      platform: 'win32',
      env: { VSCODE_EXE: fakeCode },
      spawnFn: (exe, args, opts) => {
        calls.push({ exe, args, opts });
        return { unref() { calls[calls.length - 1].unreffed = true; } };
      },
    });
    const r1 = openOk({ cwd: projDir });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.launched, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, fakeCode);
    assert.equal(calls[0].args[0], fs.realpathSync(projDir));
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].unreffed, true);

    // Servidor headless sem binário code no PATH
    const openMissing = createOpenVsCode({
      platform: 'linux',
      env: { PATH: '' },
    });
    const r2 = openMissing({ cwd: projDir });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.launched, false);
    assert.match(r2.body.message, /não encontrado/i);
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test('POST /api/fs/open-vscode respeita contenção de pasta autorizada (403) e chama openVsCode para pasta autorizada', async () => {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-vsc-route-'));
  const unauthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-vsc-other-'));
  try {
    let calledWith = '';
    const routes = createFsRoutes({
      openVsCode: ({ cwd }) => {
        calledWith = cwd;
        return { status: 200, body: { ok: true, launched: true, cwd, message: 'OK' } };
      },
      collector: { current: () => ({ sessions: [] }) },
      peers: { list: [] },
      config: { pinnedProjects: [projDir] },
      machineName: 'local',
      json: (_res, body, status = 200) => ({ status, body }),
      text: (_res, status, body) => ({ status, body }),
      send: () => {},
      relay: () => {},
    });
    const route = routes.find((r) => r.method === 'POST' && r.path === '/api/fs/open-vscode');
    assert.ok(route);

    const denied = await route.handler({
      res: {},
      url: new URL('http://localhost/api/fs/open-vscode'),
      body: { cwd: unauthDir },
    });
    assert.equal(denied.status, 403);
    assert.equal(calledWith, '');

    const ok = await route.handler({
      res: {},
      url: new URL('http://localhost/api/fs/open-vscode'),
      body: { cwd: projDir },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.launched, true);
    assert.equal(calledWith, projDir);
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(unauthDir, { recursive: true, force: true });
  }
});
