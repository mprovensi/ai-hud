// Regras puras para sincronização bidirecional peer-to-peer do AI Workspace (VPS Principal <-> Local).
// Camada core/: zero I/O, determinístico e 100% testável.

const EXCLUDED_TOP_DIRS = new Set(['.ai-workspace', '.git', 'backups', 'node_modules']);
const EXCLUDED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function normalizeSyncPath(raw) {
  const s = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
  if (!s || s.includes('\0')) return '';
  const parts = s.split('/').filter(Boolean);
  if (!parts.length) return '';
  for (const seg of parts) {
    if (seg === '.' || seg === '..') return '';
  }
  return parts.join('/');
}

function isSyncableRelPath(raw) {
  const norm = normalizeSyncPath(raw);
  if (!norm) return false;
  const parts = norm.split('/');
  const first = parts[0].toLowerCase();
  const last = parts[parts.length - 1].toLowerCase();
  if (EXCLUDED_TOP_DIRS.has(first)) return false;
  if (EXCLUDED_FILES.has(last)) return false;
  if (last.endsWith('.tmp') || last.endsWith('.bak') || last.endsWith('.swp')) return false;
  // Nunca sincronizar arquivos ocultos na raiz além de nada conhecido
  if (parts.some((p) => p.startsWith('.') && p !== '.keep')) return false;
  return true;
}

/**
 * Calcula um hash determinístico de manifesto a partir dos arquivos sincronizáveis.
 * (Retorna a string canônica; o caller calcula SHA-256 em infra/federation.)
 */
function canonicalManifestText(files) {
  return [...(files || [])]
    .filter((f) => f && isSyncableRelPath(f.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}\t${f.sha256 || ''}\t${Number(f.size) || 0}`)
    .join('\n');
}

/**
 * Planeja sincronização 3-way entre o workspace local e o hub remoto principal (VPS).
 *
 * Regras de segurança:
 * - Mesmo sha256 nos dois lados: skip.
 * - Só existe no remoto: pull (local recebe tudo do hub principal).
 * - Só existe no local: push (criações offline sobem para a VPS), exceto arquivos ignorados no 1º sync (seed local).
 * - Mudou só no remoto desde `lastState`: pull.
 * - Mudou só no local desde `lastState`: push (edições offline sobem automaticamente ao reconectar).
 * - Primeira sincronização sem histórico (`!prev`) com conteúdo diferente: `preferRemote` (VPS) vence e backup local é feito.
 * - Conflito real (ambos mudaram desde `lastState`): mtime mais recente vence (com backup da versão substituída); empate favorece `preferRemote`.
 */
function planWorkspaceSync({
  localFiles = [],
  remoteFiles = [],
  lastState = {},
  preferRemote = true,
  skipInitialLocalPaths = [],
} = {}) {
  const localMap = new Map();
  for (const f of localFiles) {
    const p = normalizeSyncPath(f && f.path);
    if (p && isSyncableRelPath(p)) localMap.set(p, { ...f, path: p });
  }
  const remoteMap = new Map();
  for (const f of remoteFiles) {
    const p = normalizeSyncPath(f && f.path);
    if (p && isSyncableRelPath(p)) remoteMap.set(p, { ...f, path: p });
  }

  const prevState = lastState && typeof lastState === 'object' ? lastState : {};
  const skipSet = new Set((skipInitialLocalPaths || []).map(normalizeSyncPath).filter(Boolean));
  const allPaths = [...new Set([...localMap.keys(), ...remoteMap.keys()])].sort();

  const pulls = [];
  const pushes = [];
  const conflicts = [];
  let skipped = 0;

  for (const p of allPaths) {
    const loc = localMap.get(p) || null;
    const rem = remoteMap.get(p) || null;
    const prev = typeof prevState[p] === 'string' ? prevState[p] : '';

    if (loc && rem && loc.sha256 === rem.sha256) {
      skipped += 1;
      continue;
    }

    if (!loc && rem) {
      pulls.push({ path: p, reason: 'remote-only', remote: rem });
      continue;
    }

    if (loc && !rem) {
      if (skipSet.has(p)) {
        skipped += 1;
        continue;
      }
      pushes.push({ path: p, reason: 'local-only', local: loc });
      continue;
    }

    // Ambos existem com hashes diferentes
    if (prev && loc.sha256 === prev && rem.sha256 !== prev) {
      pulls.push({ path: p, reason: 'remote-updated', local: loc, remote: rem });
    } else if (prev && rem.sha256 === prev && loc.sha256 !== prev) {
      pushes.push({ path: p, reason: 'local-updated', local: loc, remote: rem });
    } else if (!prev) {
      if (preferRemote) {
        pulls.push({ path: p, reason: 'initial-prefer-remote', local: loc, remote: rem });
      } else if ((Number(loc.mtimeMs) || 0) > (Number(rem.mtimeMs) || 0) + 1000) {
        pushes.push({ path: p, reason: 'initial-local-newer', local: loc, remote: rem });
      } else {
        pulls.push({ path: p, reason: 'initial-remote-newer', local: loc, remote: rem });
      }
    } else {
      // Conflito real: ambos mudaram desde o último sync conhecido
      const locMs = Number(loc.mtimeMs) || 0;
      const remMs = Number(rem.mtimeMs) || 0;
      const localWins = locMs > remMs + 1000 || (!preferRemote && locMs >= remMs);
      conflicts.push({
        path: p,
        winner: localWins ? 'local' : 'remote',
        localMtimeMs: locMs,
        remoteMtimeMs: remMs,
      });
      if (localWins) {
        pushes.push({ path: p, reason: 'conflict-local-newer', local: loc, remote: rem });
      } else {
        pulls.push({ path: p, reason: 'conflict-remote-wins', local: loc, remote: rem });
      }
    }
  }

  return { pulls, pushes, conflicts, skipped };
}

module.exports = {
  normalizeSyncPath,
  isSyncableRelPath,
  canonicalManifestText,
  planWorkspaceSync,
};
