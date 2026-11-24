// Web Push nativo (zero dependências): geração de chaves VAPID P-256, JWT ES256 (RFC 8292)
// e criptografia de payload aes128gcm (RFC 8291 / RFC 8188). Camada core/ (sem I/O).
const crypto = require('crypto');

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64uDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(s + pad, 'base64');
}

function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPub = Buffer.concat([Buffer.from([0x04]), b64uDecode(jwk.x), b64uDecode(jwk.y)]);
  return {
    publicKey: b64uEncode(rawPub),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function buildVapidAuthHeader({ endpoint, subject = 'mailto:ai-hud@localhost', vapid, nowSec = Math.floor(Date.now() / 1000) }) {
  const u = new URL(endpoint);
  const header = b64uEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64uEncode(JSON.stringify({
    aud: `${u.protocol}//${u.host}`,
    exp: nowSec + 12 * 3600,
    sub: subject,
  }));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: vapid.privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${b64uEncode(sig)}`;
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

function encryptWebPushPayload(plaintext, p256dhB64, authB64) {
  const uaPublic = b64uDecode(p256dhB64);
  const authSecret = b64uDecode(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Chave pública p256dh inválida.');
  }
  if (authSecret.length !== 16) {
    throw new Error('Segredo auth inválido.');
  }

  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const record = Buffer.concat([Buffer.from(String(plaintext || ''), 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, enc, tag]);
}

// Utilizado nos testes automatizados para validar a criptografia RFC 8291 ponta a ponta
function decryptWebPushPayload(body, uaPrivateECDH, authB64) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idLen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idLen);
  const cipherAndTag = buf.subarray(21 + idLen);
  const enc = cipherAndTag.subarray(0, cipherAndTag.length - 16);
  const tag = cipherAndTag.subarray(cipherAndTag.length - 16);

  const uaPublic = uaPrivateECDH.getPublicKey();
  const authSecret = b64uDecode(authB64);
  const ecdhSecret = uaPrivateECDH.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  // Remove delimitador final 0x02 e eventuais zeros de padding
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (end > 0 && plain[end - 1] === 2) end--;
  return plain.subarray(0, end).toString('utf8');
}

module.exports = {
  b64uEncode,
  b64uDecode,
  generateVapidKeys,
  buildVapidAuthHeader,
  encryptWebPushPayload,
  decryptWebPushPayload,
};
