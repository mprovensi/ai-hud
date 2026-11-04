// Resposta ao Codex pela fila nativa (`codex queue`), que a extensão do VS Code e o CLI atendem sozinhos.
const { execFile } = require('child_process');

function codexQueue({ exe, key, text, exec = execFile }) {
  return new Promise((resolve, reject) => {
    // --message=… : um texto começando com "-" não vira opção
    exec(exe, ['queue', '--thread', key, `--message=${text}`], { windowsHide: true, timeout: 60e3 }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).slice(0, 300)));
      else resolve();
    });
  });
}

module.exports = { codexQueue };
