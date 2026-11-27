const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceActions } = require('../../src/actions/workspace');
const { detectPathPlatform } = require('../../src/core/path-guard');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-ws-sub-'));
}

test('workspace valida subpastas Windows e POSIX independente do SO do hub (ex.: VPS Linux -> peer Windows)', () => {
  assert.equal(detectPathPlatform('D:\\Projetos TRT18', 'linux'), 'win32');
  assert.equal(detectPathPlatform('D:/Projetos TRT18', 'linux'), 'win32');
  assert.equal(detectPathPlatform('\\\\srv\\share\\proj', 'linux'), 'win32');
  assert.equal(detectPathPlatform('/home/ubuntu/teste', 'win32'), 'linux');

  const dataDir = mkTmp();
  try {
    const ws = createWorkspaceActions({ dataDir, config: {} });

    // Workspace com rootCwd Windows (caso típico: VPS Linux gerenciando peer Windows)
    const gWin = ws.saveGroup({ name: 'TRT18', machine: 'MateusNote', rootCwd: 'D:\\Projetos TRT18' });
    assert.equal(gWin.status, 200);

    // Subpasta válida (tanto com \ quanto com /)
    const okWin = ws.createEntity({
      title: 'Vulnerabilidades',
      group: 'TRT18',
      projectBindings: [{ machine: 'MateusNote', cwd: 'D:\\Projetos TRT18\\vulnerabilidades' }],
    });
    assert.equal(okWin.status, 200);
    assert.equal(okWin.body.entity.group, 'TRT18');

    // Rejeita raiz exata (inclusive com casing/barra diferente)
    const sameWin = ws.createEntity({
      title: 'Raiz',
      group: 'TRT18',
      projectBindings: [{ machine: 'MateusNote', cwd: 'd:/projetos trt18/' }],
    });
    assert.equal(sameWin.status, 400);
    assert.match(String(sameWin.body), /não a pasta raiz/);

    // Rejeita traversal e prefixo irmão
    const travWin = ws.createEntity({
      title: 'Traversal',
      group: 'TRT18',
      projectBindings: [{ machine: 'MateusNote', cwd: 'D:\\Projetos TRT18\\..\\Outro' }],
    });
    assert.equal(travWin.status, 400);
    assert.match(String(travWin.body), /deve ser uma subpasta/);

    const sibWin = ws.createEntity({
      title: 'Irmao',
      group: 'TRT18',
      projectBindings: [{ machine: 'MateusNote', cwd: 'D:\\Projetos TRT182\\vulnerabilidades' }],
    });
    assert.equal(sibWin.status, 400);

    // Workspace com rootCwd Linux (caso típico: hub Windows gerenciando peer Linux)
    const gLin = ws.saveGroup({ name: 'VPSLab', machine: 'VPS-Oracle', rootCwd: '/home/ubuntu/teste' });
    assert.equal(gLin.status, 200);

    const okLin = ws.createEntity({
      title: 'App VPS',
      group: 'VPSLab',
      projectBindings: [{ machine: 'VPS-Oracle', cwd: '/home/ubuntu/teste/meu-app' }],
    });
    assert.equal(okLin.status, 200);

    const sameLin = ws.createEntity({
      title: 'Raiz VPS',
      group: 'VPSLab',
      projectBindings: [{ machine: 'VPS-Oracle', cwd: '/home/ubuntu/teste/' }],
    });
    assert.equal(sameLin.status, 400);
    assert.match(String(sameLin.body), /não a pasta raiz/);

    const outLin = ws.createEntity({
      title: 'Fora VPS',
      group: 'VPSLab',
      projectBindings: [{ machine: 'VPS-Oracle', cwd: '/home/ubuntu/outro/meu-app' }],
    });
    assert.equal(outLin.status, 400);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
