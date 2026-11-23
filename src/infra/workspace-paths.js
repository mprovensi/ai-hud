// Caminhos e gravação atômica com backup para o Workspace e a Base de Memória (camada infra/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveWorkspaceRoot(dataDir, config = {}) {
  const custom = config && typeof config.workspaceDir === 'string' ? config.workspaceDir.trim() : '';
  return custom ? path.resolve(custom) : path.join(dataDir, 'workspace');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content == null ? '' : content), 'utf8').digest('hex');
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeAtomicWithBackup({ filePath, content, backupDir, tag = 'file' }) {
  if (backupDir && fs.existsSync(filePath)) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeTag = String(tag || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
      fs.copyFileSync(filePath, path.join(backupDir, `${stamp}_${safeTag}.bak`));
    } catch {}
  }
  writeAtomic(filePath, content);
}

module.exports = {
  resolveWorkspaceRoot,
  hashContent,
  writeAtomic,
  writeAtomicWithBackup,
};
