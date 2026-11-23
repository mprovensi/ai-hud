// Inicia uma nova sessão de IA (Claude Code, Codex, Gemini/Antigravity ou Ollama) direto pelo HUD,
// com todas as permissões ativadas para execução autônoma sem janela interativa aberta.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveCwd(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return os.homedir();
  try {
    if (fs.statSync(trimmed).isDirectory()) return trimmed;
  } catch {}
  return null;
}

function listBrainIds(brainDir) {
  try {
    return new Set(fs.readdirSync(brainDir, { withFileTypes: true }).filter((e) => e.isDirectory() && UUID_RE.test(e.name)).map((e) => e.name));
  } catch { return new Set(); }
}

function extractIdFromJsonLine(line) {
  try {
    const obj = JSON.parse(line);
    const id = obj.thread_id || obj.conversation_id || obj.conversationId || obj.session_id || obj.sessionId;
    if (typeof id === 'string' && UUID_RE.test(id)) return id;
  } catch {}
  return null;
}

// Dispara um CLI em segundo plano; opcionalmente espera até `waitMs` por um UUID (stdout JSON ou pasta nova)
function launchCli({ exe, args, cwd, spawnFn, waitForId = null, waitMs = 4000, quickMs = 250 }) {
  return new Promise((resolve, reject) => {
    if (!exe) return reject(new Error('CLI não encontrado neste PC.'));
    const child = spawnFn(exe, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', waitForId ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '', buf = '', settled = false, poll = null;
    const finish = (err, id = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      // Continua drenando stdout em segundo plano para o processo nunca levar SIGPIPE
      if (child.stdout) {
        child.stdout.removeAllListeners('data');
        child.stdout.resume();
      }
      if (!err && typeof child.unref === 'function') child.unref();
      err ? reject(err) : resolve(id);
    };
    if (child.stderr) child.stderr.on('data', (c) => { if (stderr.length < 600) stderr += c; });
    if (child.stdout && waitForId) {
      child.stdout.on('data', (chunk) => {
        buf += String(chunk || '');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const found = extractIdFromJsonLine(line);
          if (found) return finish(null, found);
        }
      });
    }
    if (typeof waitForId === 'function') {
      poll = setInterval(() => {
        const found = waitForId();
        if (found) finish(null, found);
      }, 250);
    }
    child.on('error', (e) => finish(new Error(e.code === 'ENOENT' ? `${exe} não encontrado neste PC.` : e.message)));
    child.on('exit', (code) => {
      if (code && code !== 0) finish(new Error(stderr.trim().split(/\r?\n/)[0] || `processo encerrou com código ${code}`));
      else finish(null, typeof waitForId === 'function' ? waitForId() : null);
    });
    const timer = setTimeout(() => finish(null, typeof waitForId === 'function' ? waitForId() : null), waitForId ? waitMs : quickMs);
  });
}

function createSessionLauncher({
  claudeExe = '',
  codexExe = '',
  agyExe = '',
  spawn = nodeSpawn,
  ollamaCreate,
  ollamaUrl,
  geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini'),
} = {}) {
  return async function launch({ tool, model = '', cwd = '', prompt = '' }) {
    const cleanPrompt = String(prompt || '').trim().slice(0, 4000);
    const cleanModel = String(model || '').trim().slice(0, 120);
    if (!cleanPrompt) return { status: 400, body: 'escreva uma mensagem inicial' };

    if (tool === 'Ollama') {
      if (!ollamaCreate || !ollamaUrl) return { status: 400, body: 'Ollama não disponível neste PC' };
      try {
        const created = await ollamaCreate(cleanModel, cleanPrompt, ollamaUrl());
        return { status: 200, body: created };
      } catch (e) { return { status: 400, body: e.message }; }
    }

    const targetCwd = resolveCwd(cwd);
    if (!targetCwd) return { status: 400, body: 'pasta informada não existe neste PC' };

    if (tool === 'Claude Code') {
      if (!claudeExe) return { status: 400, body: 'Claude Code não encontrado neste PC' };
      const id = crypto.randomUUID();
      const args = ['-p', cleanPrompt, '--session-id', id, '--dangerously-skip-permissions'];
      if (cleanModel) args.push('--model', cleanModel);
      try {
        await launchCli({ exe: claudeExe, args, cwd: targetCwd, spawnFn: spawn });
        return { status: 200, body: { ok: true, id, tool: 'Claude Code' } };
      } catch (e) { return { status: 502, body: e.message }; }
    }

    if (tool === 'Codex') {
      if (!codexExe) return { status: 400, body: 'Codex CLI não encontrado neste PC' };
      const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-C', targetCwd];
      if (cleanModel) args.push('-m', cleanModel);
      args.push(cleanPrompt);
      try {
        const id = await launchCli({ exe: codexExe, args, cwd: targetCwd, spawnFn: spawn, waitForId: true });
        return { status: 200, body: { ok: true, id, tool: 'Codex' } };
      } catch (e) { return { status: 502, body: e.message }; }
    }

    if (tool === 'Gemini') {
      // Gemini usa exclusivamente Antigravity CLI (`agy`)
      if (!agyExe) return { status: 400, body: 'Antigravity CLI (agy) não encontrado neste PC' };
      const brainDir = path.join(geminiHome, 'antigravity', 'brain');
      const before = listBrainIds(brainDir);
      const detectNewBrain = () => {
        for (const id of listBrainIds(brainDir)) if (!before.has(id)) return id;
        return null;
      };
      const args = [`--print=${cleanPrompt}`, '--dangerously-skip-permissions', '--output-format', 'stream-json'];
      if (cleanModel) args.push('--model', cleanModel);
      try {
        const id = await launchCli({ exe: agyExe, args, cwd: targetCwd, spawnFn: spawn, waitForId: detectNewBrain });
        return { status: 200, body: { ok: true, id, tool: 'Gemini' } };
      } catch (e) { return { status: 502, body: e.message }; }
    }

    return { status: 400, body: 'ferramenta inválida' };
  };
}

module.exports = { createSessionLauncher };
