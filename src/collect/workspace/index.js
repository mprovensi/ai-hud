// Leitura somente leitura do Workspace file-first: workspace.json, cards, notas, docs globais e assets (camada collect/).
const fs = require('fs');
const path = require('path');
const { isSafeRelativePath, isWithinRoot, isSecretPath, resolveContainedPath } = require('../../core/path-guard');
const { defaultWorkspaceIndex, validateWorkspaceIndex } = require('../../core/workspace-schema');
const { hashContent } = require('../../infra/workspace-paths');

const ASSET_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function listDirFiles(dir, exts = null) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && (!exts || exts.includes(path.extname(e.name).toLowerCase())))
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtimeMs = 0, size = 0;
        try { const st = fs.statSync(full); mtimeMs = st.mtimeMs; size = st.size; } catch {}
        return { name: e.name, mtimeMs, size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch { return []; }
}

function readWorkspaceJson(workspaceRoot) {
  const file = path.join(workspaceRoot, 'workspace.json');
  if (!fs.existsSync(file)) return defaultWorkspaceIndex();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateWorkspaceIndex(parsed);
  } catch {
    return defaultWorkspaceIndex();
  }
}

function readWorkspaceIndex(workspaceRoot) {
  const index = readWorkspaceJson(workspaceRoot);
  const groupSet = new Set();
  for (const g of (index.groups || [])) {
    const clean = String(g || '').trim();
    if (clean) groupSet.add(clean);
  }
  for (const e of (index.entities || [])) {
    const clean = String(e.group || '').trim();
    if (clean) groupSet.add(clean);
  }
  return {
    root: workspaceRoot,
    format: index.format,
    version: index.version,
    groups: [...groupSet].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    groupMeta: index.groupMeta || {},
    entities: index.entities,
    context: listDirFiles(path.join(workspaceRoot, 'context'), ['.md', '.txt']),
    knowledge: listDirFiles(path.join(workspaceRoot, 'knowledge'), ['.md', '.txt']),
    skills: listDirFiles(path.join(workspaceRoot, 'skills'), ['.md', '.txt']),
    handoffs: listDirFiles(path.join(workspaceRoot, 'inbox', 'handoffs'), ['.md']),
  };
}

function findEntity(workspaceRoot, entityId) {
  const index = readWorkspaceJson(workspaceRoot);
  return index.entities.find((e) => e.id === entityId) || null;
}

function resolveEntityRoot(workspaceRoot, entity) {
  if (!entity || !isSafeRelativePath(entity.folder)) return null;
  const target = resolveContainedPath(workspaceRoot, entity.folder);
  if (!target || !isWithinRoot(workspaceRoot, target)) return null;
  return target;
}

function readEntityFile(workspaceRoot, entityId, relPath) {
  const entity = findEntity(workspaceRoot, entityId);
  if (!entity) return { status: 404, error: 'Entidade não encontrada no workspace.' };
  const entityRoot = resolveEntityRoot(workspaceRoot, entity);
  if (!entityRoot || !fs.existsSync(entityRoot)) return { status: 404, error: 'Pasta da entidade não encontrada.' };
  if (!isSafeRelativePath(relPath) || isSecretPath(relPath)) return { status: 400, error: 'Caminho de arquivo inválido.' };
  const filePath = resolveContainedPath(entityRoot, relPath);
  if (!filePath || !isWithinRoot(entityRoot, filePath)) return { status: 403, error: 'Caminho fora da entidade.' };
  if (!fs.existsSync(filePath)) return { status: 404, error: 'Arquivo não encontrado.' };

  const realRoot = fs.realpathSync(entityRoot);
  const realFile = fs.realpathSync(filePath);
  if (!isWithinRoot(realRoot, realFile)) return { status: 403, error: 'Link simbólico fora da entidade.' };

  const raw = fs.readFileSync(realFile, 'utf8');
  const hash = hashContent(raw);
  const isCard = relPath.toLowerCase().endsWith('.card.json');
  let parsed = null;
  if (isCard) {
    try { parsed = JSON.parse(raw); } catch { return { status: 422, error: 'Arquivo .card.json com JSON inválido.' }; }
  }
  return {
    status: 200,
    body: {
      ok: true,
      entityId,
      path: relPath,
      viewer: isCard ? 'card' : relPath.toLowerCase().endsWith('.html') ? 'html' : 'markdown',
      content: isCard ? parsed : raw,
      raw,
      hash,
    },
  };
}

function readGlobalDoc(workspaceRoot, area, name) {
  if (!['context', 'knowledge', 'skills', 'handoffs'].includes(area)) {
    return { status: 400, error: 'Área de documento inválida.' };
  }
  if (!isSafeRelativePath(name) || name.includes('/') || isSecretPath(name)) {
    return { status: 400, error: 'Nome de arquivo inválido.' };
  }
  const baseDir = area === 'handoffs' ? path.join(workspaceRoot, 'inbox', 'handoffs') : path.join(workspaceRoot, area);
  const filePath = resolveContainedPath(baseDir, name);
  if (!filePath || !isWithinRoot(baseDir, filePath)) return { status: 403, error: 'Caminho fora da área permitida.' };
  if (!fs.existsSync(filePath)) return { status: 404, error: 'Documento não encontrado.' };
  const raw = fs.readFileSync(filePath, 'utf8');
  return { status: 200, body: { ok: true, area, name, content: raw, hash: hashContent(raw) } };
}

function resolveEntityAsset(workspaceRoot, entityId, relAssetPath) {
  const entity = findEntity(workspaceRoot, entityId);
  if (!entity) return { status: 404, error: 'Entidade não encontrada.' };
  const entityRoot = resolveEntityRoot(workspaceRoot, entity);
  if (!entityRoot || !fs.existsSync(entityRoot)) return { status: 404, error: 'Pasta da entidade não encontrada.' };
  if (!isSafeRelativePath(relAssetPath) || isSecretPath(relAssetPath)) return { status: 400, error: 'Asset inválido.' };
  const target = resolveContainedPath(entityRoot, relAssetPath);
  if (!target || !isWithinRoot(entityRoot, target) || !fs.existsSync(target)) return { status: 404, error: 'Asset não encontrado.' };
  const realRoot = fs.realpathSync(entityRoot);
  const realFile = fs.realpathSync(target);
  if (!isWithinRoot(realRoot, realFile) || !fs.statSync(realFile).isFile()) return { status: 403, error: 'Asset fora da entidade.' };
  const ext = path.extname(realFile).toLowerCase();
  const contentType = ASSET_MIME[ext] || 'application/octet-stream';
  return { status: 200, filePath: realFile, contentType, isHtml: ext === '.html' || ext === '.htm' };
}

module.exports = {
  readWorkspaceJson,
  readWorkspaceIndex,
  findEntity,
  resolveEntityRoot,
  readEntityFile,
  readGlobalDoc,
  resolveEntityAsset,
};
