// Upload seguro de imagens anexadas pelo celular/iPad/Workspace para `<workspaceRoot>/inbox/attachments/`.
// Retorna o caminho absoluto no PC dono da sessão para ser anexado no prompt enviado à IA.
const fs = require('fs');
const path = require('path');
const { isWithinRoot, resolveContainedPath } = require('../core/path-guard');
const { slugifyEntity } = require('../core/workspace-schema');
const { resolveWorkspaceRoot } = require('../infra/workspace-paths');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MAX_BYTES = 10 * 1024 * 1024;

function detectImageExt(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71 && buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10) return '.png';
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return '.jpg';
  if (buf.length >= 6 && /^GIF8[79]a/.test(buf.subarray(0, 6).toString('ascii'))) return '.gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf[0] === 66 && buf[1] === 77) return '.bmp';
  return '';
}

function createUpload({ dataDir, config, now = () => Date.now() }) {
  return function uploadAttachment({ fileName = 'imagem.png', base64Data = '' }) {
    const cleanB64 = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
    if (!cleanB64) return { status: 400, body: 'Dados da imagem ausentes.' };
    const buf = Buffer.from(cleanB64, 'base64');
    if (!buf.length || buf.length > MAX_BYTES) {
      return { status: 413, body: 'Imagem inválida ou excede 10 MB.' };
    }
    const rawExt = path.extname(String(fileName || '')).toLowerCase();
    const detected = detectImageExt(buf);
    const ext = detected || (IMAGE_EXTS.has(rawExt) ? rawExt : '');
    if (!ext || !IMAGE_EXTS.has(ext)) {
      return { status: 400, body: 'Apenas imagens PNG, JPG, WEBP, GIF ou BMP são permitidas.' };
    }

    const wsRoot = resolveWorkspaceRoot(dataDir, config);
    const attachDir = path.join(wsRoot, 'inbox', 'attachments');
    const day = new Date(now()).toISOString().slice(0, 10);
    const base = slugifyEntity(path.basename(String(fileName || 'imagem'), rawExt)).slice(0, 36) || 'imagem';
    const rand = Math.random().toString(36).slice(2, 7);
    const safeName = `${day}-${base}-${rand}${ext}`;
    const target = resolveContainedPath(attachDir, safeName);
    if (!target || !isWithinRoot(attachDir, target)) {
      return { status: 400, body: 'Nome de arquivo inválido.' };
    }

    fs.mkdirSync(attachDir, { recursive: true });
    fs.writeFileSync(target, buf);
    return {
      status: 200,
      body: {
        ok: true,
        path: target,
        relPath: `inbox/attachments/${safeName}`,
        name: safeName,
        size: buf.length,
      },
    };
  };
}

module.exports = { createUpload };
