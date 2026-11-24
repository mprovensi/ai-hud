// Commit rápido de alterações do projeto (0 tokens, sem shell, respeita .git/info/exclude).
const fs = require('fs');
const { execFile } = require('child_process');
const { normalizePath } = require('../core/path-guard');

function runGit(cwd, args, exec = execFile, timeout = 30000) {
  return new Promise((resolve) => {
    try {
      exec('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout = '', stderr = '') => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          err,
        });
      });
    } catch (e) {
      resolve({ ok: false, code: 1, stdout: '', stderr: e.message || String(e), err: e });
    }
  });
}

async function commitProjectGit({ cwd, message, push = false } = {}, exec = execFile) {
  const dir = normalizePath(cwd);
  if (!dir || !fs.existsSync(dir)) {
    return { status: 404, body: 'Pasta do projeto não encontrada.' };
  }
  const msg = String(message || '').replace(/\r\n/g, '\n').trim().slice(0, 500);
  if (!msg) {
    return { status: 400, body: 'Informe uma mensagem de commit.' };
  }

  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], exec, 6000);
  if (!inside.ok || inside.stdout !== 'true') {
    return { status: 400, body: 'Esta pasta não é um repositório Git.' };
  }

  const branchRes = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], exec, 6000);
  const branch = branchRes.ok ? branchRes.stdout : '';

  const statusRes = await runGit(dir, ['status', '--porcelain'], exec, 8000);
  if (!statusRes.ok) {
    return { status: 500, body: statusRes.stderr || 'Falha ao ler git status.' };
  }
  if (!statusRes.stdout) {
    return { status: 200, body: { ok: true, committed: false, nothingToCommit: true, branch, hash: '' } };
  }

  const addRes = await runGit(dir, ['add', '-A'], exec, 15000);
  if (!addRes.ok) {
    return { status: 500, body: addRes.stderr || 'Falha ao executar git add.' };
  }

  const commitRes = await runGit(dir, ['commit', '-m', msg], exec, 25000);
  if (!commitRes.ok) {
    const detail = commitRes.stderr || commitRes.stdout || 'Falha ao executar git commit.';
    if (/nothing to commit/i.test(detail)) {
      return { status: 200, body: { ok: true, committed: false, nothingToCommit: true, branch, hash: '' } };
    }
    return { status: 400, body: detail };
  }

  const hashRes = await runGit(dir, ['rev-parse', '--short', 'HEAD'], exec, 6000);
  const hash = hashRes.ok ? hashRes.stdout : '';

  let pushed = false;
  let pushError = '';
  if (push) {
    const pushRes = await runGit(dir, ['push'], exec, 45000);
    if (pushRes.ok) {
      pushed = true;
    } else {
      pushError = pushRes.stderr || pushRes.stdout || 'Falha ao executar git push.';
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      committed: true,
      nothingToCommit: false,
      branch,
      hash,
      message: msg,
      pushed,
      ...(pushError ? { pushError } : {}),
    },
  };
}

module.exports = { commitProjectGit };
