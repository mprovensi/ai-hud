const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { classifyEgmComplexity, defaultModelForEgmTier } = require('../../src/core/egm');
const { createWorkspaceWorkflow } = require('../../src/actions/workspace/workflow');
const { createProjectRunner } = require('../../src/actions/project-runner');
const createRunRoutes = require('../../src/api/routes/run');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('EGM roteia modelos por complexidade: simples→haiku, revisão padrão→sonnet, revisão complexa→opus', async () => {
  assert.equal(classifyEgmComplexity({ kind: 'structure-from-docs', docCount: 2, docContent: 'Pequeno checklist' }).tier, 'simple');
  assert.equal(classifyEgmComplexity({ kind: 'goldfish-review', docContent: 'Spec curta de ajuste de botão' }).tier, 'standard');
  assert.equal(
    classifyEgmComplexity({
      kind: 'goldfish-review',
      docContent: 'Arquitetura multi-máquina com autenticação, migração de schema e controle de concorrência.\n' + 'x'.repeat(1300),
    }).tier,
    'complex',
  );
  assert.equal(defaultModelForEgmTier('Claude Code', 'simple'), 'haiku');
  assert.equal(defaultModelForEgmTier('Claude Code', 'standard'), 'sonnet');
  assert.equal(defaultModelForEgmTier('Claude Code', 'complex'), 'opus');

  const dataDir = tmpDir('egm-tier-');
  const fakeExe = path.join(dataDir, 'claude.exe');
  fs.writeFileSync(fakeExe, '');
  try {
    const pickedModels = [];
    const wf = createWorkspaceWorkflow({
      dataDir,
      config: { dream: { engines: ['Claude Code'], models: { 'Claude Code': 'haiku' } } },
      claudeExe: fakeExe,
      runModel: async ({ engine, model }) => {
        pickedModels.push({ engine, model });
        return {
          raw: '{}',
          text: JSON.stringify({ verdict: 'approved', summary: 'Ok', gaps: [], risks: [], cuts: [], items: [{ title: 'T1', status: 'idea' }] }),
        };
      },
      log: () => {},
    });

    // 1. Tarefa simples (estruturação de poucos docs) → usa haiku
    const rSimple = await wf.structureDocsWithAi({
      project: 'demo',
      docs: [{ path: 'docs/a.md', content: '# Pequeno doc\n- [ ] Item 1' }],
    });
    assert.equal(rSimple.status, 200);
    assert.equal(rSimple.body.complexity, 'simple');
    assert.equal(rSimple.body.model, 'haiku');

    // 2. Revisão Goldfish padrão → usa sonnet (não herda haiku do Dreaming!)
    const rStd = await wf.reviewSpec({
      project: 'demo',
      docPath: 'docs/specs/btn.md',
      docContent: '# Botão\nAjustar estilo do botão salvar.',
    });
    assert.equal(rStd.status, 200);
    assert.equal(rStd.body.complexity, 'standard');
    assert.equal(rStd.body.model, 'sonnet');

    // 3. Revisão Goldfish complexa (arquitetura/segurança/extensa) → usa opus
    const rComplex = await wf.reviewSpec({
      project: 'demo',
      docPath: 'docs/specs/auth.md',
      docContent: '# Arquitetura de Segurança e Concorrência\n' + 'Detalhe técnico. '.repeat(120),
    });
    assert.equal(rComplex.status, 200);
    assert.equal(rComplex.body.complexity, 'complex');
    assert.equal(rComplex.body.model, 'opus');
    assert.deepEqual(pickedModels.map((x) => x.model), ['haiku', 'sonnet', 'opus']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ProjectRunner só libera allReady/openUrl quando TODOS os processos sobem com portas respondendo', async () => {
  const projDir = tmpDir('run-ready-');
  const runner = createProjectRunner({ log: () => {} });
  const nodeBin = `"${process.execPath}"`;

  // Script HTTP real em porta efêmera (imprime URL quando sobe de verdade)
  const serverScript = path.join(projDir, 'srv.js');
  fs.writeFileSync(serverScript, [
    'const http = require("http");',
    'const s = http.createServer((req, res) => { res.end("ok"); });',
    's.listen(0, "127.0.0.1", () => {',
    '  const p = s.address().port;',
    '  console.log("listening on http://127.0.0.1:" + p);',
    '});',
  ].join('\n'));

  const failScript = path.join(projDir, 'fail.js');
  fs.writeFileSync(failScript, 'console.error("db connection refused"); process.exit(1);\n');

  try {
    // Caso 1: Projeto composto onde Frontend sobe mas Backend falha → allReady MUST be false e openUrl MUST be ''
    runner.saveConfig({
      cwd: projDir,
      runConfig: {
        defaultProfile: 'broken',
        profiles: [{
          id: 'broken',
          name: 'Front + Back com erro',
          kind: 'compound',
          processes: [
            { id: 'backend', name: 'Backend', cmd: `${nodeBin} fail.js` },
            { id: 'frontend', name: 'Frontend', cmd: `${nodeBin} srv.js`, openUrl: 'auto' },
          ],
        }],
      },
    });

    runner.start({ cwd: projDir, profileId: 'broken' });
    let st = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      st = (await runner.statusAsync({ cwd: projDir })).body;
      const fe = st.processes.find((p) => p.id === 'frontend');
      const be = st.processes.find((p) => p.id === 'backend');
      if (fe && fe.ready && be && be.status === 'exited') break;
    }
    assert.equal(st.allReady, false, 'allReady deve ser false quando backend caiu');
    assert.equal(st.openUrl, '', 'openUrl deve ficar vazio quando projeto não subiu por completo');
    assert.equal(st.bootState, 'degraded');
    runner.stop({ cwd: projDir });

    // Caso 2: Projeto composto onde Backend E Frontend sobem com portas reais → allReady=true e openUrl=Frontend
    runner.saveConfig({
      cwd: projDir,
      runConfig: {
        defaultProfile: 'healthy',
        profiles: [{
          id: 'healthy',
          name: 'Front + Back OK',
          kind: 'compound',
          processes: [
            { id: 'backend', name: 'Backend', cmd: `${nodeBin} srv.js`, openUrl: 'auto' },
            { id: 'frontend', name: 'Frontend', cmd: `${nodeBin} srv.js`, openUrl: 'auto' },
          ],
        }],
      },
    });

    runner.start({ cwd: projDir, profileId: 'healthy' });
    let okSt = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 150));
      okSt = (await runner.statusAsync({ cwd: projDir })).body;
      if (okSt.allReady) break;
    }
    assert.equal(okSt.allReady, true, 'allReady deve ser true quando todos os processos estão prontos');
    assert.equal(okSt.bootState, 'ready');
    const feProc = okSt.processes.find((p) => p.id === 'frontend');
    assert.equal(okSt.openUrl, feProc.reachableUrls[0], 'openUrl deve priorizar o frontend');
    runner.stop({ cwd: projDir });
  } finally {
    runner.stopAll();
    await new Promise((r) => setTimeout(r, 350));
    try { fs.rmSync(projDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
  }
});

