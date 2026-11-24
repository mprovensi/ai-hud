// Serviço de Web Push (VAPID nativo, zero dependências) do AI HUD.
// Persiste chaves em data/vapid.json e assinaturas em data/push-subscriptions.json.
const https = require('https');
const http = require('http');
const path = require('path');
const { readJson, writeJson } = require('../infra/store');
const { generateVapidKeys, buildVapidAuthHeader, encryptWebPushPayload } = require('../core/webpush');

const MAX_SUBS = 20;

function defaultSendRequest(endpoint, headers, body, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(endpoint); } catch { return resolve({ status: 0, error: 'endpoint inválido' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.write(body);
    req.end();
  });
}

function createPush({ dataDir, config = {}, sendRequest = defaultSendRequest, log = () => {} }) {
  const vapidFile = path.join(dataDir, 'vapid.json');
  const subsFile = path.join(dataDir, 'push-subscriptions.json');

  let vapid = readJson(vapidFile, null);
  if (!vapid || !vapid.publicKey || !vapid.privateKeyPem) {
    vapid = generateVapidKeys();
    writeJson(vapidFile, vapid, true);
  }

  let subs = readJson(subsFile, []);
  if (!Array.isArray(subs)) subs = [];

  // Estado anterior por sessão para disparar notificações apenas em transições reais
  let primed = false;
  const prevState = new Map();

  function persistSubs() {
    writeJson(subsFile, subs, true);
  }

  function publicInfo() {
    return { enabled: true, publicKey: vapid.publicKey, count: subs.length };
  }

  function subscribe(sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https?:\/\//i.test(sub.endpoint)) {
      return { status: 400, body: 'Assinatura Web Push inválida (endpoint ausente).' };
    }
    const keys = sub.keys || {};
    if (!keys.p256dh || !keys.auth) {
      return { status: 400, body: 'Assinatura Web Push inválida (chaves ausentes).' };
    }
    const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
    const entry = {
      endpoint: sub.endpoint,
      keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
      label: String(sub.label || '').slice(0, 60),
      updatedAt: Date.now(),
    };
    if (idx >= 0) subs[idx] = entry;
    else {
      subs.push(entry);
      if (subs.length > MAX_SUBS) subs = subs.slice(-MAX_SUBS);
    }
    persistSubs();
    return { status: 200, body: { ok: true, count: subs.length } };
  }

  function unsubscribe(endpoint) {
    const clean = String(endpoint || '').trim();
    const before = subs.length;
    subs = subs.filter((s) => s.endpoint !== clean);
    if (subs.length !== before) persistSubs();
    return { status: 200, body: { ok: true, removed: before - subs.length, count: subs.length } };
  }

  async function notifyAll(payload) {
    if (!subs.length) return { sent: 0, failed: 0, pruned: 0 };
    const text = JSON.stringify({
      title: payload.title || 'AI HUD',
      body: payload.body || '',
      tag: payload.tag || 'ai-hud',
      url: payload.url || '/',
    });
    let sent = 0;
    let failed = 0;
    const expired = new Set();

    await Promise.all(subs.map(async (sub) => {
      try {
        const encrypted = encryptWebPushPayload(text, sub.keys.p256dh, sub.keys.auth);
        const authHeader = buildVapidAuthHeader({
          endpoint: sub.endpoint,
          subject: config.vapidSubject || 'mailto:ai-hud@localhost',
          vapid,
        });
        const r = await sendRequest(sub.endpoint, {
          Authorization: authHeader,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': encrypted.length,
          TTL: '300',
          Urgency: payload.urgent ? 'high' : 'normal',
        }, encrypted);
        if (r.status >= 200 && r.status < 300) sent += 1;
        else if (r.status === 404 || r.status === 410) expired.add(sub.endpoint);
        else failed += 1;
      } catch (err) {
        failed += 1;
        log(`webpush erro: ${err.message}`);
      }
    }));

    if (expired.size) {
      subs = subs.filter((s) => !expired.has(s.endpoint));
      persistSubs();
    }
    return { sent, failed, pruned: expired.size };
  }

  // Observa o snapshot consolidado e dispara Push em transições relevantes (permissão, resposta pronta, teste falhou)
  function observeSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.active)) return;
    const nextIds = new Set();
    for (const s of snapshot.active) {
      nextIds.add(s.id);
      const cur = {
        state: s.state,
        permId: (s.permission && s.permission.id) || '',
        replyAt: s.lastReplyAt || s.completedAt || 0,
        testFailed: !!s.testFailed,
      };
      const prev = prevState.get(s.id);
      prevState.set(s.id, cur);
      if (!primed || !subs.length) continue;

      const label = s.alias || s.project || s.tool || 'Sessão';
      const url = `/#s=${encodeURIComponent(s.id)}`;

      if (cur.state === 'permission' && (!prev || prev.permId !== cur.permId)) {
        notifyAll({
          title: `Permissão: ${label}`,
          body: (s.permission && (s.permission.tool || s.permission.summary)) || `${s.tool} aguardando autorização`,
          tag: `perm-${s.id}`,
          url,
          urgent: true,
        }).catch(() => {});
      } else if (cur.testFailed && (!prev || !prev.testFailed)) {
        notifyAll({
          title: `Teste falhou: ${label}`,
          body: `${s.tool} registrou falha nos testes.`,
          tag: `test-${s.id}`,
          url,
          urgent: true,
        }).catch(() => {});
      } else if (cur.state === 'waiting' && prev && (prev.state === 'working' || (cur.replyAt && cur.replyAt > prev.replyAt))) {
        notifyAll({
          title: `Resposta pronta: ${label}`,
          body: (s.lastReply || `${s.tool} terminou o turno.`).slice(0, 120),
          tag: `reply-${s.id}`,
          url,
        }).catch(() => {});
      }
    }
    for (const id of prevState.keys()) {
      if (!nextIds.has(id)) prevState.delete(id);
    }
    primed = true;
  }

  return { publicInfo, subscribe, unsubscribe, notifyAll, observeSnapshot };
}

module.exports = { createPush };
