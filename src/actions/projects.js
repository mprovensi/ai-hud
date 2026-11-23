// Fixar / desfixar pastas favoritas de projetos nesta máquina (persistido em data/config.json).
const fs = require('fs');
const { normalizePath, samePath } = require('../core/path-guard');

const MAX_PINS = 30;

function createProjectPins({ config, saveConfig }) {
  return function setPin({ cwd, pinned }) {
    const norm = normalizePath(cwd);
    if (!norm) return { status: 400, body: 'caminho da pasta não informado' };
    const want = pinned !== false;
    if (want) {
      try {
        if (!fs.statSync(norm).isDirectory()) return { status: 400, body: 'pasta não existe neste PC' };
      } catch {
        return { status: 400, body: 'pasta não existe neste PC' };
      }
    }
    const list = Array.isArray(config.pinnedProjects) ? config.pinnedProjects.slice() : [];
    const filtered = list.filter((p) => !samePath(p, norm));
    if (want) filtered.unshift(norm);
    config.pinnedProjects = filtered.slice(0, MAX_PINS);
    saveConfig();
    return { status: 200, body: { ok: true, pinned: config.pinnedProjects } };
  };
}

module.exports = { createProjectPins };
