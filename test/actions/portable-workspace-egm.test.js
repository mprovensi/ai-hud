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
        conversation_id: '5068aeb9-f002-4073-9975-6ba11bade461',
        status: 'SUCCESS',
        response: JSON.stringify({
          items: [
            { title: 'Item estruturado por IA', body: 'Detalhe curto.', status: 'spec', phase: 'IA', docRef: 'README.md' },
          ],
        }),
        usage: { input_tokens: 900, output_tokens: 210, cache_read_tokens: 50 },
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

    // 3. Importa checklists de docs/plano-v2.md para o Quadro (0 tokens!) e valida Desfazer importação
    const imp = await reqJson(port, 'POST', '/api/workspace/project/import-docs', tok, {
      entityId: entId1,
      paths: ['docs/plano-v2.md'],
    });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.tokensUsed, 0);
    assert.equal(imp.json.addedCount, 3);
    assert.equal(modelCalls, 0);

    // Desfaz importação -> volta a 0 itens; depois reimporta normalmente
    const undoneBoard = await reqJson(port, 'POST', '/api/workspace/project/board-undo', tok, { entityId: entId1 });
    assert.equal(undoneBoard.status, 200);
    assert.equal(undoneBoard.json.board.items.length, 0);

    const imp2 = await reqJson(port, 'POST', '/api/workspace/project/import-docs', tok, {
      entityId: entId1,
      paths: ['docs/plano-v2.md'],
    });
    assert.equal(imp2.status, 200);
    assert.equal(imp2.json.addedCount, 3);

    // 3b. Estruturação com IA no formato real de `agy --output-format json` (`response` + `usage`)
    const aiStruct = await reqJson(port, 'POST', '/api/workspace/project/structure-ai', tok, {
      entityId: entId1,
      docPaths: ['README.md'],
      engine: 'Claude Code',
      dryRun: false,
    });
    assert.equal(aiStruct.status, 200);
    assert.equal(aiStruct.json.items.length, 1);
    assert.equal(aiStruct.json.items[0].title, 'Item estruturado por IA');
    assert.equal(aiStruct.json.usage.totalTokens, 1110);
    assert.equal(aiStruct.json.usage.cacheReadTokens, 50);

    // 3c. Sync reverso Quadro -> Markdown: concluir item 2 marca `- [x]` em docs/plano-v2.md
    const item2 = imp2.json.board.items[1];
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
    assert.equal(modelCalls, 1);

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
    assert.equal(modelCalls, 2);

    // Log global de tokens do workflow registrado (1 structure-ai + 1 goldfish)
    const usage = await reqJson(port, 'GET', '/api/workspace/usage', tok);
    assert.equal(usage.status, 200);
    assert.equal(usage.json.runs, 2);
    assert.equal(usage.json.totalTokens, 1110 + 1480);

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

    // 7. MCP standalone: board_read, board_update_status (com backup + sync `- [x]` em docs/) e board_add_item
    const mcp = require('../../integrations/mcp/memory-server');
    const rList = mcp.handleRpc({ id: 1, method: 'tools/list' }, path.join(dataDir, 'workspace'));
    assert.ok(rList.result.tools.some((t) => t.name === 'board_read'));
    assert.ok(rList.result.tools.some((t) => t.name === 'board_update_status'));
    assert.ok(rList.result.tools.some((t) => t.name === 'board_add_item'));

    const bRead = mcp.readBoardCompact({ cwd: projDir });
    assert.equal(bRead.total, 3);
    assert.equal(bRead.counts.spec, 1);

    const item3 = bRead.items[2];
    const bUpd = mcp.updateBoardStatus({
      cwd: projDir,
      updates: [{ id: item3.id, status: 'done', note: 'Verificado pelo agente.' }],
    });
    assert.equal(bUpd.ok, true);
    assert.equal(bUpd.updated, 1);
    assert.equal(bUpd.applied[0].docSynced, true);
    assert.match(fs.readFileSync(path.join(projDir, 'docs', 'plano-v2.md'), 'utf8'), /- \[x\] Revisar segurança/);

    const bAdd = mcp.addBoardItem({ cwd: projDir, title: 'Nova tarefa via MCP', status: 'idea' });
    assert.equal(bAdd.ok, true);
    assert.ok(typeof bAdd.item.updatedAt === 'number');
    assert.equal(mcp.readBoardCompact({ cwd: projDir }).total, 4);

    // 8. Servir imagem local do projeto em /api/fs/image (inline + download + contenção)
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.mkdirSync(path.join(projDir, 'assets'), { recursive: true });
    const imgPath = path.join(projDir, 'assets', 'hero.png');
    fs.writeFileSync(imgPath, png1x1);

    const imgRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/fs/image?cwd=${encodeURIComponent(projDir)}&path=${encodeURIComponent(imgPath)}&download=1&t=${tok}`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers['content-type'], 'image/png');
    assert.match(imgRes.headers['content-disposition'], /attachment; filename="hero\.png"/);
    assert.equal(imgRes.buf.length, png1x1.length);

    const imgBad = await reqJson(port, 'GET', `/api/fs/image?cwd=${encodeURIComponent(projDir)}&path=${encodeURIComponent('../../secret.png')}`, tok);
    assert.equal(imgBad.status, 403);

    // 9. Caminho estendido do Windows (\\?\) no cwd (ex.: Codex no Windows) deve normalizar sem EISDIR
    if (process.platform === 'win32') {
      const winExtendedCwd = '\\\\?\\' + projDir;
      const imgWinRes = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/fs/image?cwd=${encodeURIComponent(winExtendedCwd)}&path=${encodeURIComponent(imgPath)}&t=${tok}`, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      assert.equal(imgWinRes.status, 200);
      assert.equal(imgWinRes.headers['content-type'], 'image/png');
      assert.equal(imgWinRes.buf.length, png1x1.length);
    }

    // 10. Reordenar workspaces e projetos na sidebar via POST /api/workspace/reorder
    await reqJson(port, 'POST', '/api/workspace/group', tok, { name: 'Alpha' });
    await reqJson(port, 'POST', '/api/workspace/group', tok, { name: 'Beta' });
    const ent2 = await reqJson(port, 'POST', '/api/workspace/entity', tok, { title: 'Segundo Projeto', group: 'Alpha' });
    assert.equal(ent2.status, 200);

    const reorderedGroups = await reqJson(port, 'POST', '/api/workspace/reorder', tok, {
      groups: ['Beta', 'Alpha', 'WorkspaceB'],
      entityIds: [ent2.json.entity.id, recreated.json.entity.id],
      moveEntity: { id: ent2.json.entity.id, group: 'Beta' },
    });
    assert.equal(reorderedGroups.status, 200);

    const wsIdx = await reqJson(port, 'GET', '/api/workspace/index', tok);
    assert.equal(wsIdx.status, 200);
    assert.ok(wsIdx.json.groups.indexOf('Beta') < wsIdx.json.groups.indexOf('Alpha'));
    assert.equal(wsIdx.json.entities[0].id, ent2.json.entity.id);
    assert.equal(wsIdx.json.entities[0].group, 'Beta');
    assert.equal(wsIdx.json.entities[1].id, recreated.json.entity.id);
  } finally {
    app.server.close();
  }
});
