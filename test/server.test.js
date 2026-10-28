const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { Peers } = require('../src/peers');

test('actual server routes reject null bodies and malformed tokens without side effects', async (t) => {
  const token = 'a'.repeat(24);
  const root = path.join(__dirname, '..');
  const sessions = [];
  let server, configWrites = 0;
  const sandbox = { __dirname: root, Buffer, URL, URLSearchParams, process: { env: process.env, platform: 'win32' },
    console: { log: () => {} }, setInterval: () => {}, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'http') return { createServer: (handler) => {
        server = http.createServer(handler);
        const listen = server.listen;
        server.listen = (port, host, callback) => listen.call(server, 0, '127.0.0.1', callback);
        return server;
      } };
      if (name === 'fs') return {
        readFileSync: (file) => {
          if (path.basename(file) === 'config.json') return JSON.stringify({ token, pin: '12345678' });
          if (path.dirname(file) === path.join(root, 'public')) return fs.readFileSync(file);
          if (path.extname(file) === '.json') return '{}';
          throw new Error('test fixture has no such asset');
        },
        writeFileSync: (file) => { if (path.basename(file) === 'config.json') configWrites++; },
        readdirSync: () => [],
        mkdirSync: () => {},
        renameSync: () => { throw new Error('no legacy files in test'); },
      };
      if (name === './src/lib') return { claudeSessions: () => [], codexData: () => ({ sessions }), antigravitySessions: () => [] };
      if (name === './src/quotas') return { claudeQuota: async () => ({ windows: {} }), codexQuota: async () => ({ windows: {} }) };
      if (name === './src/peers') return { Peers, compareSessions: require('../src/peers').compareSessions };
      if (name === './src/terminal-focus') return { createTerminalFocus: () => async () => ({ ok: true, host: 'windows-terminal', message: 'test tab selected' }) };
      if (name === './src/http-utils') return require('../src/http-utils');
      if (name === './src/ollama') return { Ollama: class { constructor() { this.state = null; } } };
      if (name === './src/ollama-chats') return { ollamaChatSessions: () => [], ollamaRunSessions: () => [] };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  let responseBody, responseHeaders;
  const call = (route, body, accessToken = token) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port,
      path: route + (route.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(accessToken), method: body === undefined ? 'GET' : 'POST', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { responseBody = text; responseHeaders = res.headers; resolve(res.statusCode); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  // O Android deve descobrir o mesmo PWA antes e depois de digitar o PIN.
  const assertManifestLink = () => assert.match(responseBody, /<link rel="manifest" href="\/manifest.json">/);
  assert.equal(await call('/', undefined, ''), 200);
  assertManifestLink();
  assert.equal(await call('/login', 'pin=00000000', ''), 401);
  assertManifestLink();
  assert.equal(await call('/login', 'pin=12345678', ''), 303);
  assert.equal(responseHeaders.location, '/?t=' + token);
  assert.equal(await call('/'), 200);
  assertManifestLink();
  assert.equal(await call('/manifest.json', undefined, ''), 200);
  assert.equal(responseHeaders['content-type'], 'application/manifest+json');
  const manifest = JSON.parse(responseBody);
  assert.equal(manifest.display, 'fullscreen');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  for (const icon of manifest.icons) {
    assert.equal(await call(icon.src, undefined, ''), 200);
    assert.equal(responseHeaders['content-type'], icon.type);
  }
  assert.equal(await call('/sw.js', undefined, ''), 200);
  assert.equal(responseHeaders['service-worker-allowed'], '/');
  assert.equal(await call('/api/snapshot', undefined, 'é'.repeat(24)), 401);
  for (const route of ['/api/reply', '/api/remote', '/api/permission', '/api/focus',
    '/hook/permission', '/hook/permission-expire', '/hook/listen', '/hook/unlisten']) {
    assert.equal(await call(route, 'null'), 400, route);
  }
  assert.equal(configWrites, 0);
  const now = Date.now();
  const session = { id: '00000000-0000-4000-8000-000000000001', tool: 'Codex', cwd: '/project',
    start: new Date(now - 20000).toISOString(), end: new Date(now).toISOString(), mtime: now,
    lastStop: 'end_turn', completedAt: now, where: 'terminal', models: new Set(), tools: {}, events: [],
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompts: 1, lastReply: 'oi' };
  sessions.push(session);
  assert.equal(await call('/api/snapshot'), 200);
  assert.equal(JSON.parse(responseBody).active[0].completedAt, now);
  assert.equal(await call('/api/session?id=' + session.id), 200);
  assert.equal(JSON.parse(responseBody).completedAt, now);
  assert.equal(await call('/api/focus', JSON.stringify({ id: session.id })), 200);
  assert.equal(JSON.parse(responseBody).message, 'test tab selected');
  const ollama = { ...session, id: 'ollama-test', tool: 'Ollama', generation: { outputTokens: 100, tokensPerSecond: 50, totalMs: 3000 } };
  sessions.push(ollama);
  assert.equal(await call('/api/session?id=' + ollama.id), 200);
  assert.deepEqual(JSON.parse(responseBody).ollamaGeneration, ollama.generation);
});
