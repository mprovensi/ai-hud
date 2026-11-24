// Enquadramento WebSocket RFC 6455 puro (zero dependências externas, camada core/ sem I/O).
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(`${String(secWebSocketKey || '').trim()}${WS_GUID}`).digest('base64');
}

function encodeFrame(data, opcode = 0x1, masked = false) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;

  const maskLen = masked ? 4 : 0;
  const out = Buffer.alloc(headerLen + maskLen + len);
  out[0] = 0x80 | (opcode & 0x0f);
  const maskBit = masked ? 0x80 : 0x00;

  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len < 65536) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = maskBit | 127;
    out.writeUInt32BE(0, 2);
    out.writeUInt32BE(len, 6);
  }

  if (masked) {
    const mask = crypto.randomBytes(4);
    mask.copy(out, headerLen);
    for (let i = 0; i < len; i++) out[headerLen + 4 + i] = payload[i] ^ mask[i & 3];
  } else {
    payload.copy(out, headerLen);
  }
  return out;
}

function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = off + 2;

    if (len === 126) {
      if (pos + 2 > buf.length) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buf.length) break;
      const hi = buf.readUInt32BE(pos);
      const lo = buf.readUInt32BE(pos + 4);
      len = hi * 0x100000000 + lo;
      pos += 8;
    }

    const need = pos + (masked ? 4 : 0) + len;
    if (need > buf.length) break;

    let payload;
    if (masked) {
      const mask = buf.subarray(pos, pos + 4);
      pos += 4;
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[pos + i] ^ mask[i & 3];
    } else {
      payload = Buffer.from(buf.subarray(pos, pos + len));
    }

    frames.push({ opcode, payload });
    off = need;
  }
  return { frames, rest: off > 0 ? buf.subarray(off) : buf };
}

module.exports = { acceptKey, encodeFrame, decodeFrames };
