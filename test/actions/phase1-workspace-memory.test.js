const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
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
        Cookie: `hud=${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Fase 1 end-to-end: Workspace file-first (409 + backup + media + docs) e Memória/Dreaming (undo + bridges)', async () => {
  const dataDir = tmpDir('hud-p1-data-');
  const projDir = tmpDir('hud-p1-proj-');
  fs.writeFileSync(path.join(projDir, 'index.js'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Instruções existentes\nMantenha tudo simples.\n');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token: 'aabbccdd0011223344556677',
    pin: '87654321',
    name: 'TestHub',
    pinnedProjects: [projDir],
  }));

  const fakeBin = path.join(dataDir, 'fake-claude.cmd');
  fs.writeFileSync(fakeBin, 'echo ok');

  const fakeSession = {
    tool: 'Claude Code',
    id: '11111111-aaaa-bbbb-cccc-222222222222',
    project: 'meu-proj',
    cwd: projDir,
    title: 'Implementar cache',
    models: new Set(['claude-sonnet-4']),
    start: '2026-11-23T14:00:00Z',
    end: '2026-11-23T14:30:00Z',
    input: 100, output: 100, cacheRead: 0, cacheWrite: 0,
    prompts: 2, toolCalls: 2, tools: { Edit: 2 }, files: { 'index.js': 1 },
    lastPrompt: 'Adicione cache em memória',
    lastReply: 'Cache implementado em index.js.',
    events: [],
    history: [
      { role: 'user', content: 'Adicione cache em memória', at: Date.parse('2026-11-23T14:10:00Z') },
      { role: 'assistant', content: 'Cache implementado em index.js.', at: Date.parse('2026-11-23T14:30:00Z') },
    ],
  };

  let dreamCalls = 0;
  const app = createApp({
    dataDir,
    sources: { all: () => [fakeSession] },
    quotaFetchers: {},
    claudeExe: fakeBin,
    brands: false,
    log: () => {},
    dreamRunModel: async () => {
      dreamCalls++;
      return JSON.stringify({
        memoryMd: '# meu-proj\n\n- Cache em memória implementado em `index.js`.',
        currentStateMd: '# Estado atual\n\n- Próximo passo: adicionar testes.',
        decisionsAppend: '- [Claude 2026-11-23] Usar Map em memória sem Redis.',
        pitfallsAppend: '- Evitar leak de timers sem `.unref()`.',
        sessionNoteMd: 'Implementado cache inicial em `index.js`.',
        summary: '+1 decisão, +1 armadilha, 1 sessão consolidada',
      });
    },
  });

  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  const tok = app.config.token;

  try {
    // 1. Criar entidade no Workspace
    const created = await reqJson(port, 'POST', '/api/workspace/entity', tok, {
      title: 'Meu Projeto',
      description: 'Board principal',
      template: 'board',
      projectBindings: [{ machine: 'TestHub', cwd: projDir }],
    });
    assert.equal(created.status, 200);
    const entId = created.json.entity.id;

    const idx = await reqJson(port, 'GET', '/api/workspace/index', tok);
    assert.equal(idx.status, 200);
    assert.equal(idx.json.entities.length, 1);

    // 2. Ler card, salvar com baseHash válido e validar 409 Conflict com hash antigo
    const read1 = await reqJson(port, 'GET', `/api/workspace/entity/file?id=${entId}&path=overview.card.json`, tok);
    assert.equal(read1.status, 200);
    const hash1 = read1.json.hash;
    const card = read1.json.content;
    card.items.push({ id: 't1', title: 'Primeira tarefa', status: 'in-progress' });

    const save1 = await reqJson(port, 'PUT', '/api/workspace/entity/file', tok, {
      id: entId, path: 'overview.card.json', content: card, baseHash: hash1,
    });
    assert.equal(save1.status, 200);
    assert.notEqual(save1.json.hash, hash1);

    // Tenta salvar de novo usando hash1 obsoleto → 409 Conflict!
    const conflict = await reqJson(port, 'PUT', '/api/workspace/entity/file', tok, {
      id: entId, path: 'overview.card.json', content: card, baseHash: hash1,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.currentHash, save1.json.hash);

    // 3. Upload de mídia e leitura do asset
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const up = await reqJson(port, 'POST', '/api/workspace/entity/media', tok, {
      id: entId, fileName: 'mock.png', base64Data: pngB64,
    });
    assert.equal(up.status, 200);
    const asset = await reqJson(port, 'GET', `/api/workspace/entity/asset?id=${entId}&path=${encodeURIComponent(up.json.path)}`, tok);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], 'image/png');

    // 4. Documento global em context/
    const docPut = await reqJson(port, 'PUT', '/api/workspace/doc', tok, {
      area: 'context', name: 'profile.md', content: '# Perfil\nPrefiro PT-BR.\n',
    });
    assert.equal(docPut.status, 200);
    const docGet = await reqJson(port, 'GET', '/api/workspace/doc?area=context&name=profile.md', tok);
    assert.equal(docGet.status, 200);
    assert.match(docGet.json.content, /PT-BR/);

    // 5. Memória compartilhada: fixar pinned.md + rodar Dreaming + validar idempotência + undo
    const pinSave = await reqJson(port, 'PUT', '/api/memory/file', tok, {
      project: 'meu-proj', cwd: projDir, file: 'pinned.md', content: '- NUNCA remover testes.\n',
    });
    assert.equal(pinSave.status, 200);

    const memBefore = await reqJson(port, 'GET', `/api/memory?project=meu-proj&cwd=${encodeURIComponent(projDir)}`, tok);
    assert.equal(memBefore.status, 200);
    assert.equal(memBefore.json.pendingCount, 1);

    const dreamed = await reqJson(port, 'POST', '/api/memory/dream', tok, {
      project: 'meu-proj', cwd: projDir, engine: 'Claude Code', ignoreQuota: true,
    });
    assert.equal(dreamed.status, 200);
    assert.equal(dreamed.json.ok, true);
    assert.equal(dreamed.json.sessionsProcessed, 1);
    assert.equal(dreamCalls, 1);

    const memAfter = await reqJson(port, 'GET', `/api/memory?project=meu-proj&cwd=${encodeURIComponent(projDir)}`, tok);
    assert.equal(memAfter.json.pendingCount, 0);
    assert.match(memAfter.json.files['MEMORY.md'], /Cache em memória/);
    assert.match(memAfter.json.files['decisions.md'], /Map em memória/);
    assert.equal(memAfter.json.files['pinned.md'], '- NUNCA remover testes.\n'); // imutável!
    assert.equal(memAfter.json.episodic.length, 1);

    // Segunda chamada sem sessões novas → pula sem chamar LLM!
    const dreamed2 = await reqJson(port, 'POST', '/api/memory/dream', tok, {
      project: 'meu-proj', cwd: projDir, engine: 'Claude Code', ignoreQuota: true,
    });
    assert.equal(dreamed2.status, 200);
    assert.equal(dreamed2.json.skipped, true);
    assert.equal(dreamCalls, 1);

    // Undo restaura estado anterior mantendo pinned.md
    const undone = await reqJson(port, 'POST', '/api/memory/undo', tok, {
      project: 'meu-proj', cwd: projDir,
    });
    assert.equal(undone.status, 200);
    assert.equal(undone.json.ok, true);

    // 6. Pontes CLAUDE.md / AGENTS.md / GEMINI.md preservam conteúdo existente
    const bridges = await reqJson(port, 'POST', '/api/memory/bridges', tok, {
      project: 'meu-proj', cwd: projDir, mode: 'in-repo',
    });
    assert.equal(bridges.status, 200);
    const claudeMd = fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /Instruções existentes/);
    assert.match(claudeMd, /ai-hud-memory-bridge:start/);
    assert.ok(fs.existsSync(path.join(projDir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(projDir, 'GEMINI.md')));

    // 7. /api/fs/list em pasta autorizada (projDir está em pinnedProjects)
    const listed = await reqJson(port, 'GET', `/api/fs/list?cwd=${encodeURIComponent(projDir)}`, tok);
    assert.equal(listed.status, 200);
    assert.ok(listed.json.entries.some((e) => e.name === 'index.js'));

    // 8. Servindo o bundle compilado do AI Workspace em /workspace (com auth) e /workspace/manifest.json
    const wsHtml = await reqJson(port, 'GET', '/workspace', tok);
    assert.equal(wsHtml.status, 200);
    assert.match(wsHtml.text, /AI Workspace/);
    const wsManifest = await reqJson(port, 'GET', '/workspace/manifest.json', tok);
    assert.equal(wsManifest.status, 200);
    assert.equal(wsManifest.json.short_name, 'AI Workspace');
  } finally {
    app.server.close();
  }
});
