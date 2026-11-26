// Autenticação biométrica (WebAuthn / Passkey) por aparelho, sem dependências externas.
// Usada opcionalmente no PWA do celular (/): o iPad, o Desktop (/workspace) e peers seguem no fluxo normal.
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJson } = require('../infra/store');

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 min em segundo plano
const ALLOWED_TIMEOUTS = new Set([0, 60e3, 120e3, 300e3]);
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MIN_SERVER_GRACE_MS = 60 * 1000; // mantém long-polling ativo enquanto o app está aberto

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64uDecode(str) {
  if (typeof str !== 'string' || !str) throw new Error('base64url inválido');
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, 'base64');
}

// Decodificador CBOR mínimo (RFC 8949) para attestationObject e COSE_Key (EC2/RSA).
function decodeCborAt(buf, offset = 0) {
  if (offset >= buf.length) throw new Error('CBOR truncado');
  const first = buf[offset++];
  const major = first >> 5;
  const info = first & 0x1f;

  function readUint() {
    if (info < 24) return info;
    if (info === 24) {
      if (offset + 1 > buf.length) throw new Error('CBOR truncado');
      return buf[offset++];
    }
    if (info === 25) {
      if (offset + 2 > buf.length) throw new Error('CBOR truncado');
      const v = buf.readUInt16BE(offset);
      offset += 2;
      return v;
    }
    if (info === 26) {
      if (offset + 4 > buf.length) throw new Error('CBOR truncado');
      const v = buf.readUInt32BE(offset);
      offset += 4;
      return v;
    }
    if (info === 27) {
      if (offset + 8 > buf.length) throw new Error('CBOR truncado');
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      offset += 8;
      return hi * 4294967296 + lo;
    }
    throw new Error('CBOR de tamanho indefinido não suportado');
  }

  if (major === 0) return { value: readUint(), offset };
  if (major === 1) return { value: -1 - readUint(), offset };
  if (major === 2) {
    const len = readUint();
    if (offset + len > buf.length) throw new Error('CBOR bytes truncados');
    const value = buf.subarray(offset, offset + len);
    return { value, offset: offset + len };
  }
  if (major === 3) {
    const len = readUint();
    if (offset + len > buf.length) throw new Error('CBOR texto truncado');
    const value = buf.subarray(offset, offset + len).toString('utf8');
    return { value, offset: offset + len };
  }
  if (major === 4) {
    const len = readUint();
    const arr = [];
    for (let i = 0; i < len; i++) {
      const item = decodeCborAt(buf, offset);
      arr.push(item.value);
      offset = item.offset;
    }
    return { value: arr, offset };
  }
  if (major === 5) {
    const len = readUint();
    const map = new Map();
    for (let i = 0; i < len; i++) {
      const k = decodeCborAt(buf, offset);
      offset = k.offset;
      const v = decodeCborAt(buf, offset);
      offset = v.offset;
      map.set(k.value, v.value);
    }
    return { value: map, offset };
  }
  if (major === 7) {
    if (info === 20) return { value: false, offset };
    if (info === 21) return { value: true, offset };
    if (info === 22) return { value: null, offset };
    if (info === 23) return { value: undefined, offset };
    throw new Error('valor CBOR simples não suportado');
  }
  throw new Error('tipo CBOR não suportado');
}

function coseKeyToPem(coseMap) {
  if (!(coseMap instanceof Map)) throw new Error('chave pública COSE inválida');
  const kty = coseMap.get(1);
  const alg = coseMap.get(3);
  if (kty === 2 && alg === -7) {
    const crv = coseMap.get(-1);
    const x = coseMap.get(-2);
    const y = coseMap.get(-3);
    if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('chave EC P-256 inválida');
    const keyObj = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64uEncode(x), y: b64uEncode(y) },
      format: 'jwk',
    });
    return { alg: -7, publicKey: keyObj.export({ type: 'spki', format: 'pem' }) };
  }
  if (kty === 3 && alg === -257) {
    const n = coseMap.get(-1);
    const e = coseMap.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('chave RSA inválida');
    const keyObj = crypto.createPublicKey({
      key: { kty: 'RSA', n: b64uEncode(n), e: b64uEncode(e) },
      format: 'jwk',
    });
    return { alg: -257, publicKey: keyObj.export({ type: 'spki', format: 'pem' }) };
  }
  throw new Error(`algoritmo WebAuthn não suportado (kty=${kty}, alg=${alg})`);
}

