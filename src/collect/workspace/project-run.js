// Leitura de <cwd>/.ai-workspace/run.json e auto-detecção 0-token de perfis de execução (camada collect/).
// Suporta jogos (Godot/GUI), Web Full-Stack (Back + Front compostos), Node, Python, Docker, Rust, Go e executáveis.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizePath, isSafeRelativePath, isWithinRoot, resolveContainedPath } = require('../../core/path-guard');
const { slugifyEntity } = require('../../core/workspace-schema');

const RUN_FORMAT = 'ai-run';
const RUN_VERSION = 1;
const VALID_KINDS = new Set(['web', 'gui', 'compound', 'service', 'script']);

function quoteIfSpaces(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  return /\s/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s;
}

function findGodotBinary(preferred = '') {
  if (preferred && fs.existsSync(preferred)) return preferred;
  if (process.env.GODOT_EXE && fs.existsSync(process.env.GODOT_EXE)) return process.env.GODOT_EXE;

  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? ['godot.exe', 'godot4.exe', 'Godot_console.exe']
    : ['godot', 'godot4'];
  for (const dir of pathDirs) {
    for (const n of names) {
      const full = path.join(dir, n);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch {}
    }
  }

  if (process.platform === 'win32') {
    const home = os.homedir();
    const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roots = [
      'C:\\Godot',
      'D:\\Godot',
      'D:\\Programas',
      'C:\\Program Files\\Godot',
      path.join(localApp, 'Programs', 'Godot'),
      path.join(home, 'scoop', 'apps', 'godot', 'current'),
      path.join(home, 'Downloads'),
    ];
    for (const r of roots) {
      try {
        if (!fs.existsSync(r)) continue;
        const entries = fs.readdirSync(r, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && /^godot.*\.exe$/i.test(e.name) && !/console/i.test(e.name)) {
            return path.join(r, e.name);
          }
          if (e.isDirectory() && /godot/i.test(e.name)) {
            try {
              const sub = fs.readdirSync(path.join(r, e.name), { withFileTypes: true });
              const hit = sub.find((f) => f.isFile() && /^godot.*\.exe$/i.test(f.name) && !/console/i.test(f.name));
              if (hit) return path.join(r, e.name, hit.name);
            } catch {}
          }
        }
      } catch {}
    }
  }
  return 'godot';
}

function readPackageJson(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function detectPkgRunner(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function npmScriptCmd(runner, script) {
  if (script === 'start' && runner === 'npm') return 'npm start';
  return runner === 'yarn' ? `yarn ${script}` : `${runner} run ${script}`;
}

function normalizeRunConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.profiles) ? src.profiles : [];
  const profiles = [];
  const seenIds = new Set();

  for (let i = 0; i < Math.min(list.length, 20); i++) {
    const p = list[i];
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '').trim().slice(0, 80);
    if (!name) continue;
    let id = String(p.id || slugifyEntity(name)).trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50) || `profile-${i + 1}`;
    let n = 2;
    while (seenIds.has(id)) id = `${id.slice(0, 44)}-${n++}`;
    seenIds.add(id);

    const procsRaw = Array.isArray(p.processes) ? p.processes : [];
    const processes = [];
    for (let j = 0; j < Math.min(procsRaw.length, 6); j++) {
      const pr = procsRaw[j];
      if (!pr || typeof pr !== 'object') continue;
      const cmd = String(pr.cmd || '').trim().slice(0, 500);
      if (!cmd) continue;
      const pName = String(pr.name || (procsRaw.length === 1 ? name : `Processo ${j + 1}`)).trim().slice(0, 60);
      const relCwd = String(pr.cwd || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const safeRelCwd = relCwd && relCwd !== '.' && isSafeRelativePath(relCwd) ? relCwd : '';
      const openUrl = String(pr.openUrl || '').trim().slice(0, 200);
      processes.push({
        id: String(pr.id || slugifyEntity(pName) || `p${j + 1}`).slice(0, 40),
        name: pName,
        cmd,
        ...(safeRelCwd ? { cwd: safeRelCwd } : {}),
        ...(pr.gui ? { gui: true } : {}),
        ...(openUrl ? { openUrl } : {}),
      });
    }
    if (!processes.length) continue;

    const kind = VALID_KINDS.has(p.kind)
      ? p.kind
      : processes.length > 1
        ? 'compound'
        : processes[0].gui
          ? 'gui'
          : 'service';
    profiles.push({ id, name, kind, processes });
  }

  const defaultProfile = profiles.some((p) => p.id === src.defaultProfile)
    ? src.defaultProfile
    : (profiles[0] ? profiles[0].id : '');

  return {
    format: RUN_FORMAT,
    version: RUN_VERSION,
    defaultProfile,
    profiles,
  };
}

