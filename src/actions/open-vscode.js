// Abre uma pasta de projeto diretamente no VS Code na máquina dona da pasta (camada actions/).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { normalizePath } = require('../core/path-guard');

function hasExeInPath(name, env = process.env) {
  const pathStr = env && typeof env.PATH === 'string'
    ? env.PATH
    : env && typeof env.Path === 'string'
      ? env.Path
      : '';
  const dirs = pathStr.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try { if (fs.statSync(path.join(dir, name)).isFile()) return true; } catch {}
  }
  return false;
}

function findVsCodeExecutable(platform = process.platform, env = process.env) {
  if (env && env.VSCODE_EXE && fs.existsSync(env.VSCODE_EXE)) return env.VSCODE_EXE;

  if (platform === 'win32') {
    const localApp = (env && env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
    const progFiles = (env && env.ProgramFiles) || 'C:\\Program Files';
    const candidates = [
      path.join(localApp, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(progFiles, 'Microsoft VS Code', 'Code.exe'),
      path.join(localApp, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch {}
    }
    if (hasExeInPath('code.cmd', env)) return 'code.cmd';
    if (hasExeInPath('code', env)) return 'code';
    return '';
  }

  if (platform === 'darwin') {
    if (hasExeInPath('code', env)) return 'code';
    if (fs.existsSync('/Applications/Visual Studio Code.app')) return 'open';
    return '';
  }

  if (hasExeInPath('code', env)) return 'code';
  return '';
}

function createOpenVsCode({ spawnFn = spawn, platform = process.platform, env = process.env } = {}) {
  return function openVsCode({ cwd } = {}) {
    const cleanCwd = normalizePath(cwd);
    if (!cleanCwd || !fs.existsSync(cleanCwd)) {
      return { status: 404, body: 'Pasta do projeto não encontrada.' };
    }
    let realCwd = cleanCwd;
    try { realCwd = fs.realpathSync(cleanCwd); } catch {}
    try {
      if (!fs.statSync(realCwd).isDirectory()) {
        return { status: 400, body: 'O caminho informado não é uma pasta.' };
      }
    } catch {
      return { status: 404, body: 'Pasta do projeto inacessível.' };
    }

    const exe = findVsCodeExecutable(platform, env);
    if (!exe) {
      return {
        status: 200,
        body: {
          ok: true,
          launched: false,
          cwd: realCwd,
          message: 'VS Code não encontrado nesta máquina (ex.: servidor Linux headless).',
        },
      };
    }

    try {
      const isCmd = platform === 'win32' && /\.cmd$/i.test(exe);
      const args = exe === 'open'
        ? ['-a', 'Visual Studio Code', realCwd]
        : [realCwd];
      const child = spawnFn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: isCmd,
        shell: isCmd,
      });
      if (child && typeof child.on === 'function') child.on('error', () => {});
      if (child && typeof child.unref === 'function') child.unref();
      return {
        status: 200,
        body: {
          ok: true,
          launched: true,
          cwd: realCwd,
          message: `VS Code aberto em ${realCwd}`,
        },
      };
    } catch (e) {
      return { status: 500, body: e.message || 'Falha ao abrir VS Code.' };
    }
  };
}

module.exports = { findVsCodeExecutable, createOpenVsCode };
