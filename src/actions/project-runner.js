// Gerenciador de execução multi-stack por projeto (jogos Godot/GUI, Front+Back compostos, scripts e executáveis).
// Zero dependências npm em src/. Camada actions/.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { normalizePath, isWithinRoot, resolveContainedPath } = require('../core/path-guard');
const { redactSecrets } = require('../core/redact');
const { readProjectRunConfig, normalizeRunConfig } = require('../collect/workspace/project-run');
const { ensurePortableDir } = require('./workspace/project-storage');

const MAX_LOG_LINES = 300;
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s"'<>)]*)?/gi;

function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

function projectKey(cwd) {
  const n = normalizePath(cwd);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function killTree(child, platform = process.platform) {
  if (!child || !child.pid) return;
  const pid = child.pid;
  try {
    if (platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      try { child.kill(); } catch {}
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
      const t = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 2000);
      if (t.unref) t.unref();
    }
  } catch {}
}

function createProjectRunner({ config = {}, platform = process.platform, log = () => {} } = {}) {
  const runs = new Map();

  function getConfig(cwd) {
    return readProjectRunConfig(cwd, { godotExe: config && config.godotExe ? config.godotExe : '' });
  }

  function saveConfig({ cwd, runConfig }) {
    const cleanCwd = normalizePath(cwd);
    if (!cleanCwd || !fs.existsSync(cleanCwd)) {
      return { status: 404, body: 'Pasta do projeto não encontrada.' };
    }
    const normalized = normalizeRunConfig(runConfig);
    try {
      ensurePortableDir(cleanCwd);
      const file = path.join(cleanCwd, '.ai-workspace', 'run.json');
      fs.writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
      return { status: 200, body: { ok: true, config: normalized } };
    } catch (e) {
      return { status: 500, body: e.message || 'Falha ao salvar .ai-workspace/run.json.' };
    }
  }

  function appendLog(proc, chunk, stream = 'out') {
    const clean = redactSecrets(stripAnsi(chunk.toString('utf8'))).text;
    const lines = clean.split(/\r?\n/);
    for (const line of lines) {
      if (!line && proc.logs.length > 0 && proc.logs[proc.logs.length - 1].text === '') continue;
      proc.logs.push({ ts: Date.now(), stream, text: line.slice(0, 500) });
      if (proc.logs.length > MAX_LOG_LINES) proc.logs.shift();
      // Detecta URLs locais úteis (ex.: Vite http://localhost:5173, API http://127.0.0.1:8787)
      const matches = line.match(LOCAL_URL_RE);
      if (matches) {
        for (const rawUrl of matches) {
          const normUrl = rawUrl
            .replace(/\/\/0\.0\.0\.0:/i, '//localhost:')
            .replace(/\/\/\[::1\]:/i, '//localhost:')
            .replace(/[.,;:]+$/, '');
          if (!proc.detectedUrls.includes(normUrl) && proc.detectedUrls.length < 6) {
            proc.detectedUrls.push(normUrl);
          }
        }
      }
    }
  }

  function serializeRun(run) {
    if (!run) {
      return { ok: true, running: false, profileId: '', profileName: '', kind: '', startedAt: 0, processes: [] };
    }
    const processes = [...run.processes.values()].map((p) => ({
      id: p.id,
      name: p.name,
      cmd: p.cmd,
      cwd: p.relCwd || '',
      gui: !!p.gui,
      pid: p.pid || 0,
      status: p.status,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      endedAt: p.endedAt || 0,
      detectedUrls: p.detectedUrls.slice(),
      logs: p.logs.slice(-160),
    }));
    const running = processes.some((p) => p.status === 'running');
    return {
      ok: true,
      running,
      profileId: run.profileId,
      profileName: run.profileName,
      kind: run.kind,
      startedAt: run.startedAt,
      processes,
    };
  }

  function stop({ cwd, processId = '' } = {}) {
    const key = projectKey(cwd);
    const run = runs.get(key);
    if (!run) return { status: 200, body: serializeRun(null) };

    for (const p of run.processes.values()) {
      if (processId && p.id !== processId) continue;
      if (p.status === 'running' && p.child) {
        p.status = 'stopped';
        p.endedAt = Date.now();
        appendLog(p, '[ai-hud] Processo encerrado pelo usuário.', 'sys');
        killTree(p.child, platform);
      }
    }
    return { status: 200, body: serializeRun(run) };
  }

  function start({ cwd, profileId = '' } = {}) {
    if (config && config.disableTerminal) {
      return { status: 403, body: 'Execução de comandos locais desativada em config.json.' };
    }
    const cleanCwd = normalizePath(cwd);
    if (!cleanCwd || !fs.existsSync(cleanCwd)) {
      return { status: 404, body: 'Pasta do projeto não encontrada.' };
    }
    let realRoot;
    try { realRoot = fs.realpathSync(cleanCwd); } catch {
      return { status: 404, body: 'Pasta do projeto inacessível.' };
    }

    const cfgRes = getConfig(realRoot);
    if (cfgRes.status !== 200) return { status: cfgRes.status, body: cfgRes.error || 'Falha ao ler configuração.' };
    const runCfg = cfgRes.body.config;
    const chosenId = profileId || runCfg.defaultProfile;
    const profile = runCfg.profiles.find((p) => p.id === chosenId) || runCfg.profiles[0];
    if (!profile) {
      return { status: 400, body: 'Nenhum perfil de execução configurado para este projeto. Clique na engrenagem para adicionar um comando.' };
    }

    // Encerra execução anterior do mesmo projeto antes de subir a nova
    stop({ cwd: realRoot });

    const key = projectKey(realRoot);
    const run = {
      cwd: realRoot,
      profileId: profile.id,
      profileName: profile.name,
      kind: profile.kind,
      startedAt: Date.now(),
      processes: new Map(),
    };

    for (const pr of profile.processes) {
      let procCwd = realRoot;
      if (pr.cwd) {
        const sub = resolveContainedPath(realRoot, pr.cwd);
        if (!sub || !isWithinRoot(realRoot, sub) || !fs.existsSync(sub)) {
          return { status: 400, body: `Subpasta "${pr.cwd}" não encontrada para "${pr.name}".` };
        }
        procCwd = sub;
      }

      const isWin = platform === 'win32';
      const spawnOpts = {
        cwd: procCwd,
        shell: true,
        windowsHide: !pr.gui,
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      };

      const entry = {
        id: pr.id,
        name: pr.name,
        cmd: pr.cmd,
        relCwd: pr.cwd || '',
        gui: !!pr.gui,
        pid: 0,
        status: 'running',
        exitCode: null,
        startedAt: Date.now(),
        endedAt: 0,
        detectedUrls: pr.openUrl && /^https?:\/\//i.test(pr.openUrl) ? [pr.openUrl] : [],
        logs: [{ ts: Date.now(), stream: 'sys', text: `$ ${pr.cmd}${pr.cwd ? ` (em ${pr.cwd})` : ''}` }],
        child: null,
      };

      try {
        const child = spawn(pr.cmd, [], spawnOpts);
        entry.child = child;
        entry.pid = child.pid || 0;

        if (child.stdout) child.stdout.on('data', (d) => appendLog(entry, d, 'out'));
        if (child.stderr) child.stderr.on('data', (d) => appendLog(entry, d, 'err'));
        child.on('error', (err) => {
          appendLog(entry, `Erro ao iniciar: ${err.message}`, 'err');
          entry.status = 'exited';
          entry.exitCode = 1;
          entry.endedAt = Date.now();
        });
        child.on('close', (code) => {
          if (entry.status === 'running') {
            entry.status = 'exited';
            entry.exitCode = typeof code === 'number' ? code : 0;
            entry.endedAt = Date.now();
            appendLog(entry, `[ai-hud] Processo finalizado (código ${entry.exitCode}).`, 'sys');
          }
          entry.child = null;
        });
      } catch (e) {
        entry.status = 'exited';
        entry.exitCode = 1;
        entry.endedAt = Date.now();
        appendLog(entry, `Falha ao lançar processo: ${e.message}`, 'err');
      }

      run.processes.set(entry.id, entry);
    }

    runs.set(key, run);
    log(`[run] iniciado "${profile.name}" em ${realRoot}`);
    return { status: 200, body: serializeRun(run) };
  }

  function status({ cwd } = {}) {
    const key = projectKey(cwd);
    return { status: 200, body: serializeRun(runs.get(key) || null) };
  }

  function stopAll() {
    for (const run of runs.values()) {
      for (const p of run.processes.values()) {
        if (p.status === 'running' && p.child) killTree(p.child, platform);
      }
    }
    runs.clear();
  }

  return { getConfig, saveConfig, start, stop, status, stopAll };
}

module.exports = { createProjectRunner };
