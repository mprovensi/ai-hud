const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../src/main');
const { createWebAuthn, b64uEncode, b64uDecode } = require('../../src/api/webauthn');
const vm = require('node:vm');

// Codificador CBOR mínimo apenas para gerar objetos WebAuthn válidos nos testes.
function cborUint(major, n) {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 256) return Buffer.from([m | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = m | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

function cborEncode(val) {
  if (typeof val === 'number') {
    if (val >= 0) return cborUint(0, val);
    return cborUint(1, -1 - val);
  }
  if (Buffer.isBuffer(val)) return Buffer.concat([cborUint(2, val.length), val]);
  if (typeof val === 'string') {
    const b = Buffer.from(val, 'utf8');
    return Buffer.concat([cborUint(3, b.length), b]);
  }
  if (val instanceof Map) {
    const parts = [cborUint(5, val.size)];
    for (const [k, v] of val.entries()) {
      parts.push(cborEncode(k), cborEncode(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error('tipo não suportado no helper CBOR');
}

function buildAttestation({ rpId, credIdBuf, publicKey, flags = 0x45, signCount = 0 }) {
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map([
    [1, 2],       // kty: EC2
    [3, -7],      // alg: ES256
    [-1, 1],      // crv: P-256
    [-2, b64uDecode(jwk.x)],
    [-3, b64uDecode(jwk.y)],
  ]);
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const flagBuf = Buffer.from([flags]);
  const cntBuf = Buffer.alloc(4);
  cntBuf.writeUInt32BE(signCount, 0);
  const aaguid = Buffer.alloc(16);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(credIdBuf.length, 0);
  const authData = Buffer.concat([rpIdHash, flagBuf, cntBuf, aaguid, lenBuf, credIdBuf, cborEncode(cose)]);
  const att = new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]);
  return cborEncode(att);
}

function buildAssertion({ rpId, challenge, origin, privateKey, flags = 0x05, signCount = 1 }) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const flagBuf = Buffer.from([flags]);
  const cntBuf = Buffer.alloc(4);
  cntBuf.writeUInt32BE(signCount, 0);
  const authenticatorData = Buffer.concat([rpIdHash, flagBuf, cntBuf]);
  const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
  const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, clientDataHash]), privateKey);
  return {
    clientDataJSON: b64uEncode(clientDataJSON),
    authenticatorData: b64uEncode(authenticatorData),
    signature: b64uEncode(signature),
  };
}

function mergeCookies(jar, setCookieHeaders) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
  for (const h of list) {
    const [pair, ...attrs] = h.split(';').map((s) => s.trim());
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx);
    const val = pair.slice(idx + 1);
    const expired = attrs.some((a) => /^max-age=0$/i.test(a));
    if (expired || !val) delete jar[name];
    else jar[name] = val;
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

