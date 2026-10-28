const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { Peers } = require('../peers');

test('actual server routes reject null bodies and malformed tokens without side effects', async (t) => {
  const token = 'a'.repeat(24);
  const root = path.join(__dirname, '..');
  const sessions = [];
  let server, configWrites = 0;
  const sandbox = { __dirname: root, Buffer, URL, URLSearchParams, process,
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
          if (path.extname(file) === '.json') return '{}';
          throw new Error('test fixture has no such asset');
        },
        writeFileSync: (file) => { if (path.basename(file) === 'config.json') configWrites++; },
        readdirSync: () => [],
      };
      if (name === './lib') return { claudeSessions: () => [], codexData: () => ({ sessions }), antigravitySessions: () => [] };
      if (name === './quotas') return { claudeQuota: async () => ({ windows: {} }), codexQuota: async () => ({ windows: {} }) };
      if (name === './peers') return { Peers, compareSessions: require('../peers').compareSessions };
      if (name === './http-utils') return require('../http-utils');
      if (name === './ollama') return { Ollama: class { constructor() { this.state = null; } } };
      if (name === './ollama-chats') return { ollamaChatSessions: () => [], ollamaRunSessions: () => [] };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  let responseBody;
  const call = (route, body, accessToken = token) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port,
      path: route + (route.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(accessToken), method: body === undefined ? 'GET' : 'POST', agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { responseBody = text; resolve(res.statusCode); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await call('/api/snapshot', undefined, 'é'.repeat(24)), 401);
  for (const route of ['/api/reply', '/api/remote', '/api/permission', '/api/focus',
    '/hook/permission', '/hook/permission-expire', '/hook/listen', '/hook/unlisten']) {
    assert.equal(await call(route, 'null'), 400, route);
  }
  assert.equal(configWrites, 0);
  const now = Date.now();
  const session = { id: '00000000-0000-4000-8000-000000000001', tool: 'Codex', cwd: '/project',
    start: new Date(now - 20000).toISOString(), end: new Date(now).toISOString(), mtime: now,
    lastStop: 'end_turn', completedAt: now, models: new Set(), tools: {}, events: [],
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompts: 1, lastReply: 'oi' };
  sessions.push(session);
  assert.equal(await call('/api/snapshot'), 200);
  assert.equal(JSON.parse(responseBody).active[0].completedAt, now);
  assert.equal(await call('/api/session?id=' + session.id), 200);
  assert.equal(JSON.parse(responseBody).completedAt, now);
});