function parseCookies(req) {
  const out = {};
  const header = String((req && req.headers && req.headers.cookie) || '');
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function requestContext(req) {
  const rawHost = String((req.headers['x-forwarded-host'] || req.headers.host || 'localhost')).split(',')[0].trim();
  const rpId = rawHost.replace(/:\d+$/, '').toLowerCase();
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const originHeader = String(req.headers.origin || '').trim();
  const isHttps = protoHeader === 'https' || !!(req.socket && req.socket.encrypted) || originHeader.startsWith('https://');
  return { host: rawHost.toLowerCase(), rpId, isHttps };
}

function verifyOrigin(clientOrigin, ctx) {
  if (typeof clientOrigin !== 'string' || !clientOrigin) return false;
  let parsed;
  try { parsed = new URL(clientOrigin); } catch { return false; }
  const hostNo443 = ctx.host.replace(/:443$/, '');
  const originHostNo443 = parsed.host.toLowerCase().replace(/:443$/, '');
  if (parsed.hostname.toLowerCase() !== ctx.rpId) return false;
  if (originHostNo443 !== hostNo443) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && (ctx.rpId === 'localhost' || ctx.rpId === '127.0.0.1');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function createWebAuthn({ dataDir, config, now = () => Date.now() }) {
  const file = path.join(dataDir, 'passkeys.json');
  const challenges = new Map(); // challenge -> { kind, rpId, host, expiresAt }
  const sessions = new Map();   // sessionId -> { credId, createdAt, lastSeen }

  function loadStore() {
    const data = readJson(file, {});
    const credentials = Array.isArray(data.credentials) ? data.credentials : [];
    const timeoutMs = ALLOWED_TIMEOUTS.has(data.timeoutMs) ? data.timeoutMs : DEFAULT_TIMEOUT_MS;
    return { timeoutMs, credentials };
  }

  function saveStore(data) {
    if (!writeJson(file, data, true)) {
      throw new Error('Falha ao persistir credenciais WebAuthn em disco.');
    }
  }

  const revocationListeners = new Set();
  function emitRevoked(sessionId, credId = null) {
    for (const fn of revocationListeners) {
      try { fn({ sessionId, credId }); } catch {}
    }
  }
  function onSessionRevoked(fn) {
    if (typeof fn !== 'function') return () => {};
    revocationListeners.add(fn);
    return () => revocationListeners.delete(fn);
  }

  function pruneChallenges() {
    const t = now();
    for (const [k, v] of challenges.entries()) {
      if (v.expiresAt <= t) challenges.delete(k);
    }
  }

  function pruneSessions(timeoutMs) {
    const t = now();
    const limit = Math.max(timeoutMs, MIN_SERVER_GRACE_MS);
    for (const [k, s] of sessions.entries()) {
      if (t - s.lastSeen >= limit) {
        sessions.delete(k);
        emitRevoked(k, s.credId);
      }
    }
  }

  function hasCredential(id) {
    if (!id || typeof id !== 'string') return false;
    return loadStore().credentials.some((c) => c.id === id);
  }

  function getTimeoutMs() {
    return loadStore().timeoutMs;
  }

  function createSession(credId) {
    const id = crypto.randomBytes(24).toString('hex');
    const t = now();
    sessions.set(id, { credId, createdAt: t, lastSeen: t });
    return id;
  }

  function validateSession(sessionId, expectedCredId) {
    if (!sessionId || typeof sessionId !== 'string') return false;
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (expectedCredId && s.credId !== expectedCredId) return false;
    const t = now();
    const timeoutMs = getTimeoutMs();
    const limit = Math.max(timeoutMs, MIN_SERVER_GRACE_MS);
    if (t - s.lastSeen >= limit) {
      sessions.delete(sessionId);
      emitRevoked(sessionId, s.credId);
      return false;
    }
    s.lastSeen = t;
    return true;
  }

  function revokeSession(sessionId) {
    if (!sessionId) return;
    const s = sessions.get(sessionId);
    sessions.delete(sessionId);
    emitRevoked(sessionId, s ? s.credId : null);
  }

  function cookieFlags(isHttps) {
    return `; Path=/; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
  }

  function sessionCookies(sessionId, credId, isHttps) {
    const flags = cookieFlags(isHttps);
    const freshFlags = `; Max-Age=20; Path=/; SameSite=Lax${isHttps ? '; Secure' : ''}`;
    return [
      `hud=; Max-Age=0${flags}`,
      `hud_bio=${sessionId}${flags}`,
      `hud_bio_id=${credId}; Max-Age=31536000${flags}`,
      `hud_bio_fresh=1${freshFlags}`,
    ];
  }

  function lockCookies(isHttps) {
    const flags = cookieFlags(isHttps);
    return [
      `hud=; Max-Age=0${flags}`,
      `hud_bio=; Max-Age=0${flags}`,
      `hud_bio_fresh=; Max-Age=0; Path=/; SameSite=Lax${isHttps ? '; Secure' : ''}`,
    ];
  }

  function disableCookies(token, isHttps) {
    const flags = cookieFlags(isHttps);
    return [
      `hud_bio=; Max-Age=0${flags}`,
      `hud_bio_id=; Max-Age=0${flags}`,
      `hud_bio_fresh=; Max-Age=0; Path=/; SameSite=Lax${isHttps ? '; Secure' : ''}`,
      `hud=${token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
    ];
  }

  function registerOptions(req) {
    pruneChallenges();
    const ctx = requestContext(req);
    const store = loadStore();
    const challenge = b64uEncode(crypto.randomBytes(32));
    challenges.set(challenge, { kind: 'register', rpId: ctx.rpId, host: ctx.host, expiresAt: now() + CHALLENGE_TTL_MS });
    const userId = b64uEncode(sha256(`ai-hud:${config.token}`).subarray(0, 16));
    return {
      challenge,
      rp: { name: 'AI HUD', id: ctx.rpId },
      user: { id: userId, name: 'ai-hud-mobile', displayName: 'AI HUD (Celular)' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      attestation: 'none',
      timeout: 60000,
      excludeCredentials: store.credentials.map((c) => ({ type: 'public-key', id: c.id })),
    };
  }

  function verifyRegistration(req, body) {
    pruneChallenges();
    if (!body || typeof body !== 'object' || !body.response) throw new Error('dados de registro inválidos');
    const ctx = requestContext(req);
    const clientDataBuf = b64uDecode(body.response.clientDataJSON);
    let clientData;
    try { clientData = JSON.parse(clientDataBuf.toString('utf8')); } catch { throw new Error('clientDataJSON inválido'); }
    if (clientData.type !== 'webauthn.create') throw new Error('tipo WebAuthn inválido');
    const pending = challenges.get(clientData.challenge);
    if (!pending || pending.kind !== 'register' || pending.expiresAt <= now()) throw new Error('desafio expirado ou inválido');
    challenges.delete(clientData.challenge);
    if (pending.rpId !== ctx.rpId || !verifyOrigin(clientData.origin, ctx)) throw new Error('origem WebAuthn inválida');

    const attBuf = b64uDecode(body.response.attestationObject);
    const att = decodeCborAt(attBuf, 0).value;
    if (!(att instanceof Map)) throw new Error('attestationObject inválido');
    const authData = att.get('authData');
    if (!Buffer.isBuffer(authData) || authData.length < 55) throw new Error('authData inválido');

    const expectedRpHash = sha256(ctx.rpId);
    if (!crypto.timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) throw new Error('rpIdHash não confere');
    const flags = authData[32];
    if ((flags & 0x01) === 0) throw new Error('presença do usuário não confirmada');
    if ((flags & 0x04) === 0) throw new Error('verificação biométrica obrigatória');
    if ((flags & 0x40) === 0) throw new Error('dados da credencial ausentes');

    const signCount = authData.readUInt32BE(33);
    const credIdLen = authData.readUInt16BE(53);
    if (55 + credIdLen >= authData.length) throw new Error('credentialId truncado');
    const credIdBuf = authData.subarray(55, 55 + credIdLen);
    const credId = b64uEncode(credIdBuf);
    if (body.id && body.id !== credId) throw new Error('id da credencial não confere');

    const cose = decodeCborAt(authData, 55 + credIdLen).value;
    const { alg, publicKey } = coseKeyToPem(cose);

    const store = loadStore();
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 48) : 'Celular';
    const existingIdx = store.credentials.findIndex((c) => c.id === credId);
    const entry = { id: credId, publicKey, alg, signCount, label, createdAt: now(), lastUsedAt: now() };
    if (existingIdx >= 0) store.credentials[existingIdx] = entry;
    else store.credentials.push(entry);
    saveStore(store);

    const sessionId = createSession(credId);
    return { credId, sessionId, timeoutMs: store.timeoutMs, isHttps: ctx.isHttps };
  }

  function loginOptions(req, body) {
    pruneChallenges();
    const ctx = requestContext(req);
    const store = loadStore();
    const cookies = parseCookies(req);
    const requestedId = (body && typeof body.id === 'string' && body.id) || cookies.hud_bio_id || '';
    const matching = requestedId ? store.credentials.filter((c) => c.id === requestedId) : store.credentials;
    const list = matching.length ? matching : store.credentials;
    if (!list.length) throw new Error('nenhuma digital cadastrada');

    const challenge = b64uEncode(crypto.randomBytes(32));
    challenges.set(challenge, { kind: 'login', rpId: ctx.rpId, host: ctx.host, expiresAt: now() + CHALLENGE_TTL_MS });
    return {
      challenge,
      rpId: ctx.rpId,
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: list.map((c) => ({ type: 'public-key', id: c.id, transports: ['internal'] })),
    };
  }

  function verifyAuthentication(req, body) {
    pruneChallenges();
    if (!body || typeof body !== 'object' || !body.id || !body.response) throw new Error('dados de autenticação inválidos');
    const ctx = requestContext(req);
    const store = loadStore();
    const cred = store.credentials.find((c) => c.id === body.id);
    if (!cred) throw new Error('credencial desconhecida');

    const clientDataBuf = b64uDecode(body.response.clientDataJSON);
    let clientData;
    try { clientData = JSON.parse(clientDataBuf.toString('utf8')); } catch { throw new Error('clientDataJSON inválido'); }
    if (clientData.type !== 'webauthn.get') throw new Error('tipo WebAuthn inválido');
    const pending = challenges.get(clientData.challenge);
    if (!pending || pending.kind !== 'login' || pending.expiresAt <= now()) throw new Error('desafio expirado ou inválido');
    challenges.delete(clientData.challenge);
    if (pending.rpId !== ctx.rpId || !verifyOrigin(clientData.origin, ctx)) throw new Error('origem WebAuthn inválida');

    const authData = b64uDecode(body.response.authenticatorData);
    if (authData.length < 37) throw new Error('authenticatorData inválido');
    const expectedRpHash = sha256(ctx.rpId);
    if (!crypto.timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) throw new Error('rpIdHash não confere');
    const flags = authData[32];
    if ((flags & 0x01) === 0) throw new Error('presença do usuário não confirmada');
    if ((flags & 0x04) === 0) throw new Error('verificação biométrica obrigatória');

    const newSignCount = authData.readUInt32BE(33);
    if (cred.signCount > 0 && newSignCount <= cred.signCount) throw new Error('contador da credencial inválido');

    const signature = b64uDecode(body.response.signature);
    const signedData = Buffer.concat([authData, sha256(clientDataBuf)]);
    const valid = crypto.verify('sha256', signedData, cred.publicKey, signature);
    if (!valid) throw new Error('assinatura biométrica inválida');

    cred.signCount = newSignCount;
    cred.lastUsedAt = now();
    saveStore(store);

    pruneSessions(store.timeoutMs);
    const sessionId = createSession(cred.id);
    return { credId: cred.id, sessionId, timeoutMs: store.timeoutMs, isHttps: ctx.isHttps };
  }

  function updateSettings(body) {
    const store = loadStore();
    if (!body || typeof body.timeoutMs !== 'number' || !ALLOWED_TIMEOUTS.has(body.timeoutMs)) {
      throw new Error('tempo de bloqueio inválido');
    }
    store.timeoutMs = body.timeoutMs;
    saveStore(store);
    return { timeoutMs: store.timeoutMs };
  }

  function disableDevice(req, body) {
    const ctx = requestContext(req);
    const cookies = parseCookies(req);
    const targetId = (body && typeof body.id === 'string' && body.id) || cookies.hud_bio_id || '';
    const store = loadStore();
    if (targetId) {
      store.credentials = store.credentials.filter((c) => c.id !== targetId);
      saveStore(store);
    }
    revokeSession(cookies.hud_bio);
    for (const [sid, s] of sessions.entries()) {
      if (targetId && s.credId === targetId) {
        sessions.delete(sid);
        emitRevoked(sid, s.credId);
      }
    }
    return { removed: !!targetId, remaining: store.credentials.length, isHttps: ctx.isHttps };
  }

  function statusFor(req) {
    const cookies = parseCookies(req);
    const store = loadStore();
    const credId = cookies.hud_bio_id || '';
    const enrolled = !!(credId && store.credentials.some((c) => c.id === credId));
    return { enrolled, credentialId: enrolled ? credId : null, timeoutMs: store.timeoutMs, count: store.credentials.length };
  }

  function deviceFromRequest(req) {
    const cookies = parseCookies(req);
    const credId = cookies.hud_bio_id || '';
    if (!credId || !hasCredential(credId)) return { isBioDevice: false, credId: null, sessionId: null };
    return { isBioDevice: true, credId, sessionId: cookies.hud_bio || null };
  }

  return {
    hasCredential,
    getTimeoutMs,
    createSession,
    validateSession,
    revokeSession,
    onSessionRevoked,
    sessionCookies,
    lockCookies,
    disableCookies,
    registerOptions,
    verifyRegistration,
    loginOptions,
    verifyAuthentication,
    updateSettings,
    disableDevice,
    statusFor,
    deviceFromRequest,
    requestContext,
  };
}

const bioLoginPage = (msg) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AI HUD</title>
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="AI HUD">
<meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#121211">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" sizes="76x76" href="/icon-76.png"><link rel="apple-touch-icon" sizes="152x152" href="/icon-152.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png"><link rel="icon" type="image/png" href="/icon-192.png">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#121211;color:#ecece8;font:16px -apple-system,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:100%;max-width:340px;text-align:center}
.ico{width:54px;height:54px;color:#5fb8a4;margin:0 auto 14px;display:block}
h1{margin:0 0 8px;font-size:22px}
.sub{margin:0 0 22px;color:#9a9a94;font-size:14px;line-height:1.45}
.btn{width:100%;min-height:48px;font-size:16px;padding:12px 18px;border-radius:12px;border:0;background:#5fb8a4;color:#121211;font-weight:700;cursor:pointer}
.btn:disabled{opacity:.6}
.alt{margin-top:14px;background:transparent;color:#9a9a94;border:1px solid #3a3a36;font-weight:600}
.msg{min-height:20px;margin:14px 0 0;color:#e87070;font-size:14px}
form{display:none;margin-top:16px}
form.show{display:block}
input{font-size:26px;width:100%;text-align:center;letter-spacing:6px;padding:10px;border-radius:10px;border:1px solid #3a3a36;background:#1c1c1a;color:#ecece8;margin-bottom:12px}
</style></head><body><div class="box">
<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/>
  <path d="M14 13.12c0 2.38 0 6.38-1 8.88"/>
  <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/>
  <path d="M2 12a10 10 0 0 1 18-6"/>
  <path d="M2 16h.01"/>
  <path d="M21.8 16c.2-2 .131-5.354 0-6"/>
  <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/>
  <path d="M8.65 22c.21-.66.45-1.32.57-2"/>
  <path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>
</svg>
<h1>AI HUD bloqueado</h1>
<p class="sub">Confirme sua impressão digital para abrir o app.</p>
<button class="btn" id="unlock">Desbloquear com digital</button>
<button class="btn alt" id="togglePin" type="button">Usar PIN</button>
<form id="pinForm" method="POST" action="/login">
  <input name="pin" type="tel" pattern="[0-9]*" maxlength="8" placeholder="PIN">
  <button class="btn" type="submit">Entrar com PIN</button>
</form>
<p class="msg" id="msg">${msg || ''}</p>
</div>
<script>
(function () {
  var btn = document.getElementById('unlock');
  var msg = document.getElementById('msg');
  var form = document.getElementById('pinForm');
  var togglePin = document.getElementById('togglePin');
  function b64uToBuf(s) {
    var norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (norm.length % 4) norm += '=';
    var b = atob(norm);
    var u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  }
  function bufToB64u(buf) {
    var u = new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  }
  togglePin.onclick = function () {
    form.className = form.className === 'show' ? '' : 'show';
    if (form.className === 'show') {
      var inp = form.querySelector('input');
      if (inp) inp.focus();
    }
  };
  var busy = false;
  function unlock() {
    if (busy) return;
    if (!window.PublicKeyCredential || !navigator.credentials) {
      msg.textContent = 'Biometria indisponível neste navegador. Use o PIN.';
      form.className = 'show';
      return;
    }
    busy = true;
    btn.disabled = true;
    msg.textContent = '';
    fetch('/auth/webauthn/login/options', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Falha ao iniciar biometria'); });
      return r.json();
    }).then(function (opts) {
      opts.challenge = b64uToBuf(opts.challenge);
      if (opts.allowCredentials) {
        opts.allowCredentials = opts.allowCredentials.map(function (c) {
          return { type: c.type, id: b64uToBuf(c.id), transports: c.transports };
        });
      }
      return navigator.credentials.get({ publicKey: opts });
    }).then(function (cred) {
      if (!cred) throw new Error('Autenticação cancelada.');
      return fetch('/auth/webauthn/login/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cred.id,
          response: {
            clientDataJSON: bufToB64u(cred.response.clientDataJSON),
            authenticatorData: bufToB64u(cred.response.authenticatorData),
            signature: bufToB64u(cred.response.signature)
          }
        })
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Falha na verificação'); });
      return r.json();
    }).then(function (res) {
      try {
        sessionStorage.setItem('hud.bio.ok', '1');
        if (res && res.id) localStorage.setItem('hud.bio.id', res.id);
        if (res && typeof res.timeoutMs === 'number') localStorage.setItem('hud.bio.timeout', String(res.timeoutMs));
      } catch (e) {}
      location.replace('/');
    }).catch(function (err) {
      busy = false;
      btn.disabled = false;
      msg.textContent = err && err.name === 'NotAllowedError'
        ? 'Toque em "Desbloquear com digital" para confirmar.'
        : ((err && err.message) || 'Não foi possível validar a digital.');
    });
  }
  btn.onclick = unlock;
  if (!msg.textContent) setTimeout(unlock, 120);
})();
</script></body></html>`;

module.exports = {
  createWebAuthn,
  bioLoginPage,
  parseCookies,
  decodeCborAt,
  b64uEncode,
  b64uDecode,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_TIMEOUTS,
};
