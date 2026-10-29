const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { ROOT } = require('../paths');

function selectBridge(records, ancestors, now = Date.now()) {
  const ids = new Set(ancestors.map((item) => item.pid));
  const matches = [];
  for (const record of records) {
    if (!record || now - record.at > 15000 || record.at > now + 5000 || !Number.isFinite(record.at)) continue;
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !/^[a-f0-9]{48}$/.test(record.token || '')) continue;
    for (const terminal of Array.isArray(record.terminals) ? record.terminals : []) if (terminal && Number.isInteger(terminal.pid) && ids.has(terminal.pid)) matches.push({ record, pid: terminal.pid });
  }
  return matches.length === 1 ? matches[0] : null;
}

function titleHints(session, info) {
  const base = (value) => String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return [...new Set([info.consoleTitle, session.title, ...(session.models || []), base(session.cwd)]
    // As pistas vão em JSON: o "|" fica (o Codex CLI usa "assunto | pasta" como título da aba)
    .filter((value) => typeof value === 'string' && value.trim().length >= 3).map((value) => value.trim()))];
}

function createTerminalFocus(options = {}) {
  const home = options.home || os.homedir();
  const native = options.native || ((args) => new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'terminal-focus.ps1'), ...args],
      { windowsHide: true, timeout: 15000 }, (error, out) => { try { resolve(JSON.parse(String(out).trim())); } catch { resolve({ ok: false, message: 'O seletor de abas não respondeu.' }); } });
  }));
  const send = options.send || ((record, pid) => new Promise((resolve) => {
    const body = JSON.stringify({ pid });
    const req = http.request({ hostname: '127.0.0.1', port: record.port, path: '/focus', method: 'POST', timeout: 2500,
      headers: { Authorization: 'Bearer ' + record.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let out = '';
      res.on('data', (chunk) => { if (out.length < 4096) out += chunk; });
      res.on('end', () => { try { const result = JSON.parse(out); resolve(res.statusCode === 200 && result.ok === true && (result.selectedPid === pid || (record.protocol == null && result.selectedPid == null))); } catch { resolve(false); } });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end(body);
  }));
  return async (session) => {
    let clientPid = session.pid || 0, expectedStart = '';
    if (!clientPid && session.tool === 'Claude Code') {
      const directory = path.join(home, '.claude', 'sessions');
      try {
        for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.json'))) {
          try {
            const metadata = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
            if (metadata.sessionId === session.id && Number.isInteger(metadata.pid)) { clientPid = metadata.pid; expectedStart = metadata.procStart || ''; break; }
          } catch {}
        }
      } catch {}
    }
    const expected = session.tool === 'Claude Code' ? 'claude' : session.tool === 'Codex' ? 'codex' : 'ollama';
    const info = await native(['-Mode', 'Inspect', '-ClientProcessId', String(clientPid), '-SessionFile', session.file || '', '-ExpectedProcess', expected, '-ExpectedStart', String(expectedStart),
      '-SessionStartMs', String(Date.parse(session.start) || 0)]);
    if (!info.ok || !info.clientPid) return { ok: false, message: info.message || 'Não identifiquei um processo aberto para esta sessão de terminal.' };
    const records = [];
    const directory = path.join(home, '.ai-hud', 'terminal-bridges');
    try { for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) { try { records.push(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))); } catch {} } } catch {}
    const bridge = selectBridge(records, info.ancestors || []);
    if (bridge) {
      if (!(await send(bridge.record, bridge.pid))) return { ok: false, message: 'O terminal integrado não está mais disponível.' };
      return { ok: true, host: 'vscode', workspaceName: typeof bridge.record.workspaceName === 'string' ? bridge.record.workspaceName : '',
        folders: (Array.isArray(bridge.record.folders) ? bridge.record.folders : []).filter((f) => typeof f === 'string'), message: 'Aba correta selecionada no terminal do VS Code.' };
    }
    if ((info.ancestors || []).some((item) => /^code(?: - insiders)?\.exe$/i.test(item.name))) {
      return { ok: false, message: 'Instale a integração AI HUD Terminal Focus no VS Code para selecionar esta aba.' };
    }
    const result = await native(['-Mode', 'Select', '-TitleHintsBase64', Buffer.from(JSON.stringify(titleHints(session, info))).toString('base64')]);
    if (result.ok) return { ok: true, host: 'windows-terminal', message: 'Aba correta selecionada no Windows Terminal.' };
    // Sem aba no Windows Terminal: janela de console própria (PowerShell/cmd no conhost ou outro terminal)
    if (info.consoleWindow) {
      const own = await native(['-Mode', 'Window', '-WindowHandle', String(info.consoleWindow)]);
      if (own.ok) return { ok: true, host: 'console', message: 'Janela do terminal em primeiro plano.' };
    }
    return { ok: false, message: result.message || 'Não identifiquei uma aba única para esta sessão.' };
  };
}

module.exports = { createTerminalFocus, selectBridge, titleHints };
