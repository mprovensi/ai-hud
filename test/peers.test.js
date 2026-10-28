const test = require('node:test');
const assert = require('node:assert/strict');
const { Peers } = require('../peers');

function snapshot(active = []) {
  return { active, recent: [], quotas: {}, today: { Codex: { fresh: 0, cacheRead: 0 } },
    sessionsToday: { Codex: 0 }, hours: [], days: [] };
}

function hub(remote) {
  const peers = new Peers([]);
  peers.list = [{ i: 0, name: 'remote', at: Date.now(), snap: remote }];
  return peers;
}

test('hub prioritizes permissions and waiting sessions across machines', () => {
  const local = snapshot([{ id: 'waiting', state: 'waiting', end: 10 }, { id: 'permission-old', state: 'permission', end: 1 }]);
  const remote = snapshot([{ id: 'working', state: 'working', end: 100 }, { id: 'permission-new', state: 'permission', end: 2 }]);
  const result = hub(remote).merge(local, 'local');
  assert.deepEqual(result.active.map((s) => s.id), ['m0:permission-new', 'permission-old', 'waiting', 'm0:working']);
  assert.equal(local.active[0].id, 'waiting', 'merge must not mutate cached snapshots');
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
