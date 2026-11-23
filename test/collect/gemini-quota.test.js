const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { geminiQuota, parseAgyUsage, parseGeminiBuckets } = require('../../src/collect/quotas/gemini');
const { pace, burn } = require('../../src/core/quota-pace');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hud-gemini-quota-'));
}

test('parseAgyUsage extrai janelas de 5h e 7 dias do grupo Gemini Models', () => {
  const q = parseAgyUsage({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.92, reset_time: '2026-11-30T13:41:59Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.747, reset_time: '2026-11-23T18:41:59Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-11-23T19:00:00Z' },
            ],
          },
        ],
      },
    },
  });
  assert.equal(q.plan, 'Antigravity');
  assert.equal(q.windows.five_hour.used, 25.3);
  assert.equal(q.windows.five_hour.resetsAt, Date.parse('2026-11-23T18:41:59Z'));
  assert.equal(q.windows.seven_day.used, 8);
  assert.equal(q.windows.seven_day.resetsAt, Date.parse('2026-11-30T13:41:59Z'));
});

test('geminiQuota prioriza Antigravity CLI (agy) sem depender de oauth_creds.json', async () => {
  const root = tmpRoot();
  // Mesmo com oauth_creds.json expirado, o agy responde com as cotas de 5h e 7d
  fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ access_token: 'expired', expiry_date: 1 }));
  const q = await geminiQuota({
    root,
    agyExe: 'agy.exe',
    execAgy: async () => ({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [{
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.6, reset_time: '2026-11-23T18:00:00Z' },
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.85, reset_time: '2026-11-30T18:00:00Z' },
            ],
          }],
        },
      },
    }),
  });
  assert.equal(q.plan, 'Antigravity');
  assert.equal(q.windows.five_hour.used, 40);
  assert.equal(q.windows.seven_day.used, 15);
});

test('parseGeminiBuckets separa Pro e Flash escolhendo o balde mais restrito de cada família', () => {
  const windows = parseGeminiBuckets([
    { modelId: 'gemini-2.5-pro', remainingFraction: 0.72, resetTime: '2026-11-24T00:00:00Z' },
    { modelId: 'gemini-3-pro-preview', remainingFraction: 0.40, resetTime: '2026-11-24T01:00:00Z' },
    { modelId: 'gemini-2.5-flash', remainingFraction: 0.90, resetTime: '2026-11-24T00:00:00Z' },
  ]);
  assert.equal(windows.pro.used, 60);
  assert.equal(windows.pro.modelId, 'gemini-3-pro-preview');
  assert.equal(windows.flash.used, 10);
  assert.equal(windows.flash.modelId, 'gemini-2.5-flash');
  assert.equal(windows.daily, undefined);

  const fallback = parseGeminiBuckets([{ modelId: 'gemini-custom', remainingFraction: 0.25, resetTime: '2026-11-24T00:00:00Z' }]);
  assert.equal(fallback.daily.used, 75);
});

test('geminiQuota (fallback OAuth) retorna sem cota quando não há oauth_creds ou quando usa API key', async () => {
  const root = tmpRoot();
  assert.deepEqual(await geminiQuota({ root, agyExe: null }), { plan: null, windows: {} });

  fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ access_token: 'tok', expiry_date: Date.now() + 3600e3 }));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
  assert.deepEqual(await geminiQuota({ root, agyExe: null }), { plan: null, windows: {} });
});

test('geminiQuota (fallback OAuth) lê plano e janelas do Code Assist com token válido', async () => {
  const root = tmpRoot();
  const now = Date.UTC(2026, 10, 23, 12);
  fs.writeFileSync(path.join(root, 'oauth_creds.json'), JSON.stringify({ access_token: 'valid-tok', expiry_date: now + 3600e3 }));
  const calls = [];
  const request = async (url, headers, body) => {
    calls.push({ url, auth: headers.Authorization, body });
    if (url.endsWith(':loadCodeAssist')) {
      return { status: 200, body: JSON.stringify({ cloudaicompanionProject: 'proj-123', paidTier: { id: 'pro', name: 'Gemini Pro' } }) };
    }
    return {
      status: 200,
      body: JSON.stringify({
        buckets: [
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.65, resetTime: new Date(now + 12 * 3600e3).toISOString() },
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.92, resetTime: new Date(now + 12 * 3600e3).toISOString() },
        ],
      }),
    };
  };
  const q = await geminiQuota({ root, agyExe: null, request, now: () => now });
  assert.equal(q.plan, 'Gemini Pro');
  assert.equal(q.windows.pro.used, 35);
  assert.equal(q.windows.flash.used, 8);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { project: 'proj-123' });
});

test('geminiQuota (fallback OAuth) renova token expirado só em memória sem alterar oauth_creds.json no disco', async () => {
  const root = tmpRoot();
  const now = Date.UTC(2026, 10, 23, 12);
  const credsFile = path.join(root, 'oauth_creds.json');
  const raw = JSON.stringify({ access_token: 'old-tok', refresh_token: 'ref-tok', expiry_date: now - 1000 });
  fs.writeFileSync(credsFile, raw);

  const request = async (url) => {
    if (url.includes('oauth2.googleapis.com')) return { status: 200, body: JSON.stringify({ access_token: 'fresh-tok', expires_in: 3600 }) };
    if (url.endsWith(':loadCodeAssist')) return { status: 200, body: JSON.stringify({ currentTier: { name: 'Free' } }) };
    return { status: 200, body: JSON.stringify({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime: new Date(now + 6 * 3600e3).toISOString() }] }) };
  };
  const q = await geminiQuota({ root, agyExe: null, request, now: () => now, clientCreds: { clientId: 'cid', clientSecret: 'csec' } });
  assert.equal(q.plan, 'Free');
  assert.equal(q.windows.pro.used, 50);
  assert.equal(fs.readFileSync(credsFile, 'utf8'), raw, 'não pode modificar ~/.gemini/oauth_creds.json');

  // Sem clientCreds e expirado: erro claro e soft
  const root2 = tmpRoot();
  fs.writeFileSync(path.join(root2, 'oauth_creds.json'), JSON.stringify({ access_token: 'old', refresh_token: 'ref2', expiry_date: now - 1000 }));
  await assert.rejects(() => geminiQuota({ root: root2, agyExe: null, request, now: () => now, clientCreds: null }), (err) => err.soft === true && /expirada/i.test(err.message));
});

test('pace e burn funcionam para janelas de 5h (Antigravity) e 24h (legado) do Gemini', () => {
  const now = Date.UTC(2026, 10, 23, 12);
  const w5 = { used: 25, resetsAt: now + 2.5 * 3600e3 };
  const b5 = burn({ gemini: { windows: { five_hour: w5 } } }, {}, now, []);
  assert.equal(b5.gemini.window, 'five_hour');
  assert.equal(b5.gemini.start, w5.resetsAt - 5 * 3600e3);

  const w24 = { used: 60, resetsAt: now + 12 * 3600e3 };
  const history = { 'gemini.pro': { resetsAt: w24.resetsAt, samples: [[now - 30 * 60e3, 55], [now, 60]] } };
  const p = pace(history, 'gemini', 'pro', w24, now);
  assert.equal(p.expected, 50);
  assert.equal(p.basis, 'recent');
  assert.equal(p.projected, 180);
  assert.equal(p.runsOutIn, 4 * 3600e3);

  const b24 = burn({ gemini: { windows: { pro: w24 } } }, history, now, []);
  assert.equal(b24.gemini.window, 'pro');
  assert.equal(b24.gemini.start, w24.resetsAt - 24 * 3600e3);
});
