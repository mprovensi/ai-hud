// Servidor do AI HUD: serve a página e /api/snapshot para iPad/Android na rede local ou no Tailscale.
// A montagem fica em src/main.js; o desenho está em docs/system-design.md.
const os = require('os');
const { ROOT, DATA } = require('./src/infra/paths');
const { migrateLegacy } = require('./src/infra/config');
const { createApp } = require('./src/main');
const { claudeQuota, codexQuota, CODEX } = require('./src/collect/quotas/cli');

const PORT = Number(process.env.AI_HUD_PORT) || 8787;

migrateLegacy(ROOT, DATA);
const app = createApp({ dataDir: DATA, quotaFetchers: { claude: claudeQuota, codex: codexQuota }, codexExe: CODEX });
app.start();
app.server.listen(PORT, '0.0.0.0', () => {
  app.warm(); // aquece o cache de logs: a primeira leitura de todos os arquivos leva ~1,5 s
  console.log(`AI HUD na porta ${PORT} · PIN ${app.config.pin}. Abra em um destes endereços:`);
  // Pelo nome (mDNS do Windows) o endereço não muda quando o roteador troca o IP do PC
  console.log(`  http://${os.hostname()}.local:${PORT}  (pelo nome, recomendado)`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${PORT}`);
  }
});
