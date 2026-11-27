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
const { createFxTracker } = require('./collect/fx');
const { Ollama } = require('./collect/ollama-status');
const { createSharedSessionIndex } = require('./collect/shared-sessions');
const { buildSnapshot } = require('./views/snapshot');
const { buildSessionDetail } = require('./views/session-detail');
const { createPendingStore } = require('./actions/pending');
const { createReplyQueue, replyKey } = require('./actions/reply/claude-queue');
const { createReplies } = require('./actions/reply');
const { createSessionLauncher } = require('./actions/spawn');
const { createHandoff } = require('./actions/handoff');
const { createSharedSessions } = require('./actions/shared-sessions');
const { resolveWorkspaceRoot } = require('./infra/workspace-paths');
const { createProjectPins } = require('./actions/projects');
const { createSessionMeta } = require('./actions/session-meta');
const { createUpload } = require('./actions/upload');
const { createWorkspaceActions } = require('./actions/workspace');
const { createWorkspaceSync } = require('./actions/workspace/sync');
const { createWorkspaceWorkflow } = require('./actions/workspace/workflow');
const { createMemoryActions } = require('./actions/memory');
const { createPush } = require('./actions/push');
const { createVoice } = require('./actions/voice');
const { createTerminal } = require('./actions/terminal');
const { createPtyManager } = require('./actions/pty');
const { createFolderPicker } = require('./actions/folder-picker');
const { createOpenVsCode } = require('./actions/open-vscode');
const { commitProjectGit } = require('./actions/project-git-commit');
const { createProjectRunner } = require('./actions/project-runner');
const { createMcpActions } = require('./actions/mcp');
const { createSkillsActions } = require('./actions/skills');
const { attachWsPty } = require('./api/ws-pty');
const { createRunning } = require('./actions/running');
const { compareSessions } = require('./core/session');
const { createPermissions } = require('./actions/permissions');
const { createFocus } = require('./actions/focus');
const { createClose } = require('./actions/close');
const { Peers } = require('./federation/peers');
const { createWorkspacePeerSync } = require('./federation/workspace-peer-sync');
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
  const fx = createFxTracker({ dataDir, config });
  const peers = new Peers(config.peers, path.join(dataDir, 'peer-ollamas.json'), path.join(dataDir, 'peer-cache.json'));
  const sharedSessionIndex = createSharedSessionIndex();
  let lastSharedIndex = null;
  let handoff = null;

  // Snapshot local (usado quando outro hub pede ?local=1, evitando loop de federação)
  function buildLocal(sessions, now) {
    if (handoff && typeof handoff.reconcile === 'function') handoff.reconcile(sessions);
    if (quotas.expired(now) && quotas.sinceRefresh(now) > 60e3) quotas.refreshAll();
    // Releitura do log cria um objeto novo: reaplica o fim das sessões encerradas pelo HUD
    for (const s of sessions) if (!s.endedAt && closeFn.endedAt) s.endedAt = closeFn.endedAt(s.id);
    lastSharedIndex = sharedSessionIndex.indexForSessions(sessions);
    return buildSnapshot({
      sessions, now, quotas, pendingInfo, remoteMode: permissions.remoteMode, ideListen,
      fxState: fx.view(), pricingOverrides: config.pricing || null,
      ollamaState: () => (showOllama ? ollama.state : null),
      sharedIndex: lastSharedIndex,
    });
  }
  // Snapshot consolidado que os aparelhos recebem: este PC (views) + secundários (federation) + metadados (pin/alias/grupo)
  const sessionMeta = createSessionMeta(dataDir);
  const push = createPush({ dataDir, config, log });
  function applyMeta(list) {
    return (list || []).map((c) => {
      const m = sessionMeta.get(c.id);
      if (!m) return c;
      return { ...c, pinned: !!m.pinned, alias: m.alias || '', group: m.group || '' };
    });
  }
  function build(sessions, now, local) {
    const merged = peers.merge(local || buildLocal(sessions, now), machineName);
    const active = applyMeta(merged.active).sort(compareSessions);
    const recent = applyMeta(merged.recent);
    const out = { ...merged, active, recent, voiceStt: !!(config.voiceUrl || process.env.AI_VOICE_URL) };
    push.observeSnapshot(out);
    return out;
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
  handoff = createHandoff({
    dataDir,
    launch,
    sharedSessions: createSharedSessions({ workspaceRoot: resolveWorkspaceRoot(dataDir, config) }),
    sessionMeta,
  });
  const setProjectPin = createProjectPins({ config, saveConfig });
  const uploadAttachment = createUpload({ dataDir, config });
  const workspace = createWorkspaceActions({ dataDir, config });
  const workspaceSync = createWorkspaceSync({ dataDir, config, log });
  const workspacePeerSync = createWorkspacePeerSync({
    dataDir,
    config,
    peers,
    machineName,
    sessionMeta,
    onSessionMetaChanged: () => collector.poke(),
    log,
  });
  const workspaceWorkflow = createWorkspaceWorkflow({
    dataDir, config, quotas, ollama, claudeExe, codexExe, agyExe, exec, runModel: dreamRunModel, log,
  });
  const memory = createMemoryActions({
    dataDir, config, collector, quotas, ollama,
    claudeExe, codexExe, agyExe, exec, runModel: dreamRunModel,
    onDreamDone: (info) => push.notifyAll({
      title: `🌙 Dreaming concluído: ${info.project}`,
      body: (info.summary || `${info.sessionsProcessed} sessões consolidadas.`).slice(0, 140),
      tag: `dream-${info.slug}`,
      url: '/#workspace',
    }).catch(() => {}),
    log,
  });
  const filePreview = (opts) => readFilePreview({ ...opts, exec });
  const fileList = (opts) => listProjectFiles(opts);
  const projectGit = (cwd) => readProjectGit(cwd, exec);
  const projectGitCommit = (opts) => commitProjectGit(opts, exec);
  const voice = createVoice({ config, exec });
  const terminal = createTerminal({ config });
  const ptyManager = createPtyManager({ dataDir, config, claudeExe, codexExe, agyExe, log });
  const pickFolder = createFolderPicker({ exec });
  const openVsCode = createOpenVsCode();
  const projectRunner = createProjectRunner({ config, log });
  const mcp = createMcpActions({ dataDir, config, machineName, log });
  const skills = createSkillsActions({ dataDir, config, machineName, log });

  const getSharedIndex = () => {
    if (!lastSharedIndex) {
      try { lastSharedIndex = sharedSessionIndex.indexForSessions(collector.current().sessions); } catch {}
    }
    return lastSharedIndex;
  };
  const resolveActiveSession = (s) => {
    const idx = getSharedIndex();
    const headId = idx && idx.redirectToHead && idx.redirectToHead.get(s.id);
    if (!headId || headId === s.id) return s;
    return collector.find((x) => !x.subagent && x.id === headId) || s;
  };

  // api
  const routes = createRoutes({
    send, collector, appVersion: webAssets.version,
    resolveActiveSession,
    detail: (s, now) => {
      const idx = getSharedIndex();
      const sharedCtx = (idx && idx.byNativeId && idx.byNativeId.get(s.id)) || null;
      return buildSessionDetail(s, now, pendingInfo, { sharedCtx, quotas });
    },
    reply, launch, handoff, setProjectPin, sessionMeta, uploadAttachment, workspace, workspaceSync, workspacePeerSync, workspaceWorkflow, memory, mcp, skills, push, voice, terminal, ptyManager, pickFolder, openVsCode, filePreview, fileList, projectGit, projectGitCommit, projectRunner,
    dataDir, config, capabilities, running, queue, permissions, getIdeListen, setIdeListen, focus, close: closeFn, peers, quotas, machineName,
  });
  const serveStatic = createStatic({ webDir, webAssets, workspaceDistDir, send, brands, dataDir });
  const webauthn = createWebAuthn({ dataDir, config });
  const server = http.createServer(createHandler({ config, send, serveStatic, webAssets, workspaceDistDir, routes, webauthn, log }));
  attachWsPty({ server, dataDir, config, webauthn, ptyManager, peers, collector, machineName, log });
  let started = false;
  let quotaTimer = null;

  // Ponto único de encerramento: libera timers, agendadores, PTYs e processos do Play Runner.
  function stop() {
    if (quotaTimer) { clearInterval(quotaTimer); quotaTimer = null; }
    started = false;
    try { collector.stop(); } catch {}
    try { if (fx && fx.stop) fx.stop(); } catch {}
    try { if (memory && memory.stopScheduler) memory.stopScheduler(); } catch {}
    try { if (workspaceSync && workspaceSync.stopAutoSync) workspaceSync.stopAutoSync(); } catch {}
    try { if (workspacePeerSync && workspacePeerSync.stopAutoSync) workspacePeerSync.stopAutoSync(); } catch {}
    try { if (sources && sources.stop) sources.stop(); } catch {}
    try { if (ollama && ollama.stop) ollama.stop(); } catch {}
    try { if (capabilities && capabilities.stop) capabilities.stop(); } catch {}
    try { if (peers && peers.stop) peers.stop(); } catch {}
    try { ptyManager.closeAll(); } catch {}
    try { projectRunner.stopAll(); } catch {}
  }

  server.on('close', stop);
  // A página consulta com long-polling: manter a conexão aberta evita um novo handshake a cada vez
  // (caro no Wi-Fi em economia de energia do iPad)
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 70e3;

  // Leituras periódicas (coletor, cotas, Ollama, secundários, processos `ollama run`); fora dos testes
  function start() {
    if (started) return;
    started = true;
    if (sources.start) sources.start();
    if (showOllama) ollama.start();
    capabilities.start();
    collector.start();
    fx.start();
    memory.startScheduler();
    workspaceSync.startAutoSync();
    workspacePeerSync.startAutoSync();
    peers.start((peer) => {
      collector.poke();
      if (peer && peer.name && !peer.error) workspacePeerSync.notifyPeerOnline(peer.name);
    });
    quotas.refreshAll().then(() => collector.poke());
    // Com alguma sessão trabalhando, lê a cada 1 min (o gráfico da janela de 5h fica mais detalhado)
    quotaTimer = setInterval(() => {
      const now = Date.now();
      let busy = false;
      try { busy = collector.current().snapshot.active.some((s) => s.state === 'working'); } catch {}
      if (quotas.sinceRefresh(now) >= (busy ? QUOTA_BUSY_MS : QUOTA_EVERY_MS)) quotas.refreshAll().then(() => collector.poke());
    }, 30e3);
    if (quotaTimer.unref) quotaTimer.unref();
  }

  return { server, config, start, stop, warm: () => collector.current(), collector, quotas };
}

module.exports = { createApp };
