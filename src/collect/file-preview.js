// Prévia segura somente leitura de arquivos de projeto e `git diff` (camada collect/).
// Protege contra path traversal, symlinks fora da pasta, arquivos sensíveis e binários.
const fs = require('fs');
const { execFile } = require('child_process');
const { isWithinRoot, isSecretPath, toSafeRelPath, resolveContainedPath } = require('../core/path-guard');
const { redactSecrets } = require('../core/redact');

const DEFAULT_MAX_BYTES = 256 * 1024;

function runGit(cwd, args, exec = execFile) {
  return new Promise((resolve) => {
    exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function readGitBrief(cwd, exec = execFile) {
  if (!cwd) return { branch: '', status: '' };
  let realCwd;
  try { realCwd = fs.realpathSync(cwd); } catch { return { branch: '', status: '' }; }
  const [branch, status] = await Promise.all([
    runGit(realCwd, ['rev-parse', '--abbrev-ref', 'HEAD'], exec),
    runGit(realCwd, ['status', '--short'], exec),
  ]);
  return { branch: branch.trim(), status: status.trim() };
}

function readBoundedFile(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { error: 'O caminho não é um arquivo regular.', status: 400 };
  const toRead = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
    const slice = buf.subarray(0, bytesRead);
    // Detecção simples de arquivo binário (byte nulo nos primeiros 8 KB)
    const probe = slice.subarray(0, Math.min(bytesRead, 8192));
    if (probe.includes(0)) {
      return { binary: true, size: stat.size, truncated: false, text: '' };
    }
    return { binary: false, size: stat.size, truncated: stat.size > maxBytes, text: slice.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

async function readFilePreview({ cwd, relPath, mode = 'diff', maxBytes = DEFAULT_MAX_BYTES, exec = execFile } = {}) {
  if (!cwd) return { status: 400, error: 'Sessão sem pasta de projeto associada.' };
  let realCwd;
  try {
    realCwd = fs.realpathSync(cwd);
    if (!fs.statSync(realCwd).isDirectory()) return { status: 400, error: 'Pasta do projeto não existe.' };
  } catch {
    return { status: 404, error: 'Pasta do projeto não encontrada neste PC.' };
  }

  const rel = toSafeRelPath(relPath, realCwd);
  if (!rel) return { status: 400, error: 'Caminho de arquivo inválido ou fora da pasta do projeto.' };
  if (isSecretPath(rel)) return { status: 403, error: 'Arquivo sensível bloqueado por segurança.' };

  const target = resolveContainedPath(realCwd, rel);
  if (!target || !isWithinRoot(realCwd, target)) {
    return { status: 403, error: 'Caminho fora da pasta do projeto.' };
  }

  let exists = false;
  try {
    const realTarget = fs.realpathSync(target);
    if (!isWithinRoot(realCwd, realTarget)) {
      return { status: 403, error: 'Link simbólico aponta para fora da pasta do projeto.' };
    }
    exists = true;
  } catch {}

  const wantDiff = mode === 'diff';
  if (wantDiff) {
    let diff = await runGit(realCwd, ['diff', '--no-color', '--', rel], exec);
    if (!diff.trim()) diff = await runGit(realCwd, ['diff', '--cached', '--no-color', '--', rel], exec);
    if (diff.trim()) {
      const truncated = Buffer.byteLength(diff, 'utf8') > maxBytes;
      const clipped = truncated ? diff.slice(0, maxBytes) : diff;
      const red = redactSecrets(clipped);
      return {
        status: 200,
        body: { ok: true, path: rel, mode: 'diff', content: red.text, truncated, binary: false, redacted: red.count > 0 },
      };
    }
    if (!exists) {
      return { status: 404, error: 'Arquivo não encontrado e sem diff pendente.' };
    }
    // Sem diff (arquivo novo untracked ou já commitado): cai suavemente para o conteúdo do arquivo
  }

  if (!exists) return { status: 404, error: 'Arquivo não encontrado no disco.' };

  try {
    const res = readBoundedFile(target, maxBytes);
    if (res.error) return { status: res.status || 400, error: res.error };
    if (res.binary) {
      return {
        status: 200,
        body: { ok: true, path: rel, mode: 'content', content: '', binary: true, size: res.size, truncated: false, redacted: false },
      };
    }
    const red = redactSecrets(res.text);
    return {
      status: 200,
      body: {
        ok: true,
        path: rel,
        mode: 'content',
        fallback: wantDiff ? 'no-diff' : undefined,
        content: red.text,
        size: res.size,
        truncated: res.truncated,
        binary: false,
        redacted: red.count > 0,
      },
    };
  } catch {
    return { status: 500, error: 'Não foi possível ler o arquivo.' };
  }
}

module.exports = { readFilePreview, readGitBrief };
