// Leitura somente leitura do catálogo de MCPs compartilhados e das configs reais das 3 CLIs (camada collect/).
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultCatalog,
  validateCatalog,
  parseClaudeMcp,
  parseAntigravityMcp,
  parseCodexTomlMcp,
  computeSyncStatus,
} = require('../core/mcp-catalog');
const { readJson } = require('../infra/store');
const { resolveWorkspaceRoot } = require('../infra/workspace-paths');

function defaultCliPaths(homeDir = os.homedir()) {
  return {
    claude: path.join(homeDir, '.claude.json'),
    codex: path.join(homeDir, '.codex', 'config.toml'),
    antigravity: path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json'),
  };
}

function catalogFilePath(dataDir, config) {
  return path.join(resolveWorkspaceRoot(dataDir, config), 'mcp-servers.json');
}

function secretsFilePath(dataDir) {
  return path.join(dataDir, 'mcp-secrets.json');
}

function readMcpCatalog(dataDir, config) {
  const file = catalogFilePath(dataDir, config);
  if (!fs.existsSync(file)) return defaultCatalog();
  try {
    return validateCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return defaultCatalog();
  }
}

function readLocalSecrets(dataDir) {
  const raw = readJson(secretsFilePath(dataDir), {});
  return raw && typeof raw === 'object' ? raw : {};
}

function readDetectedCliMcps(cliPaths = defaultCliPaths()) {
  const claudeRaw = readJson(cliPaths.claude, null);
  const agyRaw = readJson(cliPaths.antigravity, null);
  let codexRaw = '';
  try { codexRaw = fs.readFileSync(cliPaths.codex, 'utf8'); } catch {}

  return {
    paths: cliPaths,
    exists: {
      claude: fs.existsSync(cliPaths.claude),
      codex: fs.existsSync(cliPaths.codex),
      antigravity: fs.existsSync(cliPaths.antigravity),
    },
    detected: {
      claude: claudeRaw ? parseClaudeMcp(claudeRaw) : {},
      codex: codexRaw ? parseCodexTomlMcp(codexRaw) : {},
      antigravity: agyRaw ? parseAntigravityMcp(agyRaw) : {},
    },
  };
}

function readMcpStatus({ dataDir, config, machineName = '', cliPaths = defaultCliPaths(), aiHudRoot = '' }) {
  const catalog = readMcpCatalog(dataDir, config);
  const secrets = readLocalSecrets(dataDir);
  const cli = readDetectedCliMcps(cliPaths);
  const computed = computeSyncStatus(catalog, cli.detected, {
    machineName,
    secrets,
    env: process.env,
    aiHudRoot,
  });
  return {
    ok: true,
    machine: machineName,
    catalogPath: catalogFilePath(dataDir, config),
    cliPaths: cli.paths,
    cliExists: cli.exists,
    localSecretKeys: Object.keys(secrets).filter((k) => Boolean(secrets[k])),
    managedIds: catalog.managedIds,
    servers: computed.servers,
    unmanaged: computed.unmanaged,
  };
}

module.exports = {
  defaultCliPaths,
  catalogFilePath,
  secretsFilePath,
  readMcpCatalog,
  readLocalSecrets,
  readDetectedCliMcps,
  readMcpStatus,
};
