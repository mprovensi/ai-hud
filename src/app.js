// Monta o servidor do HUD a partir das peças de src/. Os testes chamam createApp com fontes e cotas falsas.
const http = require('http');
const os = require('os');
const path = require('path');
const { PUBLIC } = require('./paths');
const { loadConfig } = require('./config');
const { createWebAssets } = require('./web-assets');
const { createSend } = require('./http/utils');
const { createStatic } = require('./http/static');
const { createRoutes } = require('./http/routes');
const { createHandler } = require('./http/handler');
const { createSources } = require('./sources');
const { createQuotaTracker } = require('./quotas/tracker');
const { createReplyQueue } = require('./actions/replies');
const { createPermissions } = require('./actions/permissions');
const { createFocus } = require('./focus');
const { createSnapshots } = require('./sessions/snapshot');
const { Peers } = require('./peers');
const { Ollama } = require('./ollama/status');

const QUOTA_EVERY_MS = 5 * 60 * 1000;
const QUOTA_BUSY_MS = 60 * 1000;

function createApp({
  dataDir,
  publicDir = PUBLIC,
  sources = createSources({ dataDir }),
  quotaFetchers,
  focus = createFocus(),
  codexExe = 'codex',
  brands = true,
  log = console.log,
}) {
  const { config, save: saveConfig } = loadConfig(dataDir);
  const webAssets = createWebAssets(publicDir);
  const send = createSend(webAssets.version);
  const quotas = createQuotaTracker({ historyFile: path.join(dataDir, 'quota-history.json'), fetchers: quotaFetchers });
  const replies = createReplyQueue(path.join(dataDir, 'replies.json'));
  const permissions = createPermissions({ remoteMode: config.remoteMode, onRemoteChange: (on) => { config.remoteMode = on; saveConfig(); } });
  // Ollama deste PC (aparece no HUD se estiver instalado ou responder); config.ollamaUrl muda o
  // endereço e config.ollama = false omite o Ollama local (quando ele fica só em outro PC)
  const ollama = new Ollama(config.ollamaUrl);
  const showOllama = config.ollama !== false;
  const snapshots = createSnapshots({ sources, quotas, replies, permissions, ollamaState: () => (showOllama ? ollama.state : null) });

  // Hub: este PC junta as sessões e tokens dos secundários (config.peers) e repassa a eles as ações das sessões deles
  const machineName = config.name || os.hostname();
  const peers = new Peers(config.peers, path.join(dataDir, 'peer-ollamas.json'));
  const hubSnapshot = () => peers.merge(snapshots.snapshot(), machineName);

  const routes = createRoutes({ send, hubSnapshot, appVersion: webAssets.version, snapshots, sources, replies, permissions,
    focus, peers, ollamaUrl: () => ollama.url, codexExe, quotas, machineName });
  const serveStatic = createStatic({ publicDir, webAssets, send, brands });
  const server = http.createServer(createHandler({ config, send, serveStatic, webAssets, routes, log }));
  // A página consulta a cada 10 s: manter a conexão aberta evita um novo handshake a cada vez
  // (caro no Wi-Fi em economia de energia do iPad)
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 70e3;

  // Leituras periódicas (cotas e processos `ollama run`); fora dos testes
  function start() {
    if (sources.start) sources.start();
    if (showOllama) ollama.start();
    peers.start();
    quotas.refreshAll();
    // Com alguma sessão trabalhando, lê a cada 1 min (o gráfico da janela de 5h fica mais detalhado)
    setInterval(() => {
      const now = Date.now();
      let busy = false;
      try { busy = snapshots.busy(now); } catch {}
      if (quotas.sinceRefresh(now) >= (busy ? QUOTA_BUSY_MS : QUOTA_EVERY_MS)) quotas.refreshAll();
    }, 30e3);
  }

  return { server, config, start, warm: () => snapshots.snapshot() };
}

module.exports = { createApp };
