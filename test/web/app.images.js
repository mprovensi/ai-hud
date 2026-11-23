// Prints do app com sessões e cotas de exemplo, para avaliar o visual sem depender do uso real.
//   npm run imagens   → test-output/imagens/app-*.png
// Sobe o servidor de verdade (createApp) com fontes falsas e abre cada tela no navegador sem janela.
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../src/main');
const { findBrowser, screenshot } = require('../helpers/screenshot');

const MIN = 60e3;

// Sessão no formato que as fontes entregam (src/core/session.js)
function session(now, o) {
  const end = now - (o.idleMin || 0) * MIN;
  const events = [];
  for (let h = 0; h < 24; h += 2) events.push({ ts: new Date(now - h * 60 * MIN).toISOString(), fresh: o.tokensPerTurn || 20e3, cacheRead: 80e3 });
  return {
    tool: o.tool, id: o.id, file: '', cwd: o.cwd, where: o.where || 'vscode', project: o.project,
    start: new Date(now - (o.ageMin || 90) * MIN).toISOString(), end: new Date(end).toISOString(), mtime: end,
    lastStop: o.working ? '' : 'end_turn', title: o.title, prompts: 6, firstPrompt: o.title, lastPrompt: o.lastPrompt || '',
    lastReply: o.lastReply || '', lastReplyAt: end, models: new Set([o.tool === 'Codex' ? 'gpt-5.5-codex' : 'claude-opus-5-5']),
    subagent: false, input: 120e3, output: 40e3, cacheRead: 900e3, cacheWrite: 60e3,
    context: o.context || 0, contextWindow: 200e3, toolCalls: 30, lastTool: o.working ? 'Bash' : '', tools: { Bash: 14, Read: 9, Edit: 7 },
    events, testRun: o.testRun,
  };
}

function sampleSessions(now) {
  return [
    session(now, { tool: 'Claude Code', id: 'ex-claude-1', project: 'ai-hud', cwd: 'D:\\Projetos\\ai-hud', working: true,
      title: 'Cores dos gráficos de uso', lastPrompt: 'altere o azul e o vermelho', context: 70e3 }),
    session(now, { tool: 'Claude Code', id: 'ex-claude-2', project: 'sivi', cwd: 'D:\\Projetos\\sivi', idleMin: 4, where: 'terminal',
      title: 'Ajuste do cálculo de férias', lastPrompt: 'rode os testes', lastReply: 'Rodei os testes: 1 falhou em FeriasServiceTest.', context: 120e3,
      testRun: { ok: false, at: now - 5 * MIN, command: 'mvn -q test',
        summary: '[ERROR] Tests run: 48, Failures: 1, Errors: 0, Skipped: 0\n[ERROR] FeriasServiceTest.calculaProporcional:52 expected: <12> but was: <11>\n[INFO] BUILD FAILURE' } }),
    session(now, { tool: 'Codex', id: 'ex-codex-1', project: 'listatelefonica', cwd: 'D:\\Projetos\\listatelefonica', idleMin: 12,
      title: 'Busca por ramal', lastReply: 'Pronto: a busca agora aceita ramal com 4 dígitos.', context: 175e3 }),
    session(now, { tool: 'Claude Code', id: 'ex-claude-3', project: 'Astra Dodge', cwd: 'C:\\Users\\voce\\.claude', idleMin: 25,
      title: 'Plano de desenvolvimento', lastReply: 'Fase 2 concluída.', context: 30e3 }),
  ];
}

const windows = (five, week, now) => ({
  five_hour: { used: five, resetsAt: now + 2 * 60 * MIN }, seven_day: { used: week, resetsAt: now + 3 * 24 * 60 * MIN },
});

test('prints do app para avaliação: início, estatísticas, uso e sessão com teste falhando', async (t) => {
  const browser = findBrowser();
  if (!browser) return t.skip('nenhum navegador Edge/Chrome/Chromium encontrado');
  const now = Date.now(), token = 'b'.repeat(24);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-imagens-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ token, pin: '12345678', ollama: false }));
  const sessions = sampleSessions(now);
  const { server, collector, quotas } = createApp({
    dataDir,
    sources: { all: () => sessions, ollamaReply: async () => ({ sent: true }) },
    quotaFetchers: {
      claude: async () => ({ plan: 'max', windows: windows(35, 62, now) }),
      codex: async () => ({ plan: 'pro', windows: windows(72, 92, now) }),
    },
    focus: async () => ({ ok: true, message: '' }),
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  // Só o coletor: o start() do app liga timers (cotas, Ollama, outros PCs) que não deixam o teste terminar.
  collector.start();
  await quotas.refreshAll();
  t.after(() => collector.stop());
  await new Promise((r) => setTimeout(r, 1500)); // primeira leitura das cotas e das sessões
  collector.poke();
  await new Promise((r) => setTimeout(r, 300));

  const base = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  const shots = [
    ['app-inicio', '', 1180, 820],
    ['app-estatisticas', '#estatisticas', 820, 1100],
    ['app-uso-claude', '#uso=claude', 820, 1300],
    ['app-uso-codex', '#uso=codex', 820, 1300],
    ['app-sessao-teste-falhou', '#s=ex-claude-2', 820, 1100],
    ['app-celular', '', 400, 860],
  ];
  for (const [name, hash, width, height] of shots) await screenshot(browser, base + hash, name, { width, height });
});
