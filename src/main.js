// Monta o servidor do HUD. As camadas e o sentido das dependências (veja docs/system-design.md):
//   api → views / actions / federation → collect → core      (infra serve a todas)
// Os testes chamam createApp com fontes e cotas falsas.
const http = require('http');
const os = require('os');
const path = require('path');
const { WEB } = require('./infra/paths');
const { loadConfig } = require('./infra/config');
const { createWebAssets } = require('./infra/web-bundle');
const { createSources } = require('./collect/sources');
const { createCollector } = require('./collect/collector');
const { createQuotaTracker } = require('./collect/quotas/tracker');
const { Ollama } = require('./collect/ollama-status');
const { buildSnapshot } = require('./views/snapshot');
const { buildSessionDetail } = require('./views/session-detail');
const { createPendingStore } = require('./actions/pending');
const { createReplyQueue, replyKey } = require('./actions/reply/claude-queue');
const { createReplies } = require('./actions/reply');
const { createPermissions } = require('./actions/permissions');
const { createFocus } = require('./actions/focus');
const { createClose } = require('./actions/close');
const { Peers } = require('./federation/peers');
const { createSend } = require('./api/utils');
const { createStatic } = require('./api/static');
const { createRoutes } = require('./api/routes');
const { createHandler } = require('./api/handler');

const QUOTA_EVERY_MS = 5 * 60 * 1000;
const QUOTA_BUSY_MS = 60 * 1000;

function createApp({
  dataDir,
  webDir = WEB,
  sources = createSources({ dataDir }),
  quotaFetchers,
  focus = createFocus(),
  close = createClose(),
  codexExe = 'codex',
  exec,
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

  // actions
  const pending = createPendingStore(path.join(dataDir, 'pending.json'));
  const queue = createReplyQueue(pending);
  const permissions = createPermissions({ store: pending, remoteMode: config.remoteMode, onRemoteChange: (on) => { config.remoteMode = on; saveConfig(); } });
  // O que está pendente para uma sessão: aparece no cartão e na gaveta
  const pendingInfo = (s, now) => {
    const key = replyKey(s);
    return { key, listening: queue.listenState(key, now), queued: queue.queued(key), permission: permissions.pendingFor(key, now) };
  };

  // federation: este PC junta as sessões e tokens dos secundários (config.peers) e repassa a eles as ações das sessões deles
  const machineName = config.name || os.hostname();
  const peers = new Peers(config.peers, path.join(dataDir, 'peer-ollamas.json'));

  // O snapshot que os aparelhos recebem: este PC (views) + secundários (federation)
  function build(sessions, now) {
    if (quotas.expired(now) && quotas.sinceRefresh(now) > 60e3) quotas.refreshAll();
    // Releitura do log cria um objeto novo: reaplica o fim das sessões encerradas pelo HUD
    for (const s of sessions) if (!s.endedAt && close.endedAt) s.endedAt = close.endedAt(s.id);
    const local = buildSnapshot({ sessions, now, quotas, pendingInfo, remoteMode: permissions.remoteMode,
      ollamaState: () => (showOllama ? ollama.state : null) });
    return peers.merge(local, machineName);
  }
  const collector = createCollector({ sources, build });

  const reply = createReplies({ queue, codexExe, exec, findSession: (p) => collector.find(p),
    ollamaReply: (s, text, url) => sources.ollamaReply(s, text, url), ollamaUrl: () => ollama.url });

  // api
  const routes = createRoutes({ send, collector, appVersion: webAssets.version, detail: (s, now) => buildSessionDetail(s, now, pendingInfo),
    reply, queue, permissions, focus, close, peers, quotas, machineName });
  const serveStatic = createStatic({ webDir, webAssets, send, brands });
  const server = http.createServer(createHandler({ config, send, serveStatic, webAssets, routes, log }));
  // A página consulta com long-polling: manter a conexão aberta evita um novo handshake a cada vez
  // (caro no Wi-Fi em economia de energia do iPad)
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 70e3;

  // Leituras periódicas (coletor, cotas, Ollama, secundários, processos `ollama run`); fora dos testes
  function start() {
    if (sources.start) sources.start();
    if (showOllama) ollama.start();
    collector.start();
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

  return { server, config, start, warm: () => collector.current(), collector };
}

module.exports = { createApp };
