// Gerenciador de sessões PTY interativas reais (Win32 ConPTY via csc.exe nativo; Unix PTY via python3 stdlib).
// Zero dependências npm em src/. Mantém sessões vivas com ring buffer ao alternar Conversa <-> Terminal.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const CSC_PATH = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const BRIDGE_DIR = path.resolve(__dirname, '..', '..', 'integrations', 'pty-bridge');
const MAX_HISTORY_BYTES = 64 * 1024;
const MAX_ACTIVE_PTYS = 12;

function quoteArg(arg) {
  const s = String(arg || '');
  if (!s) return '""';
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function stripPeerPrefix(id) {
  return String(id || '').replace(/^m\d+:/, '');
}

function buildInteractiveCommand({ mode = 'shell', tool = '', sessionId = '', model = '', claudeExe = '', codexExe = '', agyExe = '', platform = process.platform }) {
  const sid = stripPeerPrefix(sessionId);
  const isWin = platform === 'win32';
  const cleanTool = String(tool || '').trim();

  if (mode === 'resume' || mode === 'cli') {
    if (cleanTool === 'Claude Code') {
      const bin = claudeExe || 'claude';
      const args = mode === 'resume' && /^[0-9a-f-]{36}$/i.test(sid) ? ['--resume', sid] : [];
      if (model) args.push('--model', model);
      return `${quoteArg(bin)}${args.length ? ' ' + args.map(quoteArg).join(' ') : ''}`;
    }
    if (cleanTool === 'Codex') {
      const bin = codexExe || 'codex';
      const args = mode === 'resume' && /^[0-9a-f-]{36}$/i.test(sid) ? ['resume', sid] : [];
      if (model) args.push('-m', model);
      return `${quoteArg(bin)}${args.length ? ' ' + args.map(quoteArg).join(' ') : ''}`;
    }
    if (cleanTool === 'Gemini' || cleanTool === 'Antigravity') {
      const bin = agyExe || 'agy';
      const args = mode === 'resume' && /^[0-9a-f-]{36}$/i.test(sid) ? ['--conversation', sid] : [];
      return `${quoteArg(bin)}${args.length ? ' ' + args.map(quoteArg).join(' ') : ''}`;
    }
    if (cleanTool === 'Ollama') {
      return model ? `ollama run ${quoteArg(model)}` : 'ollama list';
    }
  }

  return isWin ? 'powershell.exe -NoLogo' : (process.env.SHELL || '/bin/bash');
}

function ensureWinConPtyExe(dataDir, log = () => {}) {
  const src = path.join(BRIDGE_DIR, 'conpty.cs');
  const binDir = path.join(dataDir, 'bin');
  const exe = path.join(binDir, 'conpty.exe');
  if (!fs.existsSync(src) || !fs.existsSync(CSC_PATH)) return null;

  let needBuild = !fs.existsSync(exe);
  if (!needBuild) {
    try { needBuild = fs.statSync(src).mtimeMs > fs.statSync(exe).mtimeMs; } catch { needBuild = true; }
  }
  if (needBuild) {
    fs.mkdirSync(binDir, { recursive: true });
    try {
      execFileSync(CSC_PATH, ['/nologo', '/optimize+', `/out:${exe}`, src], { timeout: 20000, windowsHide: true });
      log('ConPTY helper compilado em data/bin/conpty.exe');
    } catch (err) {
      log(`Falha ao compilar conpty.exe: ${err.message}`);
      return null;
    }
  }
  return exe;
}

function createPtyManager({
  dataDir,
  config = {},
  claudeExe = '',
  codexExe = '',
  agyExe = '',
  platform = process.platform,
  log = () => {},
}) {
  const sessions = new Map();

  function status() {
    if (config && config.disableTerminal) return { ok: true, available: false, reason: 'desativado em config.json' };
    if (platform === 'win32') {
      const ok = fs.existsSync(CSC_PATH) && fs.existsSync(path.join(BRIDGE_DIR, 'conpty.cs'));
      return { ok: true, available: ok, backend: ok ? 'win32-conpty' : '', active: sessions.size };
    }
    const unixScript = path.join(BRIDGE_DIR, 'unix-pty.py');
    return { ok: true, available: fs.existsSync(unixScript), backend: 'unix-pty', active: sessions.size };
  }

  function spawnBridge({ cwd, cmd, cols = 100, rows = 30 }) {
    const cwdB64 = Buffer.from(cwd, 'utf8').toString('base64');
    const cmdB64 = Buffer.from(cmd, 'utf8').toString('base64');
    const commonArgs = ['--cols', String(cols), '--rows', String(rows), '--cwd-b64', cwdB64, '--cmd-b64', cmdB64];

    if (platform === 'win32') {
      const exe = ensureWinConPtyExe(dataDir, log);
      if (!exe) throw new Error('Helper ConPTY indisponível nesta máquina Windows.');
      return spawn(exe, commonArgs, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    const script = path.join(BRIDGE_DIR, 'unix-pty.py');
    return spawn('python3', [script, ...commonArgs], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  function getOrCreate({ key, cwd, mode = 'shell', tool = '', sessionId = '', model = '', cols = 100, rows = 30, fresh = false }) {
    if (config && config.disableTerminal) throw new Error('Terminal integrado desativado em config.json.');
    if (!cwd || !fs.existsSync(cwd)) throw new Error('Pasta do projeto não encontrada neste PC.');

    const existing = sessions.get(key);
    if (existing && !fresh && !existing.exited) {
      if (cols && rows) existing.resize(cols, rows);
      return existing;
    }
    if (existing) existing.kill();

    // Evita acúmulo de sessões antigas encerradas
    if (sessions.size >= MAX_ACTIVE_PTYS) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (oldest) oldest.kill();
    }

    const cmd = buildInteractiveCommand({ mode, tool, sessionId, model, claudeExe, codexExe, agyExe, platform });
    const child = spawnBridge({ cwd, cmd, cols, rows });
    const emitter = new EventEmitter();
    const chunks = [];
    let historyBytes = 0;
    let buf = '';

    const ptySess = {
      key,
      cwd,
      cmd,
      mode,
      tool,
      exited: false,
      exitCode: null,
      lastActivity: Date.now(),
      onData: (fn) => { emitter.on('data', fn); return () => emitter.off('data', fn); },
      onExit: (fn) => { emitter.on('exit', fn); return () => emitter.off('exit', fn); },
      history: () => Buffer.concat(chunks),
      write: (strOrBuf) => {
        if (ptySess.exited || !child.stdin || child.stdin.destroyed) return;
        ptySess.lastActivity = Date.now();
        const b64 = Buffer.from(strOrBuf).toString('base64');
        try { child.stdin.write(`{"t":"in","d":"${b64}"}\n`); } catch {}
      },
      resize: (c, r) => {
        if (ptySess.exited || !child.stdin || child.stdin.destroyed) return;
        const nc = Math.max(20, Math.min(400, Number(c) || 100));
        const nr = Math.max(5, Math.min(120, Number(r) || 30));
        try { child.stdin.write(`{"t":"resize","cols":${nc},"rows":${nr}}\n`); } catch {}
      },
      kill: () => {
        if (!ptySess.exited) {
          ptySess.exited = true;
          ptySess.exitCode = 0;
          try {
            if (child.stdin && !child.stdin.destroyed) {
              child.stdin.write('{"t":"kill"}\n');
              child.stdin.end();
            }
          } catch {}
          emitter.emit('exit', 0);
          // Dá 300ms para o helper encerrar graciosamente o ConPTY e seus filhos; depois força tree-kill
          const pid = child.pid;
          const force = setTimeout(() => {
            try {
              if (platform === 'win32' && pid) {
                spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
              } else {
                child.kill('SIGKILL');
              }
            } catch {}
          }, 300);
          if (force.unref) force.unref();
        }
        sessions.delete(key);
      },
    };

    const pushHistory = (b) => {
      chunks.push(b);
      historyBytes += b.length;
      while (historyBytes > MAX_HISTORY_BYTES && chunks.length > 1) {
        historyBytes -= chunks.shift().length;
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.t === 'out' && msg.d) {
            const raw = Buffer.from(msg.d, 'base64');
            ptySess.lastActivity = Date.now();
            pushHistory(raw);
            emitter.emit('data', raw);
          } else if (msg.t === 'err' && msg.m) {
            const raw = Buffer.from(`\r\n\x1b[31m[pty] ${msg.m}\x1b[0m\r\n`, 'utf8');
            pushHistory(raw);
            emitter.emit('data', raw);
          } else if (msg.t === 'exit') {
            ptySess.exited = true;
            ptySess.exitCode = msg.code;
            emitter.emit('exit', msg.code);
          }
        } catch {}
      }
    });

    child.on('close', (code) => {
      if (!ptySess.exited) {
        ptySess.exited = true;
        ptySess.exitCode = typeof code === 'number' ? code : 0;
        emitter.emit('exit', ptySess.exitCode);
      }
      const t = setTimeout(() => { if (sessions.get(key) === ptySess) sessions.delete(key); }, 10 * 60 * 1000);
      if (t.unref) t.unref();
    });

    sessions.set(key, ptySess);
    return ptySess;
  }

  function closeAll() {
    for (const s of [...sessions.values()]) s.kill();
  }

  return { status, getOrCreate, closeAll };
}

module.exports = { createPtyManager, buildInteractiveCommand };
