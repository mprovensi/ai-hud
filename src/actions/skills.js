// Ações de compartilhamento de Skills/Plugins entre Claude Code, Codex CLI e Antigravity (via junction/symlink)
// e atualização segura do cache de plugins locais do Claude Code. Camada actions/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeSkillName } = require('../core/skills-catalog');
const { collectSkillsCatalog, getCliSkillDirs } = require('../collect/skills');
const { resolveWorkspaceRoot, writeAtomicWithBackup } = require('../infra/workspace-paths');

const VALID_TARGETS = new Set(['claude', 'codex', 'antigravity']);

function realPathSafe(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function pathsEqual(a, b) {
  if (!a || !b) return false;
  const na = realPathSafe(a);
  const nb = realPathSafe(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    if (ent.isSymbolicLink()) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (ent.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function createSkillsActions({ dataDir, config, machineName = '', home = os.homedir(), log = () => {} }) {
  const wsRoot = () => resolveWorkspaceRoot(dataDir, config);

  function getCatalog() {
    return collectSkillsCatalog({ workspaceRoot: wsRoot(), home, machineName });
  }

  function linkOne(sourceDir, skillName, targetCli, enable) {
    if (!VALID_TARGETS.has(targetCli)) {
      return { target: targetCli, ok: false, status: 'invalid-target', error: `CLI inválida: ${targetCli}` };
    }
    const cleanName = sanitizeSkillName(skillName);
    if (!cleanName) {
      return { target: targetCli, ok: false, status: 'invalid-name', error: 'Nome de skill inválido.' };
    }
    const cliDirs = getCliSkillDirs(home);
    const baseDir = cliDirs[targetCli];
    const targetPath = path.join(baseDir, cleanName);

    let lstat = null;
    try { lstat = fs.lstatSync(targetPath); } catch {}

    if (!enable) {
      if (!lstat) return { target: targetCli, ok: true, status: 'already-absent', path: targetPath };
      if (!lstat.isSymbolicLink()) {
        return {
          target: targetCli,
          ok: false,
          status: 'native-protected',
          error: 'Pasta nativa (não é link) — não removida por segurança.',
          path: targetPath,
        };
      }
      try {
        fs.unlinkSync(targetPath);
        return { target: targetCli, ok: true, status: 'unlinked', path: targetPath };
      } catch (e) {
        return { target: targetCli, ok: false, status: 'error', error: e.message, path: targetPath };
      }
    }

    // enable === true: criar junction (Windows) ou dir symlink (Linux/macOS)
    const realSrc = realPathSafe(sourceDir);
    if (!fs.existsSync(path.join(realSrc, 'SKILL.md'))) {
      return { target: targetCli, ok: false, status: 'missing-source', error: 'SKILL.md não encontrado na origem.' };
    }
    if (lstat) {
      if (lstat.isSymbolicLink()) {
        if (pathsEqual(targetPath, realSrc)) {
          return { target: targetCli, ok: true, status: 'already-linked', path: targetPath };
        }
        try { fs.unlinkSync(targetPath); } catch (e) {
          return { target: targetCli, ok: false, status: 'error', error: e.message, path: targetPath };
        }
      } else {
        if (pathsEqual(targetPath, realSrc)) {
          return { target: targetCli, ok: true, status: 'native', path: targetPath };
        }
        return {
          target: targetCli,
          ok: false,
          status: 'conflict',
          error: `Já existe uma pasta real diferente em ${targetPath}.`,
          path: targetPath,
        };
      }
    }

    try {
      fs.mkdirSync(baseDir, { recursive: true });
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(realSrc, targetPath, linkType);
      return { target: targetCli, ok: true, status: 'linked', path: targetPath };
    } catch (e) {
      return { target: targetCli, ok: false, status: 'error', error: e.message, path: targetPath };
    }
  }

  function shareSkill({ sourceDir = '', name = '', targets = {}, enable = true } = {}) {
    const catalog = getCatalog();
    // Só autoriza compartilhar skills efetivamente descobertas no catálogo (plugins, workspaces ou CLIs)
    const found = catalog.skills.find((s) =>
      (sourceDir && pathsEqual(s.sourceDir, sourceDir)) ||
      (!sourceDir && name && s.name === sanitizeSkillName(name))
    );
    if (!found) {
      return { status: 404, body: 'Skill não encontrada no catálogo autorizado desta máquina.' };
    }

    const results = [];
    if (Array.isArray(targets)) {
      for (const t of targets) results.push(linkOne(found.sourceDir, found.name, t, !!enable));
    } else if (targets && typeof targets === 'object') {
      for (const [t, on] of Object.entries(targets)) {
        if (typeof on === 'boolean') results.push(linkOne(found.sourceDir, found.name, t, on));
      }
    }
    const failed = results.filter((r) => !r.ok);
    if (results.length && !failed.length) {
      log(`skills share (${found.name}): ${results.map((r) => `${r.target}=${r.status}`).join(', ')}`);
    }
    return {
      status: failed.length && failed.length === results.length ? 409 : 200,
      body: {
        ok: failed.length === 0,
        skill: found.name,
        results,
        catalog: getCatalog(),
      },
    };
  }

  function batchShare({ origin = '', pluginId = '', targets = ['codex', 'antigravity'], enable = true } = {}) {
    const catalog = getCatalog();
    let list = [];
    if (pluginId) {
      const pl = catalog.plugins.find((p) => p.id === pluginId || p.name === pluginId);
      if (!pl) return { status: 404, body: `Plugin "${pluginId}" não encontrado nesta máquina.` };
      const dirs = pl.skills.map((s) => s.sourceDir);
      list = catalog.skills.filter((s) => dirs.some((d) => pathsEqual(d, s.sourceDir)));
    } else if (origin) {
      list = catalog.skills.filter((s) => s.origin.toLowerCase() === String(origin).toLowerCase());
    }
    if (!list.length) return { status: 404, body: 'Nenhuma skill correspondente encontrada para compartilhar.' };

    const targetList = Array.isArray(targets) ? targets.filter((t) => VALID_TARGETS.has(t)) : [];
    const results = [];
    for (const sk of list) {
      for (const t of targetList) {
        results.push({ skill: sk.name, ...linkOne(sk.sourceDir, sk.name, t, !!enable) });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    log(`skills batch-share (${pluginId || origin}): ${okCount}/${results.length} ok`);
    return {
      status: 200,
      body: {
        ok: results.every((r) => r.ok),
        count: list.length,
        results,
        catalog: getCatalog(),
      },
    };
  }

  function updateClaudePluginCache({ pluginId = '' } = {}) {
    const catalog = getCatalog();
    const pl = catalog.plugins.find((p) => p.id === pluginId || p.name === pluginId);
    if (!pl) return { status: 404, body: `Plugin "${pluginId}" não encontrado nesta máquina.` };
    if (!pl.sourcePath || !fs.existsSync(pl.sourcePath)) {
      return { status: 400, body: 'Este plugin não possui diretório local de marketplace para atualizar o cache.' };
    }
    const ver = String(pl.sourceVersion || '').trim();
    if (!ver || !/^[a-zA-Z0-9._-]+$/.test(ver)) {
      return { status: 400, body: 'Versão inválida em .claude-plugin/plugin.json.' };
    }
    const mkt = sanitizeSkillName(pl.marketplace || 'local') || 'local';
    const pName = sanitizeSkillName(pl.name) || 'plugin';
    const cacheTarget = path.join(home, '.claude', 'plugins', 'cache', mkt, pName, ver);
    const installedFile = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const backupDir = path.join(dataDir, 'backups', 'plugins');

    try {
      if (fs.existsSync(cacheTarget)) {
        fs.rmSync(cacheTarget, { recursive: true, force: true });
      }
      copyDirRecursive(pl.sourcePath, cacheTarget);

      let installed = { version: 2, plugins: {} };
      try { installed = JSON.parse(fs.readFileSync(installedFile, 'utf8')) || installed; } catch {}
      if (!installed.plugins || typeof installed.plugins !== 'object') installed.plugins = {};
      const prevArr = Array.isArray(installed.plugins[pl.id]) ? installed.plugins[pl.id] : [];
      const prev = prevArr[0] || {};
      const nowIso = new Date().toISOString();
      installed.plugins[pl.id] = [{
        scope: prev.scope || 'user',
        installPath: cacheTarget,
        version: ver,
        installedAt: prev.installedAt || nowIso,
        lastUpdated: nowIso,
        ...(prev.gitCommitSha ? { gitCommitSha: prev.gitCommitSha } : {}),
      }];

      writeAtomicWithBackup({
        filePath: installedFile,
        content: `${JSON.stringify(installed, null, 2)}\n`,
        backupDir,
        tag: 'installed_plugins.json',
      });
      log(`plugin cache updated: ${pl.id} -> v${ver}`);
      return {
        status: 200,
        body: {
          ok: true,
          pluginId: pl.id,
          version: ver,
          installPath: cacheTarget,
          catalog: getCatalog(),
        },
      };
    } catch (e) {
      return { status: 500, body: `Falha ao atualizar cache do plugin: ${e.message}` };
    }
  }

  return {
    getCatalog,
    shareSkill,
    batchShare,
    updateClaudePluginCache,
  };
}

module.exports = { createSkillsActions };
