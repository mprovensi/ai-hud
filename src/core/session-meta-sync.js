// Funções puras para sincronização bidirecional de session-meta (pin, alias, grupo) entre hubs multi-máquina.
// Camada core/: zero I/O. Traduz chaves locais (`id` / `m<n>:id`) em chaves canônicas (`<ownerMachine>::<rawId>`).

const PEER_PREFIX_RE = /^m(\d+):(.+)$/;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sanitizeMetaEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const updatedAt = Number(raw.updatedAt) || 0;
  if (raw.deleted) {
    return { deleted: true, updatedAt };
  }
  const pinned = !!raw.pinned;
  const alias = typeof raw.alias === 'string' ? raw.alias.trim().slice(0, 120) : '';
  const group = typeof raw.group === 'string' ? raw.group.trim().slice(0, 60) : '';
  if (!pinned && !alias && !group) {
    return updatedAt > 0 ? { deleted: true, updatedAt } : null;
  }
  return { pinned, alias, group, updatedAt };
}

function sameMetaValue(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (!!a.deleted !== !!b.deleted) return false;
  if (a.deleted && b.deleted) return (a.updatedAt || 0) === (b.updatedAt || 0);
  return !!a.pinned === !!b.pinned
    && String(a.alias || '') === String(b.alias || '')
    && String(a.group || '') === String(b.group || '');
}

// Converte o mapa local do hub em entradas canônicas `{ "<ownerMachine>::<rawId>": entry }`
function toCanonicalMetaMap(localMap, { machineName = '', peerNamesByIndex = {}, now = Date.now() } = {}) {
  const out = {};
  if (!localMap || typeof localMap !== 'object') return out;
  for (const [key, raw] of Object.entries(localMap)) {
    const clean = sanitizeMetaEntry(raw);
    if (!clean) continue;
    if (clean.deleted && clean.updatedAt && now - clean.updatedAt > TOMBSTONE_TTL_MS) continue;
    let owner = machineName;
    let rawId = key;
    const m = PEER_PREFIX_RE.exec(key);
    if (m) {
      const idx = Number(m[1]);
      if (!peerNamesByIndex[idx]) continue;
      owner = peerNamesByIndex[idx];
      rawId = m[2];
    }
    if (!owner || !rawId) continue;
    const cKey = `${owner}::${rawId}`;
    const prev = out[cKey];
    if (!prev || (clean.updatedAt || 0) >= (prev.updatedAt || 0)) {
      out[cKey] = clean;
    }
  }
  return out;
}

// Traduz uma chave canônica `<ownerMachine>::<rawId>` para a chave local do hub receptor
function canonicalKeyToLocal(canonicalKey, { machineName = '', peerIndexByName = {} } = {}) {
  const sep = String(canonicalKey || '').indexOf('::');
  if (sep <= 0) return null;
  const owner = canonicalKey.slice(0, sep);
  const rawId = canonicalKey.slice(sep + 2);
  if (!owner || !rawId || rawId.length > 150) return null;
  if (owner === machineName) return rawId;
  if (Object.prototype.hasOwnProperty.call(peerIndexByName, owner)) {
    return `m${peerIndexByName[owner]}:${rawId}`;
  }
  return null;
}

// Merge LWW por `updatedAt`: devolve somente as entradas locais que precisam ser atualizadas a partir do peer
function planSessionMetaMerge(localMap, remoteCanonicalMap, { machineName = '', peerIndexByName = {} } = {}) {
  const updates = {};
  if (!remoteCanonicalMap || typeof remoteCanonicalMap !== 'object') return updates;
  for (const [cKey, raw] of Object.entries(remoteCanonicalMap)) {
    const incoming = sanitizeMetaEntry(raw);
    if (!incoming) continue;
    const localKey = canonicalKeyToLocal(cKey, { machineName, peerIndexByName });
    if (!localKey) continue;
    const cur = sanitizeMetaEntry(localMap && localMap[localKey]);
    if (cur && (cur.updatedAt || 0) >= (incoming.updatedAt || 0)) continue;
    if (cur && sameMetaValue(cur, incoming)) continue;
    if (!cur && incoming.deleted) continue;
    updates[localKey] = incoming;
  }
  return updates;
}

module.exports = {
  TOMBSTONE_TTL_MS,
  sanitizeMetaEntry,
  sameMetaValue,
  toCanonicalMetaMap,
  canonicalKeyToLocal,
  planSessionMetaMerge,
};
