const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createWebAssets } = require('../src/web-assets');
const directory = path.join(__dirname, '../public');

test('the server generates one content version and freezes all resources until restart', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-assets-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  for (const file of ['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png']) {
    fs.copyFileSync(path.join(directory, file), path.join(scratch, file));
  }
  fs.cpSync(path.join(directory, 'js'), path.join(scratch, 'js'), { recursive: true });
  fs.cpSync(path.join(directory, 'css'), path.join(scratch, 'css'), { recursive: true });
  const before = createWebAssets(scratch);
  assert.equal(createWebAssets(scratch).version, before.version);
  for (const url of ['/app.js', '/app.css']) {
    assert.ok(before.html.includes(`${url}?v=${before.version}`));
    assert.ok(before.shell.includes(`${url}?v=${before.version}`));
  }
  assert.ok(!before.html.includes('__HUD_'));
  assert.ok(!before.assets['/sw.js'].includes('__HUD_'));
  fs.appendFileSync(path.join(scratch, 'js', 'main.js'), '\n// new version\n');
  assert.notEqual(createWebAssets(scratch).version, before.version);
  assert.ok(!before.assets['/app.js'].includes('// new version'));
});

function worker() {
  const bundle = createWebAssets(directory), listeners = {}, buckets = new Map();
  let fetcher = async () => { throw new Error('offline'); };
  const caches = {
    open: async (name) => {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const cache = buckets.get(name);
      return {
        addAll: async (urls) => { for (const url of urls) cache.set(url, { shell: true, url }); },
        match: async (key) => cache.get(key),
        put: async (key, value) => { cache.set(key, value); },
      };
    },
    keys: async () => [...buckets.keys()],
    delete: async (key) => buckets.delete(key),
  };
  const context = { URL, location: { origin: 'https://hud.test' }, caches, fetch: (...args) => fetcher(...args),
    self: { addEventListener: (name, listener) => { listeners[name] = listener; },
      skipWaiting: async () => {}, clients: { claim: async () => {} } } };
  vm.runInNewContext(bundle.assets['/sw.js'], context);
  async function event(name, request) {
    const pending = []; let response;
    listeners[name]({ request, waitUntil: (promise) => pending.push(promise), respondWith: (promise) => { response = promise; } });
    const value = await response;
    await Promise.all(pending);
    return value;
  }
  const request = (url, method = 'GET') => ({ url: 'https://hud.test' + url, method });
  return { bundle, buckets, event, request, network: (callback) => { fetcher = callback; } };
}

test('offline uses exactly the precached resources, and never caches API responses', async () => {
  const w = worker();
  await w.event('install');
  const page = await w.event('fetch', w.request('/?t=secret'));
  assert.equal(page.url, '/');
  const js = await w.event('fetch', w.request('/app.js?v=' + w.bundle.version));
  assert.equal(js.url, '/app.js?v=' + w.bundle.version);
  assert.equal(await w.event('fetch', w.request('/api/snapshot?t=secret')), undefined);
  assert.equal(await w.event('fetch', w.request('/app.js?v=obsolete')), undefined);
  assert.equal(await w.event('fetch', w.request('/login', 'POST')), undefined);
});

test('an old worker returns new online HTML without putting it in its old offline cache', async () => {
  const w = worker();
  await w.event('install');
  const page = { ok: true, headers: { get: () => 'different-version' }, clone: () => { throw new Error('must not cache'); } };
  w.network(async () => page);
  assert.equal(await w.event('fetch', w.request('/')), page);
  w.network(async () => { throw new Error('offline'); });
  assert.equal((await w.event('fetch', w.request('/'))).shell, true);
});

test('worker activation removes only obsolete AI HUD caches', async () => {
  const w = worker();
  await w.event('install');
  w.buckets.set('ai-hud-old', new Map());
  w.buckets.set('another-app', new Map());
  await w.event('activate');
  assert.deepEqual([...w.buckets.keys()], ['ai-hud-' + w.bundle.version, 'another-app']);
});

test('a stopped backend and a version change both preserve a coherent cached shell', async () => {
  const w = worker();
  await w.event('install');
  w.network(async () => ({ ok: false, status: 502 }));
  assert.equal((await w.event('fetch', w.request('/'))).shell, true);
  w.network(async () => ({ ok: false, status: 409 }));
  const url = '/app.js?v=' + w.bundle.version;
  assert.equal((await w.event('fetch', w.request(url))).url, url);
});