test('WebAuthn biometric lock isolates enrolled mobile device without affecting iPad/Desktop', async (t) => {
  const token = 'b'.repeat(24);
  const pin = '87654321';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-webauthn-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ token, pin }));

  const { server } = createApp({
    dataDir,
    sources: { all: () => [], ollamaReply: async () => ({ sent: true }) },
    quotaFetchers: { claude: async () => ({ windows: {} }), codex: async () => ({ windows: {} }) },
    brands: false,
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;

  const req = (jar, method, route, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const headers = {
      Host: host,
      Origin: origin,
      ...extraHeaders,
    };
    const ch = cookieHeader(jar);
    if (ch) headers.Cookie = ch;
    if (payload && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, path: route, method, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        mergeCookies(jar, res.headers['set-cookie']);
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

  // 1) Dispositivo celular entra inicialmente via PIN e cadastra a digital
  const phoneJar = {};
  const loginRes = await req(phoneJar, 'POST', '/login', `pin=${pin}`, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(loginRes.status, 303);
  assert.equal(loginRes.headers.location, `/?t=${token}`);
  const bootRes = await req(phoneJar, 'GET', `/?t=${token}`);
  assert.equal(bootRes.status, 200);
  assert.equal(phoneJar.hud, token);

  const regOptsRes = await req(phoneJar, 'POST', '/auth/webauthn/register/options', {});
  assert.equal(regOptsRes.status, 200);
  const regOpts = JSON.parse(regOptsRes.text);
  assert.equal(regOpts.rp.id, '127.0.0.1');
  assert.equal(regOpts.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(regOpts.authenticatorSelection.userVerification, 'required');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credIdBuf = crypto.randomBytes(32);
  const credId = b64uEncode(credIdBuf);
  const clientDataJSON = b64uEncode(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: regOpts.challenge, origin })));
  const attestationObject = b64uEncode(buildAttestation({ rpId: '127.0.0.1', credIdBuf, publicKey }));

  const regVerify = await req(phoneJar, 'POST', '/auth/webauthn/register/verify', {
    id: credId,
    label: 'Galaxy S20 FE',
    response: { clientDataJSON, attestationObject },
  });
  assert.equal(regVerify.status, 200);
  assert.equal(phoneJar.hud, undefined); // cookie permanente removido do celular!
  assert.ok(phoneJar.hud_bio);
  assert.equal(phoneJar.hud_bio_id, credId);
  assert.equal(phoneJar.hud_bio_fresh, '1');

  // Celular autenticado acessa snapshot sem voltar a gravar cookie permanente hud
  const snapOk = await req(phoneJar, 'GET', '/api/snapshot');
  assert.equal(snapOk.status, 200);
  const homeAuthed = await req(phoneJar, 'GET', '/');
  assert.equal(homeAuthed.status, 200);
  assert.equal(phoneJar.hud, undefined);

  // 2) Tranca sessão do celular (como ao abrir a frio ou após 2 min em segundo plano)
  const lockRes = await req(phoneJar, 'POST', '/auth/webauthn/lock', {});
  assert.equal(lockRes.status, 200);
  assert.equal(phoneJar.hud_bio, undefined);
  assert.equal(phoneJar.hud_bio_id, credId);

  // Mesmo passando ?t=<token> antigo, o celular cadastrado exige desbloqueio biométrico
  const blockedApi = await req(phoneJar, 'GET', `/api/snapshot?t=${token}`);
  assert.equal(blockedApi.status, 401);
  assert.equal(blockedApi.headers['x-ai-hud-auth'], 'biometric');

  // GET / devolve tela biométrica com link do manifest preservado
  const lockedHome = await req(phoneJar, 'GET', '/');
  assert.equal(lockedHome.status, 200);
  assert.match(lockedHome.text, /Desbloquear com digital/);
  assert.match(lockedHome.text, /<link rel="manifest" href="\/manifest\.json">/);

  // 3) Enquanto o celular está bloqueado, iPad e Desktop (/workspace) continuam livres sem biometria!
  const desktopJar = { hud: token };
  assert.equal((await req(desktopJar, 'GET', '/api/snapshot')).status, 200);
  assert.equal((await req(desktopJar, 'GET', '/')).status, 200);
  const ipadJar = {};
  assert.equal((await req(ipadJar, 'GET', `/api/snapshot?t=${token}`)).status, 200);

  // 4) Desbloqueio WebAuthn no celular: rejeita UV=0 e rejeita assinatura inválida
  const optsBad = JSON.parse((await req(phoneJar, 'POST', '/auth/webauthn/login/options', {})).text);
  const noUv = buildAssertion({ rpId: '127.0.0.1', challenge: optsBad.challenge, origin, privateKey, flags: 0x01, signCount: 1 });
  assert.equal((await req(phoneJar, 'POST', '/auth/webauthn/login/verify', { id: credId, response: noUv })).status, 401);

  // Desafio consumido não pode ser reutilizado (replay protection)
  const validWithReusedChallenge = buildAssertion({ rpId: '127.0.0.1', challenge: optsBad.challenge, origin, privateKey, flags: 0x05, signCount: 1 });
  assert.equal((await req(phoneJar, 'POST', '/auth/webauthn/login/verify', { id: credId, response: validWithReusedChallenge })).status, 401);

  // Desbloqueio válido libera novamente o celular
  const optsGood = JSON.parse((await req(phoneJar, 'POST', '/auth/webauthn/login/options', {})).text);
  const goodAssertion = buildAssertion({ rpId: '127.0.0.1', challenge: optsGood.challenge, origin, privateKey, flags: 0x05, signCount: 2 });
  const verifyOk = await req(phoneJar, 'POST', '/auth/webauthn/login/verify', { id: credId, response: goodAssertion });
  assert.equal(verifyOk.status, 200);
  assert.ok(phoneJar.hud_bio);
  assert.equal((await req(phoneJar, 'GET', '/api/snapshot')).status, 200);

  // 5) Fallback por PIN no celular bloqueado mantém o modo biométrico (não volta cookie permanente hud)
  await req(phoneJar, 'POST', '/auth/webauthn/lock', {});
  const pinFallback = await req(phoneJar, 'POST', '/login', `pin=${pin}`, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(pinFallback.status, 303);
  assert.equal(pinFallback.headers.location, '/');
  assert.equal(phoneJar.hud, undefined);
  assert.ok(phoneJar.hud_bio);
  assert.equal((await req(phoneJar, 'GET', '/api/snapshot')).status, 200);

  // 6) Alterar timeout e desativar digital restaura cookie normal no celular
  const setRes = await req(phoneJar, 'POST', '/auth/webauthn/settings', { timeoutMs: 300000 });
  assert.equal(setRes.status, 200);
  assert.equal(JSON.parse(setRes.text).timeoutMs, 300000);

  const disRes = await req(phoneJar, 'POST', '/auth/webauthn/disable', { id: credId });
  assert.equal(disRes.status, 200);
  assert.equal(phoneJar.hud, token);
  assert.equal(phoneJar.hud_bio, undefined);
  assert.equal(phoneJar.hud_bio_id, undefined);
  assert.equal((await req(phoneJar, 'GET', '/api/snapshot')).status, 200);
});

test('server biometric session expires automatically after timeoutMs without activity', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-webauthn-ttl-'));
  let nowMs = 1_700_000_000_000;
  const wa = createWebAuthn({ dataDir, config: { token: 'c'.repeat(24) }, now: () => nowMs });
  const sid = wa.createSession('cred-1');
  assert.equal(wa.validateSession(sid, 'cred-1'), true);
  nowMs += 119_000; // < 2 min: ainda válido e renova sliding TTL
  assert.equal(wa.validateSession(sid, 'cred-1'), true);
  nowMs += 120_000; // >= 2 min sem atividade: expira no servidor
  assert.equal(wa.validateSession(sid, 'cred-1'), false);
});

function bootClient({ userAgent, local = {}, session = {}, cookie = '', protocol = 'https:' }) {
  const html = fs.readFileSync(path.join(__dirname, '../../web/index.html'), 'utf8');
  const nodes = {};
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    const id = match[1];
    nodes[id] = {
      id,
      style: { display: html.includes(`id="${id}" style="display:none"`) ? 'none' : '' },
      className: '',
      innerHTML: '',
      textContent: '',
      disabled: false,
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k]; },
    };
  }
  const xhrCalls = [];
  const beacons = [];
  const listeners = {};
  class XHR {
    open(method, url) { this.method = method; this.url = url; xhrCalls.push(this); }
    send(body) { this.body = body; }
    setRequestHeader() {}
    getResponseHeader() { return null; }
  }
  const localMap = new Map(Object.entries(local));
  const sessionMap = new Map(Object.entries(session));
  const context = {
    document: {
      body: { className: '' },
      documentElement: {},
      hidden: false,
      cookie,
      getElementById: (id) => nodes[id] || null,
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    navigator: {
      userAgent,
      credentials: { get: () => Promise.resolve(null), create: () => Promise.resolve(null) },
      sendBeacon: (url) => { beacons.push(url); return true; },
    },
    PublicKeyCredential: function () {},
    location: { protocol, hostname: 'ai-hud-vps.tail2a765a.ts.net', search: '', hash: '', replace() {} },
    history: { replaceState() {} },
    XMLHttpRequest: XHR,
    fetch: () => Promise.resolve({ ok: false, text: () => Promise.resolve('mock') }),
    Promise,
    localStorage: {
      getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
      setItem: (k, v) => localMap.set(k, String(v)),
      removeItem: (k) => localMap.delete(k),
    },
    sessionStorage: {
      getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
      setItem: (k, v) => sessionMap.set(k, String(v)),
      removeItem: (k) => sessionMap.delete(k),
    },
    addEventListener: () => {},
    setInterval: () => {},
    setTimeout: () => {},
    innerWidth: 390,
  };
  context.window = context;
  vm.runInNewContext(require('../helpers/app-source'), context);
  return { context, nodes, xhrCalls, beacons, listeners, sessionMap };
}

