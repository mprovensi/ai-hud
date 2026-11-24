// Metadados definidos pelo usuário para sessões: fixar (pinned), apelido (alias) e grupo (group).
// Persistido em data/session-meta.json no Hub (funciona inclusive para sessões federadas `m<n>:...`).
const path = require('path');
const { readJson, writeJson } = require('../infra/store');

const MAX_ENTRIES = 500;

function createSessionMeta(dataDir) {
  const file = path.join(dataDir, 'session-meta.json');
  const map = readJson(file, {});

  function persist() {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => { delete map[k]; });
    }
    writeJson(file, map, true);
  }

  function get(id) {
    return (id && map[id]) || null;
  }

  function all() {
    return map;
  }

  function set({ id, pinned, alias, group }) {
    const key = String(id || '').trim();
    if (!key || key.length > 160) return { status: 400, body: 'id da sessão inválido' };
    const cur = { ...(map[key] || {}) };
    if (typeof pinned === 'boolean') cur.pinned = pinned;
    if (typeof alias === 'string') cur.alias = alias.trim().slice(0, 120);
    if (typeof group === 'string') cur.group = group.trim().slice(0, 60);
    cur.updatedAt = Date.now();
    if (!cur.pinned && !cur.alias && !cur.group) {
      delete map[key];
    } else {
      map[key] = cur;
    }
    persist();
    return { status: 200, body: { ok: true, id: key, meta: map[key] || { pinned: false, alias: '', group: '' } } };
  }

  return { get, all, set };
}

module.exports = { createSessionMeta };
