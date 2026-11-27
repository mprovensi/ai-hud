// Metadados definidos pelo usuário para sessões: fixar (pinned), apelido (alias) e grupo (group).
// Persistido em data/session-meta.json no Hub (funciona inclusive para sessões federadas `m<n>:...`)
// e sincronizado bidirecionalmente entre hubs (VPS <-> Local) com tombstones LWW.
const path = require('path');
const { readJson, writeJson } = require('../infra/store');
const { TOMBSTONE_TTL_MS, sanitizeMetaEntry } = require('../core/session-meta-sync');

const MAX_ENTRIES = 500;

function createSessionMeta(dataDir) {
  const file = path.join(dataDir, 'session-meta.json');
  const map = readJson(file, {});

  function persist() {
    const now = Date.now();
    for (const k of Object.keys(map)) {
      const e = map[k];
      if (e && e.deleted && e.updatedAt && now - e.updatedAt > TOMBSTONE_TTL_MS) {
        delete map[k];
      }
    }
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => { delete map[k]; });
    }
    return writeJson(file, map, true);
  }

  function get(id) {
    const e = (id && map[id]) || null;
    return e && !e.deleted ? e : null;
  }

  function all() {
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      if (v && !v.deleted) out[k] = v;
    }
    return out;
  }

  function rawAll() {
    return map;
  }

  function applyUpdates(updates) {
    if (!updates || typeof updates !== 'object') return 0;
    const keys = Object.keys(updates);
    if (!keys.length) return 0;
    let applied = 0;
    for (const key of keys) {
      if (!key || key.length > 160) continue;
      const clean = sanitizeMetaEntry(updates[key]);
      if (!clean) continue;
      const cur = map[key];
      if (cur && (cur.updatedAt || 0) >= (clean.updatedAt || 0)) continue;
      map[key] = clean;
      applied += 1;
    }
    if (applied > 0) persist();
    return applied;
  }

  function set({ id, pinned, alias, group }) {
    const key = String(id || '').trim();
    if (!key || key.length > 160) return { status: 400, body: 'id da sessão inválido' };
    const hadPrev = Object.prototype.hasOwnProperty.call(map, key);
    const prev = hadPrev ? { ...map[key] } : null;
    const curBase = prev && !prev.deleted ? prev : {};
    const cur = { ...curBase };
    delete cur.deleted;
    if (typeof pinned === 'boolean') cur.pinned = pinned;
    if (typeof alias === 'string') cur.alias = alias.trim().slice(0, 120);
    if (typeof group === 'string') cur.group = group.trim().slice(0, 60);
    cur.updatedAt = Date.now();
    if (!cur.pinned && !cur.alias && !cur.group) {
      if (hadPrev && prev && !prev.deleted) {
        map[key] = { deleted: true, updatedAt: cur.updatedAt };
      } else {
        delete map[key];
      }
    } else {
      map[key] = cur;
    }
    if (!persist()) {
      if (hadPrev) map[key] = prev;
      else delete map[key];
      return { status: 500, body: 'Falha ao persistir metadados da sessão em disco.' };
    }
    const active = map[key] && !map[key].deleted ? map[key] : { pinned: false, alias: '', group: '' };
    return { status: 200, body: { ok: true, id: key, meta: active } };
  }

  return { get, all, rawAll, applyUpdates, set };
}

module.exports = { createSessionMeta };
