// Resposta ao Gemini (Antigravity): continua a conversa pelo `agy --conversation <id> --print=<texto>`.
// Dispara o processo em segundo plano e devolve assim que confirma que o CLI iniciou (o progresso
// e a resposta aparecem ao vivo no HUD pela releitura do transcript.jsonl).
const { spawn } = require('child_process');
const { ROOT } = require('../../infra/paths');

function geminiReply({ exe, key, text, cwd, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    if (!exe) return reject(new Error('Antigravity CLI (agy) não encontrado neste PC.'));
    const child = spawnFn(exe, ['--conversation', key, `--print=${text}`, '--dangerously-skip-permissions', '--output-format', 'json'], {
      cwd: cwd || ROOT,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '', settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!err && typeof child.unref === 'function') child.unref();
      err ? reject(err) : resolve();
    };
    if (child.stderr) child.stderr.on('data', (c) => { if (stderr.length < 500) stderr += c; });
    child.on('error', (e) => done(new Error(e.code === 'ENOENT' ? 'Antigravity CLI (agy) não encontrado.' : e.message)));
    child.on('exit', (code) => {
      if (code && code !== 0) done(new Error(stderr.trim().split(/\r?\n/)[0] || `agy encerrou com código ${code}`));
      else done(null);
    });
    // Se não falhou imediatamente ao iniciar, segue em segundo plano
    const timer = setTimeout(() => done(null), 200);
  });
}

module.exports = { geminiReply };
