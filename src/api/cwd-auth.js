// Política unificada de autorização de pastas (`cwd`) para rotas de arquivos, workspace, memória e runner (camada api/).
// Não confia na query `?local=1` como privilégio; valida tanto o caminho normalizado quanto o caminho físico (symlinks/junctions).
const fs = require('fs');
const os = require('os');
const { isCwdAllowed, isWithinRoot, isSecretPath, normalizePath } = require('../core/path-guard');
const { resolveWorkspaceRoot, resolveNearestRealPath } = require('../infra/workspace-paths');
const { recentCwds } = require('../collect/capabilities');
const { readWorkspaceJson } = require('../collect/workspace');

function safeReal(p) {
  if (!p) return '';
  try { return fs.realpathSync(p); } catch { return resolveNearestRealPath(p); }
}

function createCwdAuthorizer({ dataDir, config, collector }) {
  return function checkAuthorizedCwd(cwd, { allowHomeSubdirs = false } = {}) {
    const raw = String(cwd || '').trim();
    if (!raw) return { ok: false, reason: 'Informe a pasta do projeto.' };
    const norm = normalizePath(raw);
    if (!norm) return { ok: false, reason: 'Caminho de pasta inválido.' };
    if (isSecretPath(norm)) return { ok: false, reason: 'Pasta sensível bloqueada pela política de segurança.' };

    const home = os.homedir();
    const realCwd = safeReal(norm);
    if (isSecretPath(realCwd)) return { ok: false, reason: 'Pasta sensível bloqueada pela política de segurança.' };
    const realHome = home ? safeReal(home) : '';

    if (allowHomeSubdirs && !(config && config.strictRemoteCwd) && home) {
      if (isWithinRoot(home, norm) && (!realHome || isWithinRoot(realHome, realCwd))) {
        return { ok: true };
      }
    }

    const sessions = (collector && typeof collector.current === 'function' && collector.current().sessions) || [];
    const knownCwds = recentCwds(sessions, (config && config.pinnedProjects) || []);
    const wsRoots = [];
    if (dataDir) {
      try {
        const ws = readWorkspaceJson(resolveWorkspaceRoot(dataDir, config));
        for (const m of Object.values(ws.groupMeta || {})) {
          if (m && m.rootCwd) wsRoots.push(m.rootCwd);
        }
        for (const e of (ws.entities || [])) {
          for (const b of (e.projectBindings || [])) {
            if (b && b.cwd) wsRoots.push(b.cwd);
          }
        }
      } catch {}
    }

    const allowedRoots = [...((config && config.allowedRoots) || []), ...wsRoots];
    const lexical = isCwdAllowed(norm, { allowedRoots, knownCwds, home, strict: true });
    if (!lexical.ok) return lexical;

    // Também garante que o caminho físico (após resolver symlinks/junctions) continua dentro das raízes físicas autorizadas.
    const realAllowedRoots = allowedRoots.map(safeReal).filter(Boolean);
    const realKnownCwds = knownCwds.map(safeReal).filter(Boolean);
    const physical = isCwdAllowed(realCwd, {
      allowedRoots: realAllowedRoots,
      knownCwds: realKnownCwds,
      home: realHome,
      strict: true,
    });
    if (!physical.ok) {
      return { ok: false, reason: 'Caminho físico (symlink/junction) fora da lista de pastas autorizadas.' };
    }
    return { ok: true };
  };
}

module.exports = { createCwdAuthorizer };
