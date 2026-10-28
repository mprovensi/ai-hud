// Histórico paginado do Codex: os rollouts antigos podem existir só nos bancos locais.
// Abre conexões curtas e somente leitura; sem node:sqlite, mantém o suporte aos JSONL.
const fs = require('fs');
const path = require('path');
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}
const cache = new Map();

function latestDatabase(root, prefix) {
  const files = fs.readdirSync(root).filter((f) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(f));
  files.sort((a, b) => Number(b.match(/_(\d+)\./)[1]) - Number(a.match(/_(\d+)\./)[1]));
  return files.length ? path.join(root, files[0]) : null;
}

function readCodexHistory(root) {
  if (!sqlite) return [];
  let stateFile, historyFile, sig;
  try {
    stateFile = latestDatabase(root, 'state');
    if (!stateFile) return [];
    historyFile = latestDatabase(root, 'thread_history');
    sig = [stateFile, historyFile].filter(Boolean).flatMap((f) => [f, `${f}-wal`]).map((f) => {
      try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return f; }
    }).join(';');
  } catch { return []; }
  const hit = cache.get(root);
  if (hit && hit.sig === sig && Date.now() - hit.at < 30e3) return hit.rows;
  let state, history;
  try {
    state = new sqlite.DatabaseSync(stateFile, { readOnly: true });
    const rows = state.prepare('SELECT * FROM threads').all().map((thread) => ({ thread, messages: [], turn: null }));
    if (historyFile) {
      history = new sqlite.DatabaseSync(historyFile, { readOnly: true });
      const byId = new Map(rows.map((r) => [r.thread.id, r]));
      for (const item of history.prepare("SELECT thread_id, item_json, created_at_ms FROM thread_items WHERE item_type IN ('userMessage', 'agentMessage') ORDER BY thread_id, rollout_ordinal").all()) {
        const row = byId.get(item.thread_id);
        if (!row) continue;
        try { row.messages.push({ ...JSON.parse(item.item_json), at: item.created_at_ms }); } catch {}
      }
      for (const turn of history.prepare('SELECT thread_id, status, started_at, completed_at FROM thread_turns ORDER BY thread_id, rollout_ordinal').all()) {
        const row = byId.get(turn.thread_id);
        if (row) row.turn = turn;
      }
    }
    cache.set(root, { sig, at: Date.now(), rows });
    return rows;
  } catch {
    return hit ? hit.rows : [];
  } finally {
    try { history && history.close(); } catch {}
    try { state && state.close(); } catch {}
  }
}

module.exports = { readCodexHistory };
