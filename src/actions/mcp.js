// Ações de gestão e sincronização de MCPs compartilhados entre Claude Code, Codex CLI e Antigravity (camada actions/).
const fs = require('fs');
const path = require('path');
const {
  MCP_TARGETS,
  slugifyMcpId,
  normalizeServer,
  extractSecretRefs,
  isServerActiveFor,
  expandServerForSync,
  applyClaudeMcp,
  applyAntigravityMcp,
  applyCodexTomlMcp,
} = require('../core/mcp-catalog');
const {
  defaultCliPaths,
  catalogFilePath,
  secretsFilePath,
  readMcpCatalog,
  readLocalSecrets,
  readDetectedCliMcps,
  readMcpStatus,
} = require('../collect/mcp');
const { readJson, writeJsonStrict } = require('../infra/store');
const { resolveWorkspaceRoot, writeAtomicWithBackup, resolveSafeContainedTarget } = require('../infra/workspace-paths');

function createMcpActions({ dataDir, config, machineName = '', cliPaths = null, aiHudRoot = path.resolve(__dirname, '..', '..'), now = () => Date.now(), log = () => {} }) {
  const getCliPaths = () => cliPaths || defaultCliPaths();
  const wsBackups = () => path.join(resolveWorkspaceRoot(dataDir, config), '.ai-workspace', 'backups', 'mcp');
  const localBackups = () => path.join(dataDir, 'backups', 'mcp');

  function saveCatalog(catalog) {
    const file = catalogFilePath(dataDir, config);
    writeAtomicWithBackup({
      filePath: file,
      content: JSON.stringify(catalog, null, 2) + '\n',
      backupDir: wsBackups(),
      tag: 'mcp-servers.json',
    });
  }

  function saveLocalSecrets(secrets) {
    fs.mkdirSync(dataDir, { recursive: true });
    writeJsonStrict(secretsFilePath(dataDir), secrets, true);
  }

  function getStatus() {
    return readMcpStatus({ dataDir, config, machineName, cliPaths: getCliPaths(), aiHudRoot });
  }

  function upsertServer({ server, secrets: incomingSecrets = {} } = {}) {
    let normalized;
    try {
      normalized = normalizeServer({ ...(server || {}), updatedAt: now() });
    } catch (e) {
      return { status: e.status || 400, body: e.message || 'Configuração MCP inválida.' };
    }

    const envSplit = extractSecretRefs(normalized.env || {}, normalized.id);
    const hdrSplit = extractSecretRefs(normalized.headers || {}, normalized.id);
    const cleanServer = {
      ...normalized,
      ...(Object.keys(envSplit.clean).length ? { env: envSplit.clean } : {}),
      ...(Object.keys(hdrSplit.clean).length ? { headers: hdrSplit.clean } : {}),
    };
    if (!Object.keys(envSplit.clean).length) delete cleanServer.env;
    if (!Object.keys(hdrSplit.clean).length) delete cleanServer.headers;

    const mergedSecrets = { ...readLocalSecrets(dataDir), ...envSplit.secrets, ...hdrSplit.secrets };
    for (const [k, v] of Object.entries(incomingSecrets || {})) {
      const ck = String(k || '').trim();
      if (!ck || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ck)) continue;
      if (v === '' || v === null) delete mergedSecrets[ck];
      else mergedSecrets[ck] = String(v);
    }

    const catalog = readMcpCatalog(dataDir, config);
    const idx = catalog.servers.findIndex((s) => s.id === cleanServer.id);
    const nextServers = catalog.servers.slice();
    if (idx >= 0) nextServers[idx] = cleanServer;
    else nextServers.push(cleanServer);
    const managedIds = [...new Set([...(catalog.managedIds || []), cleanServer.id])];

    try {
      saveLocalSecrets(mergedSecrets);
      saveCatalog({ format: 'ai-mcp-catalog', version: 1, managedIds, servers: nextServers });
    } catch (e) {
      return { status: e.status || 500, body: e.message || 'Falha ao salvar catálogo MCP.' };
    }

    return { status: 200, body: { ok: true, server: cleanServer, status: getStatus() } };
  }

  function deleteServer({ id } = {}) {
    const cleanId = slugifyMcpId(id);
    if (!cleanId) return { status: 400, body: 'Informe o id do servidor MCP.' };
    const catalog = readMcpCatalog(dataDir, config);
    const nextServers = catalog.servers.filter((s) => s.id !== cleanId);
    const managedIds = [...new Set([...(catalog.managedIds || []), cleanId])];
    try {
      saveCatalog({ format: 'ai-mcp-catalog', version: 1, managedIds, servers: nextServers });
    } catch (e) {
      return { status: e.status || 500, body: e.message || 'Falha ao remover servidor MCP.' };
    }
    return { status: 200, body: { ok: true, id: cleanId, status: getStatus() } };
  }

  function importFromClis({ targets = MCP_TARGETS } = {}) {
    const wanted = Array.isArray(targets) && targets.length
      ? targets.filter((t) => MCP_TARGETS.includes(t))
      : MCP_TARGETS;
    const cli = readDetectedCliMcps(getCliPaths());
    const catalog = readMcpCatalog(dataDir, config);
    const localSecrets = { ...readLocalSecrets(dataDir) };
    const byId = new Map(catalog.servers.map((s) => [s.id, { ...s }]));
    const imported = [];

    for (const target of wanted) {
      for (const [rawId, entry] of Object.entries(cli.detected[target] || {})) {
        const id = slugifyMcpId(rawId);
        if (!id) continue;
        // Não importa o node_repl interno do Codex por padrão
        if (target === 'codex' && id === 'node_repl') continue;

        const existing = byId.get(id);
        if (existing) {
          existing.targets = { ...existing.targets, [target]: true };
          byId.set(id, existing);
          continue;
        }

        const envSplit = extractSecretRefs(entry.env || {}, id);
        const hdrSplit = extractSecretRefs(entry.headers || {}, id);
        Object.assign(localSecrets, envSplit.secrets, hdrSplit.secrets);

        try {
          const norm = normalizeServer({
            id,
            name: rawId,
            transport: entry.transport,
            command: entry.command,
            args: entry.args,
            url: entry.url,
            env: envSplit.clean,
            headers: hdrSplit.clean,
            enabled: entry.enabled !== false,
            targets: {
              claude: target === 'claude',
              codex: target === 'codex',
              antigravity: target === 'antigravity',
            },
            updatedAt: now(),
          });
          byId.set(id, norm);
          imported.push({ id, source: target, secretsExtracted: Object.keys(envSplit.secrets).length + Object.keys(hdrSplit.secrets).length });
        } catch {}
      }
    }

    const nextServers = [...byId.values()];
    const managedIds = [...new Set([...(catalog.managedIds || []), ...nextServers.map((s) => s.id)])];
    try {
      saveLocalSecrets(localSecrets);
      saveCatalog({ format: 'ai-mcp-catalog', version: 1, managedIds, servers: nextServers });
    } catch (e) {
      return { status: e.status || 500, body: e.message || 'Falha ao importar MCPs.' };
    }
    return { status: 200, body: { ok: true, importedCount: imported.length, imported, status: getStatus() } };
  }

  function syncToClis({ targets = MCP_TARGETS, projectCwd = '' } = {}) {
    const wanted = Array.isArray(targets) && targets.length
      ? targets.filter((t) => MCP_TARGETS.includes(t))
      : MCP_TARGETS;
    const catalog = readMcpCatalog(dataDir, config);
    const secrets = readLocalSecrets(dataDir);
    const paths = getCliPaths();
    const ctx = { secrets, env: process.env, aiHudRoot };
    const results = {};

    // Modo opcional por projeto: grava `.mcp.json` dentro da pasta do projeto (para Claude Code / ferramentas compatíveis)
    if (projectCwd) {
      const check = resolveSafeContainedTarget(projectCwd, '.mcp.json');
      if (!check.ok) return { status: 403, body: check.error || 'Pasta do projeto inválida.' };
      const active = catalog.servers
        .filter((s) => isServerActiveFor(s, 'claude', machineName))
        .map((s) => expandServerForSync(s, ctx));
      const cur = readJson(check.target, {});
      const next = applyClaudeMcp(cur, active, catalog.managedIds || []);
      try {
        writeAtomicWithBackup({
          filePath: check.target,
          content: JSON.stringify(next, null, 2) + '\n',
          backupDir: localBackups(),
          tag: 'project_.mcp.json',
          rootDir: projectCwd,
        });
      } catch (e) {
        return { status: e.status || 500, body: e.message || 'Falha ao gravar .mcp.json.' };
      }
      return { status: 200, body: { ok: true, projectMcpFile: check.target, count: active.length, status: getStatus() } };
    }

    for (const target of wanted) {
      const active = catalog.servers
        .filter((s) => isServerActiveFor(s, target, machineName))
        .map((s) => expandServerForSync(s, ctx));
      const filePath = paths[target];
      try {
        if (target === 'claude') {
          const cur = readJson(filePath, {});
          const next = applyClaudeMcp(cur, active, catalog.managedIds || []);
          writeAtomicWithBackup({
            filePath,
            content: JSON.stringify(next, null, 2) + '\n',
            backupDir: localBackups(),
            tag: 'claude.json',
          });
        } else if (target === 'antigravity') {
          const cur = readJson(filePath, {});
          const next = applyAntigravityMcp(cur, active, catalog.managedIds || []);
          writeAtomicWithBackup({
            filePath,
            content: JSON.stringify(next, null, 2) + '\n',
            backupDir: localBackups(),
            tag: 'antigravity_mcp_config.json',
          });
        } else if (target === 'codex') {
          let cur = '';
          try { cur = fs.readFileSync(filePath, 'utf8'); } catch {}
          const next = applyCodexTomlMcp(cur, active, catalog.managedIds || []);
          writeAtomicWithBackup({
            filePath,
            content: next,
            backupDir: localBackups(),
            tag: 'codex_config.toml',
          });
        }
        results[target] = { ok: true, count: active.length, file: filePath };
      } catch (e) {
        results[target] = { ok: false, error: e.message || String(e), file: filePath };
      }
    }

    const ok = Object.values(results).every((r) => r.ok);
    log(`[mcp-sync] ${machineName || 'local'}: ${Object.entries(results).map(([k, r]) => `${k}=${r.ok ? r.count : 'ERR'}`).join(', ')}`);
    return { status: ok ? 200 : 500, body: { ok, results, status: getStatus() } };
  }

  function installMemoryPreset({ sync = true } = {}) {
    const up = upsertServer({
      server: {
        id: 'ai-hud-memory',
        name: 'AI HUD Memory & Board',
        description: 'Memória compartilhada cross-IA e controle de Board (.ai-workspace/board.card.json) do AI HUD.',
        transport: 'stdio',
        command: 'node',
        args: ['{{AI_HUD_ROOT}}/integrations/mcp/memory-server.js'],
        enabled: true,
        targets: { claude: true, codex: true, antigravity: true },
        machines: [],
      },
    });
    if (up.status !== 200) return up;
    return sync ? syncToClis() : up;
  }

  return {
    getStatus,
    upsertServer,
    deleteServer,
    importFromClis,
    syncToClis,
    installMemoryPreset,
  };
}

module.exports = { createMcpActions };
