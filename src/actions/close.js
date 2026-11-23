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

function createClose({ home = os.homedir(), platform = process.platform, exec = execFile, running = null } = {}) {
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
  const markEnded = (s) => {
    ended.set(s.id, Date.now());
    s.endedAt = ended.get(s.id);
  };

  async function closeSession(s) {
    // 1. Se o próprio HUD disparou o processo (via + Nova ou Responder headless), mata o processo conhecido
    const hudPid = running && running.getPid(s.id);
    if (Number.isInteger(hudPid)) {
      await kill(hudPid, '');
      running.drop(s.id);
      markEnded(s);
      return { ok: true, message: 'Sessão encerrada.' };
    }
    // 2. Processos externos com PID registrado (Claude Code e `ollama run`)
    if (s.tool === 'Claude Code' || s.where === 'ollama-run') {
      const proc = s.tool === 'Claude Code' ? claudeProcess(home, s.id)
        : (Number.isInteger(s.pid) ? { pid: s.pid, procStart: '' } : null);
      if (proc) {
        if (await kill(proc.pid, proc.procStart)) {
          markEnded(s);
          return { ok: true, message: 'Sessão encerrada.' };
        }
        // PID registrado não corresponde mais ao processo (ou já terminou): nunca mata PID herdado
        return { ok: false, message: 'Essa sessão não está mais aberta no PC.' };
      }
      // Sem processo aberto (ex.: sessão headless criada via `claude -p` já finalizada): arquiva no HUD
      if (s.tool === 'Claude Code' && s.state !== 'working') {
        markEnded(s);
        return { ok: true, message: 'Sessão encerrada no HUD.' };
      }
      return { ok: false, message: 'Essa sessão não está mais aberta no PC.' };
    }
    // 3. Codex, Gemini e Ollama (app/API/HUD): encerra/arquiva no HUD (move para Recentes)
    if (s.tool === 'Codex' || s.tool === 'Gemini' || s.tool === 'Ollama') {
      markEnded(s);
      return { ok: true, message: 'Sessão encerrada no HUD.' };
    }
    return { ok: false, message: 'Ferramenta sem suporte para encerrar pelo HUD.' };
  }
  async function stopSession(s) {
    const hudPid = running && running.getPid(s.id);
    if (!Number.isInteger(hudPid)) {
      return { ok: false, message: 'Nenhum turno em execução gerenciado pelo HUD para parar.' };
    }
    await kill(hudPid, '');
    running.drop(s.id);
    return { ok: true, message: 'Turno interrompido.' };
  }

  closeSession.stop = stopSession;
  closeSession.endedAt = (id) => ended.get(id) || 0;
  return closeSession;
}

module.exports = { createClose, claudeProcess };
