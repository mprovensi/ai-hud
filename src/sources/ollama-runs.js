// `ollama run` no terminal: o Ollama não grava a conversa. O cartão mostra que a sessão existe (modelo,
// desde quando), o último comando digitado (~/.ollama/history, compartilhado por todos os `ollama run`)
// e traz o terminal para frente. Com o ollama-proxy, pergunta e resposta vêm do banco dele.
const fs = require('fs');
const { execFile } = require('child_process');
const { toMs, cut } = require('./common');
const { LOCAL_IP } = require('./ollama-proxy');

function modelFrom(cmd) {
  const args = String(cmd).trim().split(/\s+/);
  const i = args.findIndex((a) => a === 'run');
  for (let j = i + 1; i >= 0 && j < args.length; j++) if (!args[j].startsWith('-')) return args[j].replace(/^"|"$/g, '');
  return null;
}

// Procura os processos `ollama run` a cada 15 s; runs() devolve a última lista [{ pid, model, start }]
function createRunScanner({ exec = execFile, platform = process.platform } = {}) {
  let runs = [];
  function scan() {
    if (platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='ollama.exe'\" | Where-Object { $_.CommandLine -match '\\srun\\s' } | " +
        "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToString('o'))|$($_.CommandLine)\" }";
      exec('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 15e3 }, (err, out) => {
        if (err) return;
        runs = String(out).split(/\r?\n/).filter(Boolean).map((l) => {
          const [pid, start, ...cmd] = l.split('|');
          return { pid: Number(pid), start: Date.parse(start) || Date.now(), model: modelFrom(cmd.join('|')) };
        }).filter((r) => r.model);
      });
    } else {
      exec('ps', ['-eo', 'pid=,etimes=,args='], { timeout: 15e3 }, (err, out) => {
        if (err) return;
        runs = String(out).split('\n').filter((l) => /\bollama\s+run\s/.test(l)).map((l) => {
          const [, pid, secs, cmd] = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/) || [];
          return { pid: Number(pid), start: Date.now() - Number(secs) * 1000, model: modelFrom(cmd) };
        }).filter((r) => r.pid && r.model);
      });
    }
  }
  return { scan, start() { scan(); return setInterval(scan, 15e3); }, runs: () => runs };
}

// Chamadas de um `ollama run` aberto agora: mesmo modelo, vindas deste PC, depois que ele começou
const runCalls = (r, calls) => calls.filter((c) => /^ollama\//.test(c.user_agent || '') && LOCAL_IP.test(c.client_ip)
  && c.model === r.model && toMs(c.ts) >= r.start - 5e3);

function runSessions(runs, calls, historyFile) {
  if (!runs.length) return [];
  let lastCmd = '', histAt = 0, cmds = [];
  try {
    const lines = fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('/'));
    lastCmd = lines.length ? lines[lines.length - 1] : '';
    histAt = fs.statSync(historyFile).mtimeMs;
    // Últimos comandos digitados (o terminal não grava as respostas)
    cmds = lines.slice(-12).map((l) => ({ role: 'user', content: l }));
  } catch {}
  return runs.map((r) => {
    const mine = runCalls(r, calls);
    const last = mine[mine.length - 1];
    // Com o proxy, a conversa inteira; sem ele, só os comandos digitados
    const history = mine.length ? mine.flatMap((c) => [
      { role: 'user', content: c.last_user || '', at: toMs(c.ts), model: c.model },
      { role: 'assistant', content: c.response_text || '', at: toMs(c.ts), model: c.model },
    ]) : cmds;
    return {
      tool: 'Ollama', id: `ollama-run-${r.pid}`, pid: r.pid, file: '', cwd: '', where: 'ollama-run',
      project: r.model, title: 'terminal · ollama run',
      start: new Date(r.start).toISOString(), end: new Date(Math.max(r.start, histAt, last ? toMs(last.ts) : 0)).toISOString(),
      // Processo aberto = sessão ativa esperando o usuário no terminal
      mtime: Date.now(), lastStop: 'end_turn',
      firstPrompt: mine.length ? cut(mine[0].last_user || '', 120) : '',
      lastPrompt: cut(last ? last.last_user || '' : lastCmd, 400),
      lastReply: last ? cut(last.response_text || '', 4000) : '',
      lastReplyAt: last ? toMs(last.ts) : 0,
      prompts: mine.length, models: new Set([r.model]), lastTool: '', history,
      input: mine.reduce((a, c) => a + (c.prompt_tokens || 0), 0), output: mine.reduce((a, c) => a + (c.completion_tokens || 0), 0),
      cacheRead: 0, cacheWrite: 0, context: 0, contextWindow: 0, toolCalls: 0, tools: {}, events: [], subagent: false,
    };
  });
}

module.exports = { createRunScanner, runCalls, runSessions, modelFrom };
