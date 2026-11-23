const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Peers } = require('../../src/federation/peers');
const { compareSessions } = require('../../src/core/session');

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

test('hub merges hours, days and Gemini quota across peers', () => {
  const row = (t, value) => ({ t, Codex: value, 'Claude Code': value, Gemini: value * 2 });
  const local = snapshot();
  local.hours = [row(3600000, 1), row(7200000, 2)];
  local.days = [row(86400000, 3), row(172800000, 4)];
  local.quotas = { gemini: { plan: null, windows: {}, error: 'expirado', at: 100 } };
  const before = JSON.stringify(local);
  const remote = snapshot();
  remote.hours = [row(0, 100), row(3600000, 10)];
  remote.days = [row(0, 200), row(86400000, 20)];
  remote.quotas = { gemini: { plan: 'Gemini Pro', at: 200, windows: { pro: { used: 30, resetsAt: 999999000 } } } };
  const result = hub(remote).merge(local, 'local');
  assert.deepEqual(result.hours, [row(3600000, 11), row(7200000, 2)]);
  assert.deepEqual(result.days, [row(86400000, 23), row(172800000, 4)]);
  assert.equal(result.quotas.gemini.windows.pro.used, 30);
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

test('hub de 3 máquinas alinha days entre fusos diferentes (UTC na VPS + BRT nos PCs) e aproveita burn do peer', () => {
  const now = Date.UTC(2026, 10, 23, 15, 0);
  const vpsDay = Date.UTC(2026, 10, 23, 0, 0);    // 00:00 UTC
  const brtDay = Date.UTC(2026, 10, 23, 3, 0);    // 00:00 BRT (-180 min)
  const local = {
    now, tz: 0, active: [{ id: 'vps-1', state: 'working', end: now - 5000 }], recent: [],
    quotas: { gemini: { plan: null, windows: {} } }, burn: {},
    today: { Codex: { fresh: 10, cacheRead: 0 }, 'Claude Code': { fresh: 0, cacheRead: 0 }, Gemini: { fresh: 0, cacheRead: 0 } },
    sessionsToday: { Codex: 1, 'Claude Code': 0, Gemini: 0 },
    hours: [], days: [{ t: vpsDay, Codex: 10, 'Claude Code': 0, Gemini: 0 }],
  };
  const notebook = {
    now, tz: -180, active: [{ id: 'nb-1', state: 'waiting', end: now - 1000 }], recent: [],
    quotas: { gemini: { plan: 'Antigravity', at: now, windows: { five_hour: { used: 40, resetsAt: now + 3600e3 } } } },
    burn: { gemini: { start: now - 4 * 3600e3, end: now + 3600e3, used: 40, window: 'five_hour', points: [[now, 40]] } },
    today: { Codex: { fresh: 20, cacheRead: 0 }, 'Claude Code': { fresh: 0, cacheRead: 0 }, Gemini: { fresh: 50, cacheRead: 0 } },
    sessionsToday: { Codex: 1, 'Claude Code': 0, Gemini: 2 },
    hours: [], days: [{ t: brtDay, Codex: 20, 'Claude Code': 0, Gemini: 50 }],
  };
  const desktop = {
    now, tz: -180, active: [{ id: 'dt-1', state: 'permission', end: now - 2000 }], recent: [],
    quotas: {}, burn: {},
    today: { Codex: { fresh: 30, cacheRead: 0 }, 'Claude Code': { fresh: 0, cacheRead: 0 }, Gemini: { fresh: 0, cacheRead: 0 } },
    sessionsToday: { Codex: 2, 'Claude Code': 0, Gemini: 0 },
    hours: [], days: [{ t: brtDay, Codex: 30, 'Claude Code': 0, Gemini: 0 }],
  };
  const peers = new Peers([]);
  peers.list = [
    { i: 0, name: 'Notebook', at: Date.now(), snap: notebook },
    { i: 1, name: 'Desktop', at: Date.now(), snap: desktop },
  ];
  const out = peers.merge(local, 'VPS-Oracle');
  assert.deepEqual(out.machines.map((m) => [m.name, m.ok]), [['VPS-Oracle', true], ['Notebook', true], ['Desktop', true]]);
  assert.deepEqual(out.active.map((s) => s.id), ['m1:dt-1', 'm0:nb-1', 'vps-1']);
  assert.equal(out.today.Codex.fresh, 60);
  assert.equal(out.days[0].Codex, 60);
  assert.equal(out.days[0].Gemini, 50);
  assert.equal(out.quotas.gemini.windows.five_hour.used, 40);
  assert.equal(out.burn.gemini.used, 40);
});

test('cache persistente de peer offline preserva today (só do mesmo dia), days, recent e cota válida sem manter active', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-peer-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'peer-cache.json');
  const now = Date.UTC(2026, 10, 23, 15, 0);
  const dayT = Date.UTC(2026, 10, 23, 3, 0);

  const cfg = [{ name: 'Notebook', url: 'http://127.0.0.1:1', token: 'tok' }];
  const p1 = new Peers(cfg, null, cacheFile);
  p1.list[0].at = now - 5 * 60e3;
  p1.list[0].snap = {
    now: now - 5 * 60e3, tz: -180,
    active: [{ id: 'stale-work', state: 'working', end: now - 5 * 60e3 }],
    recent: [{ id: 'old-rec', state: 'closed', end: now - 10 * 60e3 }],
    today: { Codex: { fresh: 500, cacheRead: 100 } },
    sessionsToday: { Codex: 2 },
    hours: [], days: [{ t: dayT, Codex: 500 }],
    quotas: { gemini: { plan: 'Antigravity', at: now - 5 * 60e3, windows: { five_hour: { used: 33, resetsAt: now + 3600e3 } } } },
    burn: { gemini: { used: 33, window: 'five_hour', points: [[now - 5 * 60e3, 33]] } },
  };
  p1.rememberSnapshot(p1.list[0]);

  // Reinicia o hub com o Notebook já offline: carrega de peer-cache.json
  const p2 = new Peers(cfg, null, cacheFile);
  const localSameDay = {
    now, tz: -180, active: [], recent: [], quotas: {}, burn: {},
    today: { Codex: { fresh: 100, cacheRead: 0 } }, sessionsToday: { Codex: 1 },
    hours: [], days: [{ t: dayT, Codex: 100 }],
  };
  const out = p2.merge(localSameDay, 'VPS-Oracle');
  assert.equal(out.machines[1].ok, false);
  assert.deepEqual(out.active, [], 'sessão working de PC offline não fica ativa');
  assert.deepEqual(out.recent.map((s) => s.id), ['m0:old-rec']);
  assert.equal(out.today.Codex.fresh, 600);
  assert.equal(out.days[0].Codex, 600);
  assert.equal(out.quotas.gemini.windows.five_hour.used, 33);
  assert.equal(out.burn.gemini.used, 33);

  // No dia seguinte, o today do cache de ontem NÃO vaza para hoje
  const nextDay = now + 24 * 3600e3;
  const localNextDay = {
    now: nextDay, tz: -180, active: [], recent: [], quotas: {}, burn: {},
    today: { Codex: { fresh: 50, cacheRead: 0 } }, sessionsToday: { Codex: 0 },
    hours: [], days: [{ t: dayT, Codex: 100 }, { t: dayT + 86400e3, Codex: 50 }],
  };
  const outNext = p2.merge(localNextDay, 'VPS-Oracle');
  assert.equal(outNext.today.Codex.fresh, 50, 'today de ontem não soma no dia seguinte');
  assert.equal(outNext.days[0].Codex, 600, 'mas o histórico do dia anterior em days continua completo');
  assert.equal(outNext.quotas.gemini, undefined, 'cota expirada do cache offline é descartada');
});
