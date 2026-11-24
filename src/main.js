// Monta o servidor do HUD. As camadas e o sentido das dependências (veja docs/system-design.md):
//   api → views / actions / federation → collect → core      (infra serve a todas)
// Os testes chamam createApp com fontes e cotas falsas.
const http = require('http');
const os = require('os');
const path = require('path');
const { WEB, WORKSPACE_DIST } = require('./infra/paths');
const { loadConfig } = require('./infra/config');
const { createWebAssets } = require('./infra/web-bundle');
const { createSources } = require('./collect/sources');
const { createCollector } = require('./collect/collector');
const { createCapabilities } = require('./collect/capabilities');
const { readFilePreview, listProjectFiles, readProjectGit } = require('./collect/file-preview');
const { createQuotaTracker } = require('./collect/quotas/tracker');
const { Ollama } = require('./collect/ollama-status');
const { buildSnapshot } = require('./views/snapshot');
const { buildSessionDetail } = require('./views/session-detail');
const { createPendingStore } = require('./actions/pending');
const { createReplyQueue, replyKey } = require('./actions/reply/claude-queue');
const { createReplies } = require('./actions/reply');
const { createSessionLauncher } = require('./actions/spawn');
const { createHandoff } = require('./actions/handoff');
const { createProjectPins } = require('./actions/projects');
const { createWorkspaceActions } = require('./actions/workspace');
const { createMemoryActions } = require('./actions/memory');
const { createRunning } = require('./actions/running');
const { createPermissions } = require('./actions/permissions');
const { createFocus } = require('./actions/focus');
const { createClose } = require('./actions/close');
const { Peers } = require('./federation/peers');
const { createSend } = require('./api/utils');
const { createStatic } = require('./api/static');
const { createRoutes } = require('./api/routes');
const { createHandler } = require('./api/handler');
const { createWebAuthn } = require('./api/webauthn');

const QUOTA_EVERY_MS = 5 * 60 * 1000;
const QUOTA_BUSY_MS = 60 * 1000;