function detectProjectRunProfiles(cwd, { godotExe = '' } = {}) {
  const cleanCwd = normalizePath(cwd);
  if (!cleanCwd || !fs.existsSync(cleanCwd)) return normalizeRunConfig({ profiles: [] });

  let realCwd;
  try { realCwd = fs.realpathSync(cleanCwd); } catch { return normalizeRunConfig({ profiles: [] }); }

  const profiles = [];

  // 1. Godot (project.godot)
  if (fs.existsSync(path.join(realCwd, 'project.godot'))) {
    const bin = quoteIfSpaces(findGodotBinary(godotExe));
    profiles.push({
      id: 'godot-play',
      name: 'Rodar Jogo (Godot)',
      kind: 'gui',
      processes: [{ id: 'godot', name: 'Godot', cmd: `${bin} --path .`, gui: true }],
    });
    profiles.push({
      id: 'godot-editor',
      name: 'Abrir Editor Godot',
      kind: 'gui',
      processes: [{ id: 'editor', name: 'Godot Editor', cmd: `${bin} --editor --path .`, gui: true }],
    });
  }

  // 2. Node / Full-Stack (raiz + subpastas comuns de 1 nível)
  const rootPkg = readPackageJson(realCwd);
  const rootRunner = detectPkgRunner(realCwd);
  const subFrontNames = ['frontend', 'web', 'client', 'ui', 'app', 'workspace-app'];
  const subBackNames = ['backend', 'server', 'api'];
  let foundFront = null;
  let foundBack = null;

  for (const name of subFrontNames) {
    const subDir = path.join(realCwd, name);
    const pkg = readPackageJson(subDir);
    if (pkg && pkg.scripts && (pkg.scripts.dev || pkg.scripts.start)) {
      const script = pkg.scripts.dev ? 'dev' : 'start';
      foundFront = { dir: name, cmd: npmScriptCmd(detectPkgRunner(subDir), script) };
      break;
    }
  }
  for (const name of subBackNames) {
    const subDir = path.join(realCwd, name);
    const pkg = readPackageJson(subDir);
    if (pkg && pkg.scripts && (pkg.scripts.dev || pkg.scripts.start)) {
      const script = pkg.scripts.dev ? 'dev' : 'start';
      foundBack = { dir: name, cmd: npmScriptCmd(detectPkgRunner(subDir), script) };
      break;
    }
  }

  if (foundBack && foundFront) {
    profiles.push({
      id: 'fullstack-dev',
      name: 'Full-Stack (Back + Front)',
      kind: 'compound',
      processes: [
        { id: 'backend', name: `Backend (${foundBack.dir})`, cmd: foundBack.cmd, cwd: foundBack.dir },
        { id: 'frontend', name: `Frontend (${foundFront.dir})`, cmd: foundFront.cmd, cwd: foundFront.dir, openUrl: 'auto' },
      ],
    });
  } else if (rootPkg && rootPkg.scripts && (rootPkg.scripts.start || rootPkg.scripts.dev) && foundFront) {
    const rootScript = rootPkg.scripts.dev ? 'dev' : 'start';
    profiles.push({
      id: 'fullstack-dev',
      name: `App + ${foundFront.dir}`,
      kind: 'compound',
      processes: [
        { id: 'server', name: 'Servidor', cmd: npmScriptCmd(rootRunner, rootScript), openUrl: 'auto' },
        { id: 'frontend', name: foundFront.dir, cmd: foundFront.cmd, cwd: foundFront.dir, openUrl: 'auto' },
      ],
    });
  }

  if (rootPkg && rootPkg.scripts) {
    if (rootPkg.scripts.dev) {
      profiles.push({
        id: 'npm-dev',
        name: 'Dev (npm run dev)',
        kind: 'web',
        processes: [{ id: 'dev', name: 'Dev', cmd: npmScriptCmd(rootRunner, 'dev'), openUrl: 'auto' }],
      });
    }
    if (rootPkg.scripts.start) {
      profiles.push({
        id: 'npm-start',
        name: 'Iniciar (npm start)',
        kind: 'service',
        processes: [{ id: 'start', name: 'App', cmd: npmScriptCmd(rootRunner, 'start'), openUrl: 'auto' }],
      });
    }
  } else {
    if (foundBack) {
      profiles.push({
        id: 'backend',
        name: `Backend (${foundBack.dir})`,
        kind: 'service',
        processes: [{ id: 'backend', name: foundBack.dir, cmd: foundBack.cmd, cwd: foundBack.dir }],
      });
    }
    if (foundFront) {
      profiles.push({
        id: 'frontend',
        name: `Frontend (${foundFront.dir})`,
        kind: 'web',
        processes: [{ id: 'frontend', name: foundFront.dir, cmd: foundFront.cmd, cwd: foundFront.dir, openUrl: 'auto' }],
      });
    }
  }

  // 3. Docker Compose
  if (fs.existsSync(path.join(realCwd, 'docker-compose.yml')) || fs.existsSync(path.join(realCwd, 'compose.yaml')) || fs.existsSync(path.join(realCwd, 'compose.yml'))) {
    profiles.push({
      id: 'docker-compose',
      name: 'Docker Compose Up',
      kind: 'compound',
      processes: [{ id: 'compose', name: 'Docker Compose', cmd: 'docker compose up' }],
    });
  }

  // 4. Python
  const pyBin = process.platform === 'win32' ? 'python' : 'python3';
  if (fs.existsSync(path.join(realCwd, 'manage.py'))) {
    profiles.push({
      id: 'django-run',
      name: 'Django Server',
      kind: 'web',
      processes: [{ id: 'django', name: 'Django', cmd: `${pyBin} manage.py runserver`, openUrl: 'auto' }],
    });
  } else if (fs.existsSync(path.join(realCwd, 'main.py'))) {
    profiles.push({
      id: 'python-main',
      name: 'Python (main.py)',
      kind: 'script',
      processes: [{ id: 'python', name: 'Python', cmd: `${pyBin} main.py` }],
    });
  } else if (fs.existsSync(path.join(realCwd, 'app.py'))) {
    profiles.push({
      id: 'python-app',
      name: 'Python (app.py)',
      kind: 'web',
      processes: [{ id: 'python', name: 'Python', cmd: `${pyBin} app.py`, openUrl: 'auto' }],
    });
  }

  // 5. Rust / Go
  if (fs.existsSync(path.join(realCwd, 'Cargo.toml'))) {
    profiles.push({
      id: 'cargo-run',
      name: 'Rust (cargo run)',
      kind: 'script',
      processes: [{ id: 'cargo', name: 'Cargo', cmd: 'cargo run' }],
    });
  }
  if (fs.existsSync(path.join(realCwd, 'go.mod'))) {
    profiles.push({
      id: 'go-run',
      name: 'Go (go run .)',
      kind: 'service',
      processes: [{ id: 'go', name: 'Go', cmd: 'go run .' }],
    });
  }

  return normalizeRunConfig({ profiles });
}

function readProjectRunConfig(cwd, opts = {}) {
  const cleanCwd = normalizePath(cwd);
  if (!cleanCwd || !fs.existsSync(cleanCwd)) {
    return { status: 404, error: 'Pasta do projeto não encontrada.' };
  }
  const detected = detectProjectRunProfiles(cleanCwd, opts);
  const runFile = resolveContainedPath(cleanCwd, '.ai-workspace/run.json');
  if (runFile && isWithinRoot(cleanCwd, runFile) && fs.existsSync(runFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runFile, 'utf8'));
      const saved = normalizeRunConfig(parsed);
      return {
        status: 200,
        body: { ok: true, source: 'saved', config: saved, detected },
      };
    } catch {}
  }
  return {
    status: 200,
    body: { ok: true, source: 'auto', config: detected, detected },
  };
}

module.exports = {
  RUN_FORMAT,
  RUN_VERSION,
  findGodotBinary,
  normalizeRunConfig,
  detectProjectRunProfiles,
  readProjectRunConfig,
};
