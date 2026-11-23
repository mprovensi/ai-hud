// Responder a uma sessão pelo HUD. Cada ferramenta tem o seu caminho:
//   Claude  fila do HUD (hook-stop.js quando o terminal está aberto) ou `claude -p --resume` sem terminal
//   Codex   fila nativa (`codex queue`) ou fallback `codex exec resume` quando a sessão não está aberta
//   Gemini  Antigravity CLI (`agy --conversation <id> --print=<texto>`)
//   Ollama  continua a conversa pelo Ollama local; a resposta fica no HUD (não aparece no app)
// Resolve { status, body } (status HTTP já escolhido; body objeto = JSON, texto = mensagem).
const { spawn: nodeSpawn } = require('child_process');
const { ROOT } = require('../../infra/paths');
const { codexQueue } = require('./codex-queue');
const { geminiReply } = require('./gemini-reply');

function spawnDetached(exe, args, cwd, spawnFn = nodeSpawn, running = null, trackKey = '') {
  return new Promise((resolve, reject) => {
    if (!exe) return reject(new Error('CLI não encontrado neste PC.'));
    const child = spawnFn(exe, args, {
      cwd: cwd || ROOT,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (running && trackKey) running.track(trackKey, child);
    let stderr = '', settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!err && typeof child.unref === 'function') child.unref();
      err ? reject(err) : resolve();
    };
    if (child.stderr) child.stderr.on('data', (c) => { if (stderr.length < 500) stderr += c; });
    child.on('error', (e) => {
      const msg = e.code === 'ENOENT' ? `${exe} não encontrado neste PC.` : e.message;
      if (running && trackKey) running.recordError(trackKey, msg);
      done(new Error(msg));
    });
    child.on('exit', (code) => {
      if (code && code !== 0) {
        const msg = stderr.trim().split(/\r?\n/)[0] || `processo encerrou com código ${code}`;
        if (running && trackKey) running.recordError(trackKey, msg);
        done(new Error(msg));
      } else {
        done(null);
      }
    });
    const timer = setTimeout(() => done(null), 200);
  });
}

function createReplies({ queue, claudeExe = '', codexExe, agyExe, exec, spawn, findSession, ollamaReply, ollamaUrl, running = null }) {
  return async function reply({ key, text, tool }) {
    if (!key || typeof key !== 'string') return { status: 400, body: 'sessão inválida' };
    text = String(text || '').trim().slice(0, 4000);
    if (tool === 'Ollama') {
      const s = findSession((x) => x.tool === 'Ollama' && x.id === key);
      if (!s || !text) return { status: 400, body: 'sessão inválida' };
      try { return { status: 200, body: await ollamaReply(s, text, ollamaUrl()) }; } catch (e) { return { status: 409, body: e.message }; }
    }
    if (tool === 'Codex') {
      if (!/^[0-9a-f-]{36}$/.test(key) || !text) return { status: 400, body: 'sessão inválida' };
      if (running && running.isBusy(key)) return { status: 409, body: 'esta sessão já está executando uma resposta; aguarde terminar' };
      try {
        await codexQueue({ exe: codexExe, key, text, exec });
        return { status: 200, body: { sent: true } };
      } catch (queueErr) {
        // Sessão criada pelo HUD (ou sem terminal aberto): retoma via `codex exec resume`
        const s = findSession((x) => x.tool === 'Codex' && (x.id === key || x.id.endsWith('-' + key)));
        if (!codexExe) return { status: 502, body: queueErr.message };
        try {
          await spawnDetached(codexExe,
            ['exec', 'resume', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', key, text],
            s && s.cwd, spawn, running, key);
          return { status: 200, body: { sent: true } };
        } catch (e) { return { status: 502, body: e.message || queueErr.message }; }
      }
    }
    if (tool === 'Gemini') {
      if (!/^[0-9a-f-]{36}$/.test(key)) return { status: 400, body: 'sessão do Gemini sem ID compatível para resposta remota' };
      const s = findSession((x) => x.tool === 'Gemini' && x.id === key);
      if (s && s.where === 'antigravity') {
        return {
          status: 409,
          body: 'Sessões abertas no app Antigravity (IDE) não aceitam resposta via agy CLI. Use "↪ Handoff" para continuar pelo HUD ou "Abrir no PC".',
        };
      }
      if (running && running.isBusy(key)) return { status: 409, body: 'esta sessão já está executando uma resposta; aguarde terminar' };
      try {
        await geminiReply({ exe: agyExe, key, text, cwd: s && s.cwd, spawnFn: spawn, running });
        return { status: 200, body: { sent: true } };
      } catch (e) { return { status: 502, body: e.message }; }
    }
    // Claude Code: usa a fila do hook quando há terminal ouvindo; sem terminal aberto, continua via `claude -p --resume`
    if (text && !queue.listenState(key, Date.now()) && claudeExe && /^[0-9a-f-]{36}$/.test(key)) {
      if (running && running.isBusy(key)) return { status: 409, body: 'esta sessão já está executando uma resposta; aguarde terminar' };
      const s = findSession((x) => x.tool === 'Claude Code' && x.id === key);
      try {
        await spawnDetached(claudeExe, ['-p', text, '--resume', key, '--dangerously-skip-permissions'], s && s.cwd, spawn, running, key);
        return { status: 200, body: { sent: true } };
      } catch (e) { return { status: 502, body: e.message }; }
    }
    queue.set(key, text);
    return { status: 200, body: { queued: text || null, listening: queue.listenState(key, Date.now()) } };
  };
}

module.exports = { createReplies };