test('POST /api/run/auto-configure gera .ai-workspace/run.json via IA, valida boot e não reconfigura se já existir', async () => {
  const projDir = tmpDir('run-autocfg-');
  const nodeBin = `"${process.execPath}"`;
  fs.writeFileSync(path.join(projDir, 'server.js'), [
    'const http = require("http");',
    'const s = http.createServer((req, res) => res.end("ok"));',
    's.listen(0, "127.0.0.1", () => console.log("ready at http://127.0.0.1:" + s.address().port));',
  ].join('\n'));
  fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { start: `${nodeBin} server.js` } }));

  const runner = createProjectRunner({ log: () => {} });
  let aiCalls = 0;
  const routes = createRunRoutes({
    projectRunner: runner,
    workspaceWorkflow: {
      configureRunWithAi: async () => {
        aiCalls++;
        return {
          status: 200,
          body: {
            ok: true,
            engine: 'Claude Code',
            model: 'sonnet',
            config: {
              format: 'ai-run',
              version: 1,
              defaultProfile: 'web',
              profiles: [{
                id: 'web',
                name: 'Servidor Demo',
                kind: 'web',
                processes: [{ id: 'srv', name: 'Servidor', cmd: `${nodeBin} server.js`, openUrl: 'auto' }],
              }],
            },
          },
        };
      },
    },
    peers: { list: [] },
    collector: { current: () => ({ sessions: [] }) },
    config: { pinnedProjects: [projDir] },
    machineName: 'local',
    json: (_res, body, status = 200) => ({ status, body }),
    text: (_res, status, body) => ({ status, body }),
    relay: () => {},
  });

  const autoRoute = routes.find((r) => r.method === 'POST' && r.path === '/api/run/auto-configure');
  assert.ok(autoRoute);

  try {
    // 1. Primeira chamada: não existe run.json → chama IA, salva e valida boot com sucesso
    const r1 = await autoRoute.handler({
      res: {},
      url: new URL('http://localhost/api/run/auto-configure'),
      body: { cwd: projDir, project: 'demo' },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.configured, true);
    assert.equal(r1.body.alreadyConfigured, false);
    assert.equal(r1.body.bootOk, true);
    assert.match(r1.body.openUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(aiCalls, 1);
    assert.ok(fs.existsSync(path.join(projDir, '.ai-workspace', 'run.json')));

    // 2. Segunda chamada: run.json já existe → não chama IA novamente
    const r2 = await autoRoute.handler({
      res: {},
      url: new URL('http://localhost/api/run/auto-configure'),
      body: { cwd: projDir, project: 'demo' },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.alreadyConfigured, true);
    assert.equal(aiCalls, 1);
  } finally {
    runner.stopAll();
    await new Promise((r) => setTimeout(r, 350));
    try { fs.rmSync(projDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
  }
});
