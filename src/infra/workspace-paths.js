// Caminhos, verificação física de contenção (symlinks/junctions) e gravação atômica com backup (camada infra/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let backupSeq = 0;

function resolveWorkspaceRoot(dataDir, config = {}) {
  const custom = config && typeof config.workspaceDir === 'string' ? config.workspaceDir.trim() : '';
  return custom ? path.resolve(custom) : path.join(dataDir, 'workspace');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content == null ? '' : content), 'utf8').digest('hex');
}

function isRealPathWithin(realRoot, realCandidate, platform = process.platform) {
  if (!realRoot || !realCandidate) return false;
  const r = platform === 'win32' ? path.resolve(realRoot).toLowerCase() : path.resolve(realRoot);
  const c = platform === 'win32' ? path.resolve(realCandidate).toLowerCase() : path.resolve(realCandidate);
  if (r === c) return true;
  const rel = path.relative(r, c);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Resolve o caminho real do próprio caminho ou do ancestral existente mais próximo + sufixo restante.
function resolveNearestRealPath(targetPath) {
  const abs = path.resolve(String(targetPath || ''));
  const tail = [];
  let cur = abs;
  while (true) {
    try {
      const realBase = fs.realpathSync(cur);
      return tail.length ? path.join(realBase, ...tail.reverse()) : realBase;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Garante que `targetPath` (existente ou a ser criado) e TODOS os seus ancestrais existentes
// (resolvendo symlinks/junctions) permanecem fisicamente dentro de `rootDir`.
function resolveSafeContainedTarget(rootDir, targetPath) {
  if (!rootDir || !targetPath) return { ok: false, error: 'Caminho inválido.' };
  let realRoot;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    return { ok: false, error: 'Pasta raiz não encontrada.' };
  }

  const absTarget = path.resolve(realRoot, targetPath);
  if (!isRealPathWithin(realRoot, absTarget)) {
    return { ok: false, error: 'Caminho fora da pasta autorizada.' };
  }

  // Se o destino existir (inclusive symlink quebrado via lstat), valida o destino físico.
  let targetStat = null;
  try { targetStat = fs.lstatSync(absTarget); } catch {}
  if (targetStat) {
    let realTarget;
    try {
      realTarget = fs.realpathSync(absTarget);
    } catch {
      return { ok: false, error: 'Symlink inválido ou quebrado.' };
    }
    if (!isRealPathWithin(realRoot, realTarget)) {
      return { ok: false, error: 'Symlink/junction aponta para fora da pasta autorizada.' };
    }
  }

  // Percorre os ancestrais existentes até realRoot e garante que nenhum link escapa da raiz.
  let cur = path.dirname(absTarget);
  while (cur && isRealPathWithin(realRoot, cur)) {
    let st = null;
    try { st = fs.lstatSync(cur); } catch {}
    if (st) {
      let realCur;
      try {
        realCur = fs.realpathSync(cur);
      } catch {
        return { ok: false, error: 'Ancestral symlink inválido.' };
      }
      if (!isRealPathWithin(realRoot, realCur)) {
        return { ok: false, error: 'Diretório pai atravessa symlink/junction fora da pasta autorizada.' };
      }
      // Recompõe o alvo usando o ancestral físico confirmado + sufixo inexistente
      const suffix = path.relative(cur, absTarget);
      const safeTarget = suffix ? path.join(realCur, suffix) : realCur;
      if (!isRealPathWithin(realRoot, safeTarget)) {
        return { ok: false, error: 'Destino resolvido fora da pasta autorizada.' };
      }
      return { ok: true, realRoot, target: safeTarget };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return { ok: true, realRoot, target: absTarget };
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  if (Buffer.isBuffer(content)) fs.writeFileSync(tmp, content);
  else fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeAtomicWithBackup({ filePath, content, backupDir, tag = 'file', rootDir = '' }) {
  if (rootDir) {
    const check = resolveSafeContainedTarget(rootDir, filePath);
    if (!check.ok) {
      const err = new Error(check.error);
      err.status = 403;
      throw err;
    }
    filePath = check.target;
  }
  if (backupDir && fs.existsSync(filePath)) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const seq = String(++backupSeq % 10000).padStart(4, '0');
      const rand = crypto.randomBytes(2).toString('hex');
      const safeTag = String(tag || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
      const backupPath = path.join(backupDir, `${stamp}_${seq}_${rand}_${safeTag}.bak`);
      fs.copyFileSync(filePath, backupPath);
    } catch (e) {
      const err = new Error(`Falha ao criar backup obrigatório antes de gravar: ${e.message || e}`);
      err.status = 500;
      err.code = 'EBACKUP';
      throw err;
    }
  }
  writeAtomic(filePath, content);
}

module.exports = {
  resolveWorkspaceRoot,
  hashContent,
  isRealPathWithin,
  resolveNearestRealPath,
  resolveSafeContainedTarget,
  writeAtomic,
  writeAtomicWithBackup,
};
