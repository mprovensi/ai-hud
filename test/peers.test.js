const test = require('node:test');
const assert = require('node:assert/strict');
const { Peers, compareSessions } = require('../src/peers');

function snapshot(active = []) {
  return { active, recent: [], quotas: {}, today: { Codex: { fresh: 0, cacheRead: 0 } },
    sessionsToday: { Codex: 0 }, hours: [], days: [] };
}

function hub(remote) {
  const peers = new Peers([]);
  peers.list = [{ i: 0, name: 'remote', at: Date.now(), snap: remote }];
  return peers;
}

test('hub prioritizes permissions then latest activity across machines', () => {
  const local = snapshot([{ id: 'waiting', state: 'waiting', end: 10 }, { id: 'permission-old', state: 'permission', end: 1 }]);
  const remote = snapshot([{ id: 'working', state: 'working', end: 100 }, { id: 'permission-new', state: 'permission', end: 2 }]);
  const result = hub(remote).merge(local, 'local');
  assert.deepEqual(result.active.map((s) => s.id), ['m0:permission-new', 'permission-old', 'm0:working', 'waiting']);
  assert.equal(local.active[0].id, 'waiting', 'merge must not mutate cached snapshots');
});

test('recent Codex work precedes an older waiting Ollama without pinning tools', () => {
  const codex = { id: 'codex', tool: 'Codex', state: 'working', end: 2000 };
  const ollama = { id: 'ollama', tool: 'Ollama', state: 'waiting', end: 1000 };
  assert.deepEqual([ollama, codex].sort(compareSessions).map((s) => s.id), ['codex', 'ollama']);
  const newerOllama = { ...ollama, end: 3000 };
  assert.deepEqual([codex, newerOllama].sort(compareSessions).map((s) => s.id), ['ollama', 'codex']);
});

test('equal timestamps have deterministic order regardless of input order', () => {
  const a = { id: 'a', state: 'working', end: 1000 };
  const b = { id: 'b', state: 'working', end: 1000 };
  assert.deepEqual([b, a].sort(compareSessions).map((s) => s.id), ['a', 'b']);
  assert.deepEqual([a, b].sort(compareSessions).map((s) => s.id), ['a', 'b']);
});

test('hub merges hours and days by timestamp across window boundaries', () => {
  const row = (t, value) => ({ t, Codex: value, 'Claude Code': value });
  const local = snapshot();
  local.hours = [row(3600000, 1), row(7200000, 2)];
  local.days = [row(86400000, 3), row(172800000, 4)];
  const before = JSON.stringify(local);
  const remote = snapshot();
  remote.hours = [row(0, 100), row(3600000, 10)];
  remote.days = [row(0, 200), row(86400000, 20)];
  const result = hub(remote).merge(local, 'local');
  assert.deepEqual(result.hours, [row(3600000, 11), row(7200000, 2)]);
  assert.deepEqual(result.days, [row(86400000, 23), row(172800000, 4)]);
  assert.equal(JSON.stringify(local), before);
});

test('hub keeps a known Ollama of an unreachable peer as offline', () => {
  const peers = new Peers([]);
  peers.list = [{ i: 0, name: 'PC-Desktop', at: 0, snap: null, ollamas: [{ machine: 'PC-Desktop', version: '0.12', installed: 3 }] }];
  const result = peers.merge({ ...snapshot(), ollama: { online: false, models: [] } }, 'local');
  assert.deepEqual(result.ollamas.map((o) => [o.machine, o.online, !!o.unreachable]), [['local', false, false], ['PC-Desktop', false, true]]);
  assert.equal(result.ollamas[1].version, '0.12');
});

test('hub remembers which peers have Ollama when they answer', () => {
  const peers = new Peers([]);
  const p = { i: 0, name: 'PC-Desktop', snap: { ollamas: [{ online: true, version: '0.12', models: [] }] }, ollamas: [] };
  peers.list = [p];
  peers.rememberOllamas(p);
  assert.deepEqual(p.ollamas, [{ machine: 'PC-Desktop', version: '0.12', installed: null }]);
});
