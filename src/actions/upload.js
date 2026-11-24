// Upload seguro de imagens anexadas pelo celular/iPad/Workspace para `<workspaceRoot>/inbox/attachments/`.
// Retorna o caminho absoluto no PC dono da sessão para ser anexado no prompt enviado à IA.
const fs = require('fs');
const path = require('path');
const { isWithinRoot, resolveContainedPath } = require('../core/path-guard');
const { slugifyEntity } = require('../core/workspace-schema');
const { resolveWorkspaceRoot } = require('../infra/workspace-paths');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_BYTES = 10 * 1024 * 1024;

function createUpload({ dataDir, config, now = () => Date.now() }) {
  return function uploadAttachment({ fileName = 'imagem.png', base64Data = '' }) {
    const ext = path.extname(String(fileName || '')).toLowerCase() || '.png';
    if (!IMAGE_EXTS.has(ext)) {
      return { status: 400, body: 'Apenas imagens PNG, JPG, WEBP ou GIF são permitidas.' };
    }
    const cleanB64 = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
    if (!cleanB64) return { status: 400, body: 'Dados da imagem ausentes.' };
    const buf = Buffer.from(cleanB64, 'base64');
    if (!buf.length || buf.length > MAX_BYTES) {
      return { status: 413, body: 'Imagem inválida ou excede 10 MB.' };
    }

    const wsRoot = resolveWorkspaceRoot(dataDir, config);
    const attachDir = path.join(wsRoot, 'inbox', 'attachments');
    const day = new Date(now()).toISOString().slice(0, 10);
    const base = slugifyEntity(path.basename(String(fileName || 'imagem'), ext)).slice(0, 36);
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