function createApp({
  dataDir,
  webDir = WEB,
  workspaceDistDir = WORKSPACE_DIST,
  sources = createSources({ dataDir }),
  quotaFetchers,
  focus = createFocus(),
  close,
  claudeExe = '',
  codexExe = 'codex',
  agyExe = '',
  exec,
  spawn,
  dreamRunModel,
  brands = true,
  log = console.log,
}) {
  const { config, save: saveConfig } = loadConfig(dataDir);
  const webAssets = createWebAssets(webDir);
  const send = createSend(webAssets.version);

  // collect
  const quotas = createQuotaTracker({ historyFile: path.join(dataDir, 'quota-history.json'), fetchers: quotaFetchers });
  // Ollama deste PC (aparece no HUD se estiver instalado ou responder); config.ollamaUrl muda o
  // endereço e config.ollama = false omite o Ollama local (quando ele fica só em outro PC)
  const ollama = new Ollama(config.ollamaUrl);
  const showOllama = config.ollama !== false;

  const running = createRunning();
  const closeFn = close || createClose({ running });
  // actions
  const pending = createPendingStore(path.join(dataDir, 'pending.json'));
  const queue = createReplyQueue(pending);
  const permissions = createPermissions({
    store: pending,
    remoteMode: config.remoteMode !== false,
    onRemoteChange: (on) => { config.remoteMode = on; saveConfig(); },
  });
  let ideListen = !!config.ideListen;
  const setIdeListen = (on) => {
    ideListen = !!on;
    config.ideListen = ideListen;
    saveConfig();
    return ideListen;
  };
  const getIdeListen = () => ideListen;
  // O que está pendente para uma sessão: aparece no cartão e na gaveta
  const pendingInfo = (s, now) => {
    const key = replyKey(s);
    return {
      key,
      listening: queue.listenState(key, now),
      queued: queue.queued(key),
      permission: permissions.pendingFor(key, now),
      canStop: running.isBusy(s.id),
    };
  };

  // federation: este PC junta as sessões e tokens dos secundários (config.peers) e repassa a eles as ações das sessões deles
  const machineName = config.name || os.hostname();
  const peers = new Peers(config.peers, path.join(dataDir, 'peer-ollamas.json'), path.join(dataDir, 'peer-cache.json'));

  // Snapshot local (usado quando outro hub pede ?local=1, evitando loop de federação)
  function buildLocal(sessions, now) {
    if (quotas.expired(now) && quotas.sinceRefresh(now) > 60e3) quotas.refreshAll();
    // Releitura do log cria um objeto novo: reaplica o fim das sessões encerradas pelo HUD
    for (const s of sessions) if (!s.endedAt && closeFn.endedAt) s.endedAt = closeFn.endedAt(s.id);
    return buildSnapshot({ sessions, now, quotas, pendingInfo, remoteMode: permissions.remoteMode, ideListen,
      ollamaState: () => (showOllama ? ollama.state : null) });
  }
  // Snapshot consolidado que os aparelhos recebem: este PC (views) + secundários (federation)
  function build(sessions, now, local) {
    return peers.merge(local || buildLocal(sessions, now), machineName);
  }
  const collector = createCollector({ sources, buildLocal, build });

  const capabilities = createCapabilities({
    claudeExe, codexExe, agyExe, ollama, showOllama, exec,
    getPinned: () => config.pinnedProjects || [],
    getStrictRemoteCwd: () => !!config.strictRemoteCwd,
  });
  const reply = createReplies({ queue, claudeExe, codexExe, agyExe, exec, spawn, findSession: (p) => collector.find(p),
    ollamaReply: (s, text, url) => sources.ollamaReply(s, text, url), ollamaUrl: () => ollama.url, running });
  const launch = createSessionLauncher({ claudeExe, codexExe, agyExe, spawn,
    ollamaCreate: (model, text, url) => sources.ollamaCreate && sources.ollamaCreate(model, text, url),
    ollamaUrl: () => ollama.url, running });
  const handoff = createHandoff({ dataDir, launch });
  const setProjectPin = createProjectPins({ config, saveConfig });
  const workspace = createWorkspaceActions({ dataDir, config });
  const memory = createMemoryActions({
    dataDir, config, collector, quotas, ollama,
    claudeExe, codexExe, agyExe, exec, runModel: dreamRunModel, log,
  });
  const filePreview = (opts) => readFilePreview({ ...opts, exec });
  const fileList = (opts) => listProjectFiles(opts);
  const projectGit = (cwd) => readProjectGit(cwd, exec);

  // api
  const routes = createRoutes({
    send, collector, appVersion: webAssets.version, detail: (s, now) => buildSessionDetail(s, now, pendingInfo),
    reply, launch, handoff, setProjectPin, workspace, memory, filePreview, fileList, projectGit,
    dataDir, config, capabilities, running, queue, permissions, getIdeListen, setIdeListen, focus, close: closeFn, peers, quotas, machineName,
  });
  const serveStatic = createStatic({ webDir, webAssets, workspaceDistDir, send, brands, dataDir });
  const webauthn = createWebAuthn({ dataDir, config });
  const server = http.createServer(createHandler({ config, send, serveStatic, webAssets, workspaceDistDir, routes, webauthn, log }));
  // A página consulta com long-polling: manter a conexão aberta evita um novo handshake a cada vez
  // (caro no Wi-Fi em economia de energia do iPad)
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 70e3;

  // Leituras periódicas (coletor, cotas, Ollama, secundários, processos `ollama run`); fora dos testes
  function start() {
    if (sources.start) sources.start();
    if (showOllama) ollama.start();
    capabilities.start();
    collector.start();
    memory.startScheduler();
    peers.start(() => collector.poke());
    quotas.refreshAll().then(() => collector.poke());
    // Com alguma sessão trabalhando, lê a cada 1 min (o gráfico da janela de 5h fica mais detalhado)
    setInterval(() => {
      const now = Date.now();
      let busy = false;
      try { busy = collector.current().snapshot.active.some((s) => s.state === 'working'); } catch {}
      if (quotas.sinceRefresh(now) >= (busy ? QUOTA_BUSY_MS : QUOTA_EVERY_MS)) quotas.refreshAll().then(() => collector.poke());
    }, 30e3);
  }

  return { server, config, start, warm: () => collector.current(), collector, quotas };
}

module.exports = { createApp };
