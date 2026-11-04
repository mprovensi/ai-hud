// Encerrar a sessão: termina o processo dela no PC (com os filhos: ferramentas e servidores MCP).
// Claude Code registra o processo de cada sessão em ~/.claude/sessions/<pid>.json; `ollama run` traz o PID.
// O PID só é usado se o processo ainda for o mesmo (hora de início), para não matar outro que herdou o número.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Processo registrado para a sessão do Claude Code: { pid, procStart } ou null
function claudeProcess(home, id) {
  const dir = path.join(home, '.claude', 'sessions');
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (m.sessionId === id && Number.isInteger(m.pid)) return { pid: m.pid, procStart: m.procStart || '' };
      } catch {}
    }
  } catch {}
  return null;
}

function createClose({ home = os.homedir(), platform = process.platform, exec = execFile } = {}) {
  const run = (cmd, args) => new Promise((resolve) => exec(cmd, args, { windowsHide: true, timeout: 15e3 },
    (err, out) => resolve({ ok: !err, out: String(out || '').trim() })));
  // Hora de início do processo em FILETIME (como o procStart do Claude); '' = processo não existe
  const startOf = async (pid) => (await run('powershell', ['-NoProfile', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToFileTimeUtc() }`])).out;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  async function kill(pid, procStart) {
    if (platform === 'win32') {
      const start = await startOf(pid);
      if (!/^\d+$/.test(start)) return false;
      // Mais de 1 s de diferença: o PID agora é de outro processo
      if (/^\d+$/.test(procStart) && Math.abs(Number(start) - Number(procStart)) > 1e7) return false;
      return (await run('taskkill', ['/PID', String(pid), '/T', '/F'])).ok;
    }
    if (!alive(pid)) return false;
    try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
  }

  // Sessões encerradas por aqui: id → quando. O log não registra o fim, então o estado vem daqui (endedAt)
  const ended = new Map();

  async function closeSession(s) {
    let proc = null;
    if (s.tool === 'Claude Code') proc = claudeProcess(home, s.id);
    else if (s.where === 'ollama-run' && Number.isInteger(s.pid)) proc = { pid: s.pid, procStart: '' };
    else return { ok: false, message: 'Encerrar pelo HUD funciona para sessões do Claude Code e do ollama run.' };
    if (!proc || !(await kill(proc.pid, proc.procStart))) return { ok: false, message: 'Essa sessão não está mais aberta no PC.' };
    ended.set(s.id, Date.now());
    s.endedAt = ended.get(s.id);
    return { ok: true, message: 'Sessão encerrada.' };
  }
  closeSession.endedAt = (id) => ended.get(id) || 0;
  return closeSession;
}

module.exports = { createClose, claudeProcess };