test('biometric UI stays hidden on Desktop and iPad, and enforces cold-open + 2 min background lock on Android phone', () => {
  const desktop = bootClient({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0' });
  assert.equal(desktop.nodes.bioBtn.style.display, 'none');
  assert.equal(desktop.xhrCalls.length, 1);
  assert.equal(desktop.xhrCalls[0].url, '/api/snapshot');

  const ipad = bootClient({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15' });
  assert.equal(ipad.nodes.bioBtn.style.display, 'none');
  assert.equal(ipad.xhrCalls.length, 1);
  assert.equal(ipad.xhrCalls[0].url, '/api/snapshot');

  const androidUA = 'Mozilla/5.0 (Linux; Android 13; SM-G781B) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
  const freshPhone = bootClient({ userAgent: androidUA });
  assert.equal(freshPhone.nodes.bioBtn.style.display, 'inline-block');
  assert.equal(freshPhone.nodes.bioLock.className, '');

  // Abertura a frio no celular com digital cadastrada: tranca antes de buscar /api/snapshot
  const coldLocked = bootClient({
    userAgent: androidUA,
    local: { 'hud.bio.id': 'cred-phone', 'hud.bio.timeout': '120000' },
  });
  assert.equal(coldLocked.nodes.bioLock.className, 'show');
  assert.deepEqual(coldLocked.beacons, ['/auth/webauthn/lock']);
  assert.equal(coldLocked.xhrCalls.filter((x) => x.url.startsWith('/api/snapshot')).length, 0);

  // Aberto após desbloqueio recente: 30s em background não tranca; > 2 min tranca automaticamente
  const activePhone = bootClient({
    userAgent: androidUA,
    local: { 'hud.bio.id': 'cred-phone', 'hud.bio.timeout': '120000' },
    cookie: 'hud_bio_fresh=1',
  });
  assert.equal(activePhone.nodes.bioLock.className, '');
  assert.equal(activePhone.xhrCalls.some((x) => x.url === '/api/snapshot'), true);

  activePhone.context.document.hidden = true;
  activePhone.listeners.visibilitychange();
  // Simula apenas 30 segundos em segundo plano
  activePhone.sessionMap.set('hud.bio.hiddenAt', String(Date.now() - 30_000));
  activePhone.context.document.hidden = false;
  activePhone.listeners.visibilitychange();
  assert.equal(activePhone.nodes.bioLock.className, '');

  // Simula 2 min e 10 s em segundo plano
  activePhone.context.document.hidden = true;
  activePhone.listeners.visibilitychange();
  activePhone.sessionMap.set('hud.bio.hiddenAt', String(Date.now() - 130_000));
  activePhone.context.document.hidden = false;
  activePhone.listeners.visibilitychange();
  assert.equal(activePhone.nodes.bioLock.className, 'show');
  assert.deepEqual(activePhone.beacons, ['/auth/webauthn/lock']);
});

