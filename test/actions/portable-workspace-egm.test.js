const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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

test('Portabilidade em <cwd>/.ai-workspace/, importação 0-token de docs/ e revisão Goldfish (EGM Lite)', async () => {
  const dataDir = tmpDir('hud-egm-data-');
  const projDir = tmpDir('hud-egm-proj-');
  const tok = 'aabbccddeeff001122334455';

  // Simula repositório Git com docs/ reais
  fs.mkdirSync(path.join(projDir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(projDir, '.git', 'info', 'exclude'), '# default\n');
  fs.mkdirSync(path.join(projDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'docs', 'plano-v2.md'), [
    '# Plano V2',
    '## Fase 1',
    '- [x] Setup inicial',
    '- [ ] Implementar cache portátil',
    '- [ ] Revisar segurança',
  ].join('\n'));
  fs.writeFileSync(path.join(projDir, 'README.md'), '# Projeto EGM\nDescrição.\n');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    token: tok,
    pin: '12345678',
    name: 'NoteLocal',
    pinnedProjects: [projDir],
  }));

  let modelCalls = 0;
  const app = createApp({
    dataDir,
    sources: { all: () => [] },
    quotaFetchers: {},
    claudeExe: process.execPath,
    dreamRunModel: async ({ prompt }) => {
      modelCalls++;
      if (prompt.includes('revisor independente "Goldfish"')) {
        return JSON.stringify({
          result: JSON.stringify({
            verdict: 'approved',
            summary: 'Spec clara e enxuta, pronta para implementar.',
            gaps: [],
            risks: ['Testar path traversal em links simbólicos'],
            cuts: [],
          }),
          usage: { input_tokens: 1200, output_tokens: 280 },
          total_cost_usd: 0.0011,
        });
      }
      return JSON.stringify({
        result: JSON.stringify({
          items: [
            { title: 'Item estruturado por IA', body: 'Detalhe curto.', status: 'spec', phase: 'IA', docRef: 'README.md' },
          ],
        }),
        usage: { input_tokens: 900, output_tokens: 210 },
      });
    },
    brands: false,
    log: () => {},
  });

  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  try {
    // 1. Cria projeto no Workspace A apontando para projDir
    const created = await reqJson(port, 'POST', '/api/workspace/entity', tok, {
      title: 'Meu App',
      group: 'WorkspaceA',
      projectBindings: [{ machine: 'NoteLocal', cwd: projDir }],
    });
    assert.equal(created.status, 200);
    const entId1 = created.json.entity.id;
    assert.equal(created.json.entity.storageMode, 'in-project');

    // Verifica criação de .ai-workspace/ e inclusão automática em .git/info/exclude (boas práticas Git)
    assert.ok(fs.existsSync(path.join(projDir, '.ai-workspace', 'board.card.json')));
    assert.ok(fs.existsSync(path.join(projDir, '.ai-workspace', '.gitignore')));
    const gitExclude = fs.readFileSync(path.join(projDir, '.git', 'info', 'exclude'), 'utf8');
    assert.match(gitExclude, /\.ai-workspace\//);

    // 2. Lista docs reais do projeto (0 tokens)
    const docsList = await reqJson(port, 'GET', `/api/workspace/project/docs?entityId=${entId1}`, tok);
    assert.equal(docsList.status, 200);
    assert.equal(docsList.json.hasPortableBoard, true);
    assert.equal(docsList.json.gitMode, 'git-exclude');
    assert.ok(docsList.json.docs.some((d) => d.path === 'docs/plano-v2.md' && d.category === 'plan' && d.taskCount === 3));

    // 3. Importa checklists de docs/plano-v2.md para o Quadro (0 tokens!)
    const imp = await reqJson(port, 'POST', '/api/workspace/project/import-docs', tok, {
      entityId: entId1,
      paths: ['docs/plano-v2.md'],
    });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.tokensUsed, 0);
    assert.equal(imp.json.addedCount, 3);
    assert.equal(modelCalls, 0);

    // 3b. Sync reverso Quadro -> Markdown: concluir item 2 marca `- [x]` em docs/plano-v2.md
    const item2 = imp.json.board.items[1];
    const synced = await reqJson(port, 'POST', '/api/workspace/project/sync-checkbox', tok, {
      entityId: entId1,
      docRef: item2.docRef,
      title: item2.title,
      done: true,
    });
    assert.equal(synced.status, 200);
    assert.equal(synced.json.changed, true);
    assert.match(fs.readFileSync(path.join(projDir, 'docs', 'plano-v2.md'), 'utf8'), /- \[x\] Implementar cache portátil/);

    // 4. Cria uma nova Spec EGM Lite em docs/specs/
    const spec = await reqJson(port, 'POST', '/api/workspace/project/spec', tok, {
      entityId: entId1,
      title: 'Cache Portátil',
      summary: 'Guardar board em .ai-workspace.',
    });
    assert.equal(spec.status, 200);
    assert.equal(spec.json.path, 'docs/specs/cache-portatil.md');
    assert.ok(fs.existsSync(path.join(projDir, 'docs', 'specs', 'cache-portatil.md')));

    // 5. Vincula a spec a um item do quadro e testa Revisão Goldfish: primeiro dryRun (0 tokens), depois real
    const board1 = await reqJson(port, 'GET', `/api/workspace/project/board?entityId=${entId1}`, tok);
    const targetItem = board1.json.content.items[1];
    targetItem.docRef = spec.json.path;
    targetItem.status = 'spec';
    const savedBoard = await reqJson(port, 'PUT', '/api/workspace/project/board', tok, {
      entityId: entId1,
      content: board1.json.content,
      baseHash: board1.json.hash,
    });
    assert.equal(savedBoard.status, 200);

    const est = await reqJson(port, 'POST', '/api/workspace/project/review', tok, {
      entityId: entId1,
      docPath: spec.json.path,
      itemId: targetItem.id,
      engine: 'Claude Code',
      dryRun: true,
    });
    assert.equal(est.status, 200);
    assert.equal(est.json.dryRun, true);
    assert.ok(est.json.estimatedTotalTokens > 0);
    assert.equal(modelCalls, 0);

    const rev = await reqJson(port, 'POST', '/api/workspace/project/review', tok, {
      entityId: entId1,
      docPath: spec.json.path,
      itemId: targetItem.id,
      engine: 'Claude Code',
      dryRun: false,
    });
    assert.equal(rev.status, 200);
    assert.equal(rev.json.verdict, 'approved');
    assert.equal(rev.json.usage.totalTokens, 1480);
    assert.equal(rev.json.usage.estimated, false);
    assert.ok(fs.existsSync(path.join(projDir, rev.json.reportPath)));
    assert.equal(modelCalls, 1);

    // Log global de tokens do workflow registrado
    const usage = await reqJson(port, 'GET', '/api/workspace/usage', tok);
    assert.equal(usage.status, 200);
    assert.equal(usage.json.runs, 1);
    assert.equal(usage.json.totalTokens, 1480);

    // 6. PORTABILIDADE REAL: remove projeto do WorkspaceA e recria no WorkspaceB apontando para a mesma pasta!
    const del = await reqJson(port, 'POST', '/api/workspace/entity/delete', tok, { id: entId1 });
    assert.equal(del.status, 200);
    // A pasta .ai-workspace dentro do projeto continua intacta!
    assert.ok(fs.existsSync(path.join(projDir, '.ai-workspace', 'board.card.json')));

    const recreated = await reqJson(port, 'POST', '/api/workspace/entity', tok, {
      title: 'Meu App Migrado',
      group: 'WorkspaceB',
      projectBindings: [{ machine: 'NoteLocal', cwd: projDir }],
    });
    assert.equal(recreated.status, 200);
    assert.equal(recreated.json.restoredPortable, true);

    const boardAfter = await reqJson(port, 'GET', `/api/workspace/project/board?entityId=${recreated.json.entity.id}`, tok);
    assert.equal(boardAfter.status, 200);
    assert.equal(boardAfter.json.content.items.length, 3);
    const migratedItem = boardAfter.json.content.items.find((i) => i.id === targetItem.id);
    assert.equal(migratedItem.status, 'spec');
    assert.equal(migratedItem.review.status, 'approved');
    assert.equal(migratedItem.review.reportPath, rev.json.reportPath);
  } finally {
    app.server.close();
  }
});
