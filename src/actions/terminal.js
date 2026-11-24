// Execução controlada de comandos de terminal dentro de uma pasta de projeto autorizada (Fase 5).
// Zero dependências externas, timeout, limite de saída e redação determinística de segredos.
const fs = require('fs');
const { spawn } = require('child_process');
const { redactSecrets } = require('../core/redact');

const MAX_CMD_LEN = 4000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_TIMEOUT_MS = 60000;

function createTerminal({ config = {}, platform = process.platform, spawnProc = spawn } = {}) {
  return function runCommand({ cwd = '', command = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (config && config.disableTerminal) {
      return Promise.resolve({ status: 403, body: 'Terminal integrado desativado em config.json.' });
    }
    const cmd = String(command || '').trim();
    if (!cmd) return Promise.resolve({ status: 400, body: 'Informe um comando para executar.' });
    if (cmd.length > MAX_CMD_LEN) return Promise.resolve({ status: 400, body: 'Comando muito longo.' });
    if (!cwd || !fs.existsSync(cwd)) return Promise.resolve({ status: 404, body: 'Pasta do projeto não encontrada neste PC.' });

    const limitMs = Math.max(2000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const exe = platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const args = platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', cmd]
        : ['-c', cmd];

      let child;
      try {
        child = spawnProc(exe, args, { cwd, windowsHide: true });
      } catch (err) {
        return resolve({ status: 500, body: err.message || 'Falha ao iniciar processo.' });
      }

      const outChunks = [];
      const errChunks = [];
      let totalBytes = 0;
      let truncated = false;
      let timedOut = false;
      let finished = false;

      const pushChunk = (arr, chunk) => {
        if (totalBytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
        const left = MAX_OUTPUT_BYTES - totalBytes;
        const slice = chunk.length > left ? chunk.subarray(0, left) : chunk;
        arr.push(slice);
        totalBytes += slice.length;
        if (chunk.length > left) truncated = true;
      };

      if (child.stdout) child.stdout.on('data', (c) => pushChunk(outChunks, Buffer.from(c)));
      if (child.stderr) child.stderr.on('data', (c) => pushChunk(errChunks, Buffer.from(c)));

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
      }, limitMs);
      if (timer.unref) timer.unref();

      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const rOut = redactSecrets(Buffer.concat(outChunks).toString('utf8'));
        const rErr = redactSecrets(Buffer.concat(errChunks).toString('utf8'));
        resolve({
          status: 200,
          body: {
            ok: !timedOut && code === 0,
            code: typeof code === 'number' ? code : -1,
            timedOut,
            truncated,
            redacted: (rOut.count + rErr.count) > 0,
            durationMs: Date.now() - startedAt,
            cwd,
            stdout: rOut.text,
            stderr: rErr.text,
          },
        });
      };

      child.on('error', (err) => {
        pushChunk(errChunks, Buffer.from(err.message || 'erro'));
        finish(-1);
      });
      child.on('close', (code) => finish(code));
    });
  };
}

module.exports = { createTerminal };
