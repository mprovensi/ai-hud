const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('../helpers/app-source');
const start = app.indexOf('  function checkAlerts(s)');
const end = app.indexOf('\n  function setRemoteBtn', start);
assert.ok(start >= 0 && end > start);

function client() {
  const messages = [];
  let beeps = 0;
  const context = { prevStates: null, prevCompleted: null, pings: {}, quotaAlerted: {},
    beep: () => { beeps++; }, flash: (text) => messages.push(text), isSeen: () => false };
  vm.runInNewContext(app.slice(start, end) + '\nthis.checkAlerts = checkAlerts;', context);
  return { context, messages, beeps: () => beeps };
}

function snapshot(state, completedAt, now = completedAt + 100) {
  return { now, active: [{ id: 'test', tool: 'Codex', project: 'Teste', state, completedAt }], quotas: {} };
}

test('fast replies notify and highlight the card even when polling misses working', () => {
  const c = client();
  c.context.checkAlerts(snapshot('waiting', 1000));
  assert.equal(c.messages.length, 0, 'initial load must not notify old replies');
  c.context.checkAlerts(snapshot('waiting', 2000));
  assert.equal(c.messages.length, 1);
  assert.equal(c.beeps(), 1);
  assert.equal(c.context.pings.test, 2100);
  c.context.checkAlerts(snapshot('waiting', 2000, 3000));
  assert.equal(c.messages.length, 1, 'same completion must not notify twice');
  c.context.checkAlerts(snapshot('waiting', 4000));
  assert.equal(c.messages.length, 2, 'another short reply must notify again');
});

test('normal working to waiting transitions notify once', () => {
  const c = client();
  c.context.checkAlerts(snapshot('waiting', 1000));
  c.context.checkAlerts(snapshot('working', 1000, 1500));
  c.context.checkAlerts(snapshot('waiting', 2000));
  c.context.checkAlerts(snapshot('waiting', 2000, 3000));
  assert.equal(c.messages.length, 1);
});

test('older peers without completion markers still notify on state transitions', () => {
  const c = client();
  c.context.checkAlerts(snapshot('working', undefined, 1000));
  c.context.checkAlerts(snapshot('waiting', undefined, 2000));
  c.context.checkAlerts(snapshot('waiting', undefined, 3000));
  assert.equal(c.messages.length, 1);
});

test('permission transitions retain their notifications', () => {
  const c = client();
  c.context.checkAlerts(snapshot('working', 0, 1000));
  const permission = snapshot('permission', 0, 2000);
  permission.active[0].permission = { tool: 'Teste' };
  c.context.checkAlerts(permission);
  c.context.checkAlerts(permission);
  assert.equal(c.messages.length, 1);
});

test('high or nearly exhausted AI quotas do not trigger toast or sound alerts', () => {
  const c = client();
  const snap = {
    now: 1000,
    active: [],
    quotas: {
      claude: { windows: { five_hour: { used: 96, resetsAt: 50000, pace: { runsOutIn: 5 * 60e3 } } } },
      codex: { windows: { five_hour: { used: 99, resetsAt: 60000, pace: { runsOutIn: 2 * 60e3 } } } },
      gemini: { windows: { pro: { used: 95, resetsAt: 70000, pace: { runsOutIn: 10 * 60e3 } } } },
    },
  };
  c.context.checkAlerts(snap);
  c.context.checkAlerts({ ...snap, now: 2000 });
  assert.equal(c.messages.length, 0);
  assert.equal(c.beeps(), 0);
});
