// Sincronização automática bidirecional peer-to-peer do AI Workspace (VPS Principal <-> Local).
// Camada federation/: usa apenas core/, infra/ e ./client (sem Git externo obrigatório).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { call } = require('./client');
const {
  normalizeSyncPath,
  isSyncableRelPath,
  canonicalManifestText,
  planWorkspaceSync,
} = require('../core/workspace-sync');
const {
  resolveWorkspaceRoot,
  resolveSafeContainedTarget,
  writeAtomicWithBackup,
} = require('../infra/workspace-paths');

const MAX_SYNC_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 4 * 1000;

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function walkWorkspaceFiles(wsRoot) {
  const files = [];
  if (!fs.existsSync(wsRoot)) return files;

  function visit(absDir, relPrefix) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (!isSyncableRelPath(`${rel}/x`)) continue;
        visit(abs, rel);
      } else if (ent.isFile()) {
        if (!isSyncableRelPath(rel)) continue;
        try {
          const st = fs.statSync(abs);
          if (st.size > MAX_SYNC_FILE_BYTES) continue;
          const buf = fs.readFileSync(abs);
          files.push({
            path: rel,
            sha256: sha256Buf(buf),
            mtimeMs: Math.round(st.mtimeMs),
            size: st.size,
          });
        } catch {}
      }
    }
  }

  visit(wsRoot, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function buildWorkspaceManifest(wsRoot, machineName = '') {
  const files = walkWorkspaceFiles(wsRoot);
  const rootHash = sha256Text(canonicalManifestText(files));
  return { ok: true, machine: machineName, rootHash, count: files.length, files };
}

function readSyncFile(wsRoot, relPath) {
  const norm = normalizeSyncPath(relPath);
  if (!norm || !isSyncableRelPath(norm)) {
    return { status: 400, error: 'Caminho inválido para sincronização.' };
  }
  const target = resolveSafeContainedTarget(wsRoot, norm);
  if (!target.ok) return { status: 403, error: target.error };
  if (!fs.existsSync(target.target)) return { status: 404, error: 'Arquivo não encontrado.' };
  let st;
  try { st = fs.lstatSync(target.target); } catch { return { status: 404, error: 'Arquivo não encontrado.' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { status: 403, error: 'Alvo inválido.' };
  if (st.size > MAX_SYNC_FILE_BYTES) return { status: 413, error: 'Arquivo excede o limite de sincronização (10 MB).' };
  try {
    const buf = fs.readFileSync(target.target);
    return {
      status: 200,
      body: {
        ok: true,
        path: norm,
        sha256: sha256Buf(buf),
        mtimeMs: Math.round(st.mtimeMs),
        size: buf.length,
        contentBase64: buf.toString('base64'),
      },
    };
  } catch (e) {
    return { status: 500, error: `Falha ao ler arquivo: ${e.message}` };
  }
}

function writeSyncFile(wsRoot, { relPath, contentBase64, mtimeMs = 0, baseSha256 = '' } = {}) {
  const norm = normalizeSyncPath(relPath);
  if (!norm || !isSyncableRelPath(norm)) {
    return { status: 400, error: 'Caminho inválido para sincronização.' };
  }
  if (typeof contentBase64 !== 'string') {
    return { status: 400, error: 'Conteúdo base64 ausente.' };
  }
  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.length > MAX_SYNC_FILE_BYTES) {
    return { status: 413, error: 'Arquivo excede o limite de sincronização (10 MB).' };
  }
  fs.mkdirSync(wsRoot, { recursive: true });
  const target = resolveSafeContainedTarget(wsRoot, norm);
  if (!target.ok) return { status: 403, error: target.error };

  if (baseSha256 && fs.existsSync(target.target)) {
    try {
      const curSha = sha256Buf(fs.readFileSync(target.target));
      if (curSha !== baseSha256) {
        return { status: 409, error: 'Arquivo alterado concorrentemente no destino.', currentSha256: curSha };
      }
    } catch {}
  }

  const backupDir = path.join(wsRoot, '.ai-workspace', 'sync-backups');
  try {
    writeAtomicWithBackup({
      filePath: target.target,
      content: buf,
      backupDir,
      tag: norm.replace(/[\\/]+/g, '_'),
      rootDir: wsRoot,
    });
    const ms = Number(mtimeMs) || 0;
    if (ms > 0) {
      const d = new Date(ms);
      try { fs.utimesSync(target.target, d, d); } catch {}
    }
    const st = fs.statSync(target.target);
    return {
      status: 200,
      body: {
        ok: true,
        path: norm,
        sha256: sha256Buf(buf),
        mtimeMs: Math.round(st.mtimeMs),
        size: buf.length,
      },
    };
  } catch (e) {
    return { status: 500, error: `Falha ao gravar arquivo sincronizado: ${e.message}` };
  }
}

// Identifica pasta do projeto seed local default caso o local só tenha o seed inicial não usado na VPS
function detectLocalSeedPathsToSkip(wsRoot, localFiles, remoteHasWorkspaceJson) {
  if (!remoteHasWorkspaceJson) return [];
  const wsFile = path.join(wsRoot, 'workspace.json');
  if (!fs.existsSync(wsFile)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    const ents = Array.isArray(raw && raw.entities) ? raw.entities : [];
    if (ents.length === 1 && ents[0] && ents[0].id === 'ai-hud-workspace' && ents[0].folder) {
      const prefix = `${normalizeSyncPath(ents[0].folder)}/`;
      return localFiles.map((f) => f.path).filter((p) => p.startsWith(prefix));
    }
  } catch {}
  return [];
}

function findPrimaryPeer(config, peers) {
  const list = (peers && Array.isArray(peers.list) && peers.list) || [];
  if (!list.length) return null;
  const cfgPeers = Array.isArray(config && config.peers) ? config.peers : [];
  const explicitName = String((config && config.workspacePrimaryPeer) || '').trim();
  if (explicitName) {
    return list.find((p) => p.name === explicitName) || null;
  }
  const flagged = cfgPeers.find((p) => p && p.primary === true && p.url && p.token);
  if (flagged) {
    return list.find((p) => p.name === flagged.name || p.url === flagged.url) || null;
  }
  return null;
}

function createWorkspacePeerSync({
  dataDir,
  config,
  peers,
  machineName = '',
  callPeer = call,
  now = () => Date.now(),
  log = () => {},
}) {
  let inFlight = false;
  let lastSyncAt = 0;
  let lastAttemptAt = 0;
  let lastError = '';
  let lastSummary = null;
  let primaryOnline = null;
  let timer = null;
  let startupTimer = null;
  let stopped = false;

  const wsRoot = () => resolveWorkspaceRoot(dataDir, config);
  const statePath = () => path.join(wsRoot(), '.ai-workspace', 'peer-sync-state.json');

  function loadState(peerName) {
    try {
      const all = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      const entry = all && all[peerName];
      return entry && typeof entry === 'object' ? entry : { files: {}, rootHash: '' };
    } catch {
      return { files: {}, rootHash: '' };
    }
  }

  function saveState(peerName, entry) {
    const file = statePath();
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    all[peerName] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function getPrimaryPeer(peerName = '') {
    if (peerName && peers && Array.isArray(peers.list)) {
      return peers.list.find((p) => p.name === peerName) || null;
    }
    return findPrimaryPeer(config, peers);
  }

  function status() {
    const primary = getPrimaryPeer();
    const state = primary ? loadState(primary.name) : { files: {}, rootHash: '' };
    return {
      ok: true,
      enabled: !!primary,
      primaryPeer: primary ? primary.name : '',
      primaryUrl: primary ? primary.url : '',
      primaryOnline,
      syncing: inFlight,
      lastSyncAt,
      lastAttemptAt,
      lastError,
      trackedFiles: Object.keys(state.files || {}).length,
      lastSummary,
    };
  }

  async function syncNow({ peerName = '', force = false } = {}) {
    const peer = getPrimaryPeer(peerName);
    if (!peer) {
      return { status: 200, body: { ok: false, skipped: true, reason: 'Nenhum peer primário configurado (marque primary: true em config.json).' } };
    }
    if (inFlight) {
      return { status: 409, body: { ok: false, error: 'Sincronização peer-to-peer já em andamento.' } };
    }
    inFlight = true;
    lastAttemptAt = now();
    try {
      const root = wsRoot();
      fs.mkdirSync(root, { recursive: true });
      const remoteRes = await callPeer(peer, 'GET', '/api/workspace/peer-sync/manifest', null, 12000);
      if (!remoteRes || remoteRes.status !== 200 || !remoteRes.json || !Array.isArray(remoteRes.json.files)) {
        primaryOnline = false;
        lastError = (remoteRes && remoteRes.text && remoteRes.text.slice(0, 200)) || `Peer ${peer.name} indisponível.`;
        return { status: 502, body: { ok: false, error: lastError, primaryPeer: peer.name } };
      }

      primaryOnline = true;
      const localManifest = buildWorkspaceManifest(root, machineName);
      const remoteManifest = remoteRes.json;
      const saved = loadState(peer.name);

      if (!force && saved.rootHash && saved.rootHash === localManifest.rootHash && saved.rootHash === remoteManifest.rootHash) {
        lastSyncAt = now();
        lastError = '';
        lastSummary = { peer: peer.name, pulled: 0, pushed: 0, conflicts: 0, skipped: localManifest.count };
        return { status: 200, body: { ok: true, ...lastSummary, unchanged: true } };
      }

      const remoteHasWs = remoteManifest.files.some((f) => f.path === 'workspace.json');
      const prevIgnored = Array.isArray(saved.ignoredLocalPaths) ? saved.ignoredLocalPaths : [];
      const detectedSeed = Object.keys(saved.files || {}).length === 0
        ? detectLocalSeedPathsToSkip(root, localManifest.files, remoteHasWs)
        : [];
      const skipInitialLocalPaths = [...new Set([...prevIgnored, ...detectedSeed])];
      const plan = planWorkspaceSync({
        localFiles: localManifest.files,
        remoteFiles: remoteManifest.files,
        lastState: saved.files || {},
        preferRemote: true,
        skipInitialLocalPaths,
      });

      let pulled = 0;
      let pushed = 0;
      const errors = [];

      for (const item of plan.pulls) {
        try {
          const fr = await callPeer(
            peer,
            'GET',
            `/api/workspace/peer-sync/file?path=${encodeURIComponent(item.path)}`,
            null,
            20000,
          );
          if (!fr || fr.status !== 200 || !fr.json || typeof fr.json.contentBase64 !== 'string') {
            errors.push(`pull ${item.path}: HTTP ${(fr && fr.status) || 0}`);
            continue;
          }
          const wr = writeSyncFile(root, {
            relPath: item.path,
            contentBase64: fr.json.contentBase64,
            mtimeMs: fr.json.mtimeMs,
          });
          if (wr.status !== 200) {
            errors.push(`write ${item.path}: ${wr.error}`);
            continue;
          }
          pulled += 1;
        } catch (e) {
          errors.push(`pull ${item.path}: ${e.message}`);
        }
      }

      for (const item of plan.pushes) {
        try {
          const lr = readSyncFile(root, item.path);
          if (lr.status !== 200) {
            errors.push(`read ${item.path}: ${lr.error}`);
            continue;
          }
          const pr = await callPeer(peer, 'PUT', '/api/workspace/peer-sync/file', {
            path: item.path,
            contentBase64: lr.body.contentBase64,
            mtimeMs: lr.body.mtimeMs,
            baseSha256: item.remote ? item.remote.sha256 : '',
          }, 20000);
          if (!pr || pr.status !== 200) {
            errors.push(`push ${item.path}: HTTP ${(pr && pr.status) || 0}`);
            continue;
          }
          pushed += 1;
        } catch (e) {
          errors.push(`push ${item.path}: ${e.message}`);
        }
      }

      // Recalcula estado pós-sync para registrar o baseline 3-way
      const afterLocal = buildWorkspaceManifest(root, machineName);
      const nextFiles = {};
      for (const f of afterLocal.files) {
        if (!skipInitialLocalPaths.includes(f.path)) nextFiles[f.path] = f.sha256;
      }
      if (!errors.length) {
        saveState(peer.name, {
          updatedAt: now(),
          rootHash: afterLocal.rootHash,
          ignoredLocalPaths: skipInitialLocalPaths,
          files: nextFiles,
        });
      }

      lastSyncAt = now();
      lastError = errors.length ? errors.slice(0, 3).join('; ') : '';
      lastSummary = {
        peer: peer.name,
        pulled,
        pushed,
        conflicts: plan.conflicts.length,
        skipped: plan.skipped,
        errors,
      };
      if (pulled > 0 || pushed > 0) {
        log(`workspace peer-sync (${peer.name}): ↓${pulled} ↑${pushed}${plan.conflicts.length ? ` conflitos:${plan.conflicts.length}` : ''}`);
      }
      return { status: errors.length ? 207 : 200, body: { ok: errors.length === 0, ...lastSummary } };
    } catch (e) {
      primaryOnline = false;
      lastError = e.message || 'Falha de rede no peer-sync.';
      return { status: 502, body: { ok: false, error: lastError, primaryPeer: peer.name } };
    } finally {
      inFlight = false;
    }
  }

  function startAutoSync() {
    if (stopped) return;
    const primary = getPrimaryPeer();
    if (!primary) return;
    const ms = typeof config.workspacePeerSyncMs === 'number' ? config.workspacePeerSyncMs : DEFAULT_INTERVAL_MS;
    if (ms <= 0 || timer) return;

    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (!stopped) syncNow().catch(() => {});
    }, STARTUP_DELAY_MS);
    if (startupTimer.unref) startupTimer.unref();

    timer = setInterval(() => {
      if (!stopped) syncNow().catch(() => {});
    }, ms);
    if (timer.unref) timer.unref();
  }

  function notifyPeerOnline(peerName) {
    if (stopped || inFlight) return;
    const primary = getPrimaryPeer();
    if (!primary || primary.name !== peerName) return;
    if (primaryOnline === false || lastSyncAt === 0) {
      syncNow().catch(() => {});
    }
  }

  function stopAutoSync() {
    stopped = true;
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    status,
    syncNow,
    startAutoSync,
    stopAutoSync,
    notifyPeerOnline,
    manifest: () => buildWorkspaceManifest(wsRoot(), machineName),
    readFile: (relPath) => readSyncFile(wsRoot(), relPath),
    writeFile: (opts) => writeSyncFile(wsRoot(), opts),
  };
}

module.exports = {
  createWorkspacePeerSync,
  buildWorkspaceManifest,
  readSyncFile,
  writeSyncFile,
};
