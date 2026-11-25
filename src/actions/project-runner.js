// Gerenciador de execução multi-stack por projeto (jogos Godot/GUI, Front+Back compostos, scripts e executáveis).
// Zero dependências npm em src/. Camada actions/.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { normalizePath, isWithinRoot, resolveContainedPath } = require('../core/path-guard');
const { redactSecrets } = require('../core/redact');
const { readProjectRunConfig, normalizeRunConfig } = require('../collect/workspace/project-run');
const { ensurePortableDir } = require('./workspace/project-storage');

const MAX_LOG_LINES = 300;
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s"'<>)]*)?/gi;

function probeUrlReachable(urlStr, timeoutMs = 600) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve(false); }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const host = (u.hostname === 'localhost' || u.hostname === '0.0.0.0' || u.hostname === '::1' || u.hostname === '[::1]')
      ? '127.0.0.1'
      : u.hostname;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function pickPrimaryOpenUrl(processes) {
  // Em projetos compostos (Front + Back), prioriza URL do frontend/web em vez da API
  const ranked = [];
  for (const p of processes) {
    const urls = p.reachableUrls && p.reachableUrls.length ? p.reachableUrls : [];
    for (const u of urls) {
      const lower = `${p.id} ${p.name} ${p.relCwd || ''}`.toLowerCase();
      let score = 10;
      if (/front|web|client|ui|vite|next|app/.test(lower)) score += 20;
      if (/back|api|server/.test(lower)) score -= 5;
      if (p.configuredUrl && p.configuredUrl === u) score += 8;
      ranked.push({ url: u, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].url : '';
}

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
      // Não chamar child.kill() antes do taskkill: matar o cmd.exe primeiro pode deixar o processo filho órfão!
      const tk = execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (err) => {
        if (err) {
          try { child.kill(); } catch {}
        }
      });
      if (tk && tk.unref) tk.unref();
      if (child.unref) child.unref();
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

  async function refreshReadiness(run) {
    if (!run) return;
    const now = Date.now();
    await Promise.all([...run.processes.values()].map(async (p) => {
      if (p.status !== 'running') {
        p.ready = false;
        p.reachableUrls = [];
        p.readyReason = p.status === 'exited' && p.exitCode && p.exitCode !== 0
          ? `encerrou com erro (código ${p.exitCode})`
          : p.status === 'stopped'
            ? 'parado'
            : 'finalizado';
        return;
      }

      const candidates = [];
      for (const u of p.detectedUrls) if (!candidates.includes(u)) candidates.push(u);
      if (p.configuredUrl && !candidates.includes(p.configuredUrl)) candidates.push(p.configuredUrl);

      if (candidates.length > 0) {
        const checks = await Promise.all(candidates.map(async (u) => ({ u, ok: await probeUrlReachable(u, 600) })));
        p.reachableUrls = checks.filter((c) => c.ok).map((c) => c.u);
        p.ready = p.reachableUrls.length > 0;
        p.readyReason = p.ready ? 'porta respondendo' : 'aguardando porta subir…';
        return;
      }

      if (p.expectsUrl) {
        p.reachableUrls = [];
        p.ready = false;
        p.readyReason = 'aguardando URL local…';
        return;
      }

      const aliveMs = now - (p.startedAt || now);
      const minWarmup = p.gui ? 1200 : 1800;
      p.reachableUrls = [];
      p.ready = aliveMs >= minWarmup;
      p.readyReason = p.ready ? 'processo ativo' : 'iniciando processo…';
    }));
  }

  function serializeRun(run) {
    if (!run) {
      return {
        ok: true,
        running: false,
        allReady: false,
        bootState: 'stopped',
        openUrl: '',
        profileId: '',
        profileName: '',
        kind: '',
        startedAt: 0,
        processes: [],
      };
    }
    const rawList = [...run.processes.values()];
    const processes = rawList.map((p) => ({
      id: p.id,
      name: p.name,
      cmd: p.cmd,
      cwd: p.relCwd || '',
      gui: !!p.gui,
      pid: p.pid || 0,
      status: p.status,
      ready: !!p.ready,
      readyReason: p.readyReason || '',
      expectsUrl: !!p.expectsUrl,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      endedAt: p.endedAt || 0,
      detectedUrls: p.detectedUrls.slice(),
      reachableUrls: (p.reachableUrls || []).slice(),
      logs: p.logs.slice(-160),
    }));
    const totalCount = processes.length;
    const runningCount = processes.filter((p) => p.status === 'running').length;
    const readyCount = processes.filter((p) => p.status === 'running' && p.ready).length;
    const failedCount = processes.filter((p) => p.status === 'exited' && p.exitCode !== 0).length;
    const running = runningCount > 0;
    const allReady = totalCount > 0 && runningCount === totalCount && readyCount === totalCount && failedCount === 0;
    let bootState = 'stopped';
    if (allReady) bootState = 'ready';
    else if (runningCount === totalCount && totalCount > 0) bootState = 'starting';
    else if (runningCount > 0 && runningCount < totalCount) bootState = 'degraded';
    else if (failedCount > 0) bootState = 'failed';
    const openUrl = allReady ? pickPrimaryOpenUrl(rawList) : '';
    return {
      ok: true,
      running,
      allReady,
      bootState,
      openUrl,
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

      const explicitUrl = pr.openUrl && /^https?:\/\//i.test(pr.openUrl) ? pr.openUrl : '';
      const entry = {
        id: pr.id,
        name: pr.name,
        cmd: pr.cmd,
        relCwd: pr.cwd || '',
        gui: !!pr.gui,
        pid: 0,
        status: 'running',
        ready: false,
        readyReason: 'iniciando…',
        expectsUrl: !!(pr.openUrl || profile.kind === 'web'),
        configuredUrl: explicitUrl,
        exitCode: null,
        startedAt: Date.now(),
        endedAt: 0,
        detectedUrls: explicitUrl ? [explicitUrl] : [],
        reachableUrls: [],
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

  async function statusAsync({ cwd } = {}) {
    const key = projectKey(cwd);
    const run = runs.get(key) || null;
    if (run) await refreshReadiness(run);
    return { status: 200, body: serializeRun(run) };
  }

  async function validateBoot({ cwd, profileId = '', waitMs = 9000, pollMs = 350 } = {}) {
    const started = start({ cwd, profileId });
    if (started.status !== 200) {
      return {
        status: started.status,
        body: { ok: true, bootOk: false, bootState: 'failed', bootError: String(started.body || 'Falha ao iniciar projeto.'), processes: [] },
      };
    }

    const key = projectKey(cwd);
    const deadline = Date.now() + Math.max(2000, Number(waitMs) || 9000);
    let snap = null;

    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const run = runs.get(key);
        if (!run) break;
        await refreshReadiness(run);
        snap = serializeRun(run);

        const failedProc = snap.processes.find((p) => p.status === 'exited' && p.exitCode !== 0);
        if (failedProc) {
          const tail = (failedProc.logs || []).filter((l) => l.stream === 'err' || l.text).slice(-5).map((l) => l.text).join(' | ');
          return {
            status: 200,
            body: {
              ok: true,
              bootOk: false,
              bootState: 'failed',
              bootError: `Processo "${failedProc.name}" falhou (código ${failedProc.exitCode})${tail ? `: ${tail.slice(0, 260)}` : ''}`,
              openUrl: '',
              processes: snap.processes,
            },
          };
        }

        if (snap.allReady) {
          await new Promise((r) => setTimeout(r, 350));
          await refreshReadiness(run);
          snap = serializeRun(run);
          if (snap.allReady) {
            return {
              status: 200,
              body: {
                ok: true,
                bootOk: true,
                bootState: 'ready',
                bootError: '',
                openUrl: snap.openUrl || '',
                processes: snap.processes,
              },
            };
          }
        }
      }

      const run = runs.get(key);
      if (run) {
        await refreshReadiness(run);
        snap = serializeRun(run);
      }
      const pending = (snap && snap.processes ? snap.processes : [])
        .filter((p) => !p.ready)
        .map((p) => `${p.name} (${p.readyReason || p.status})`);
      return {
        status: 200,
        body: {
          ok: true,
          bootOk: !!(snap && snap.allReady),
          bootState: (snap && snap.bootState) || 'failed',
          bootError: snap && snap.allReady ? '' : `Projeto não subiu por completo dentro do tempo limite: ${pending.join(', ') || 'sem resposta'}.`,
          openUrl: (snap && snap.openUrl) || '',
          processes: (snap && snap.processes) || [],
        },
      };
    } finally {
      stop({ cwd });
    }
  }

  function stopAll() {
    for (const run of runs.values()) {
      for (const p of run.processes.values()) {
        if (p.status === 'running' && p.child) killTree(p.child, platform);
      }
    }
    runs.clear();
  }

  return { getConfig, saveConfig, start, stop, status, statusAsync, validateBoot, stopAll };
}

module.exports = { createProjectRunner };
