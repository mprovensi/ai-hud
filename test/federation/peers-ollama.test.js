const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Peers } = require('../../src/federation/peers');

function snapshot(ollamas = []) {
  return { active: [], recent: [], quotas: {}, today: {}, sessionsToday: {}, hours: [], days: [], ollamas };
}
function hub() {
  const peers = new Peers([]);
  const peer = { name: 'PC-Desktop', i: 0, at: Date.now(), snap: snapshot(), ollamas: [] };
  peers.list = [peer];
  return { peers, peer };
}

test('an empty remote reply preserves the known Ollama while distinguishing missing telemetry', () => {
  const { peers, peer } = hub();
  peer.snap.ollamas = [{ online: true, version: '1.0', installed: 3, models: [{ name: 'model' }], gpu: { name: 'GPU' } }];
  peers.rememberOllamas(peer);
  peer.snap = snapshot();
  peers.rememberOllamas(peer);
  let state = peers.merge(snapshot(), 'local').ollamas[0];
  assert.equal(state.machine, 'PC-Desktop');
  assert.equal(state.online, false);
  assert.equal(state.unavailable, true);
  assert.equal(state.unreachable, false);
  assert.equal(state.version, '1.0');
  assert.equal(state.installed, 3);
  assert.deepEqual(state.models, []);
  assert.equal(state.gpu, null);
  peer.at = 0;
  state = peers.merge(snapshot(), 'local').ollamas[0];
  assert.equal(state.unreachable, true);
  assert.equal(state.unavailable, false);
  peer.snap = snapshot([{ online: true, models: [{ name: 'new-model' }] }]);
  peer.at = Date.now();
  const restored = peers.merge(snapshot(), 'local').ollamas;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].online, true);
  assert.equal(restored[0].models[0].name, 'new-model');
});

test('known machines and latest metadata survive restart with the desktop already offline', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-peer-ollama-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(Peers.prototype, 'pollAll', () => {});
  t.mock.method(global, 'setInterval', () => null);
  const config = [{ name: 'PC-Desktop', url: 'http://127.0.0.1:1', token: 'fixture' }];
  const file = path.join(directory, 'known.json');
  const peers = new Peers(config, file), peer = peers.list[0];
  peer.snap = snapshot([{ online: true, version: '1.0', installed: null, models: [] }]);
  peers.rememberOllamas(peer);
  peer.snap.ollamas[0].installed = 3;
  peers.rememberOllamas(peer);
  peer.snap = snapshot();
  peers.rememberOllamas(peer);
  const state = new Peers(config, file).merge(snapshot(), 'local').ollamas[0];
  assert.equal(state.machine, 'PC-Desktop');
  assert.equal(state.unreachable, true);
  assert.equal(state.installed, 3);
  assert.equal(state.version, '1.0');
});

test('an explicit peer setting keeps Ollama visible even before its first connection', (t) => {
  t.mock.method(Peers.prototype, 'pollAll', () => {});
  t.mock.method(global, 'setInterval', () => null);
  const peers = new Peers([{ name: 'PC-Desktop', url: 'http://127.0.0.1:1', token: 'fixture', ollama: true }]);
  const state = peers.merge(snapshot(), 'local').ollamas[0];
  assert.equal(state.machine, 'PC-Desktop');
  assert.equal(state.online, false);
  assert.equal(state.unreachable, true);
});

test('only an explicit peer opt-out removes a previously known Ollama', () => {
  const { peers, peer } = hub();
  peer.ollama = false;
  peer.ollamas = [{ machine: 'PC-Desktop' }];
  peer.snap = snapshot([{ online: true, models: [] }]);
  peers.rememberOllamas(peer);
  assert.deepEqual(peer.ollamas, []);
  assert.deepEqual(peers.merge(snapshot(), 'local').ollamas, []);
});
