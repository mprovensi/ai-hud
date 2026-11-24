// Sincronização Git segura do AI Workspace (<workspaceRoot>) com um repositório remoto / VPS 24/7.
// Camada actions/: usa apenas child_process.execFile('git', ...) sem shell.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const DEFAULT_GITIGNORE = '.ai-workspace/\n*.tmp\n.DS_Store\nThumbs.db\n';

function defaultExecGit(cwd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.message) || ''),
      });
    });
  });
}

function parsePorcelain(raw) {
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  const conflicts = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      const bm = /^([^\s.]+)/.exec(head);
      if (bm && bm[1] !== 'No') branch = bm[1];
      const am = /ahead (\d+)/.exec(head);
      const dm = /behind (\d+)/.exec(head);
      if (am) ahead = Number(am[1]) || 0;
      if (dm) behind = Number(dm[1]) || 0;
      continue;
    }
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (CONFLICT_CODES.has(xy)) conflicts.push(file);
    dirty += 1;
  }
  return { branch, ahead, behind, dirty, conflicts };
}

function createWorkspaceSync({ dataDir, config, execGit = defaultExecGit, now = () => Date.now(), log = () => {} }) {
  let inFlight = false;
  let lastSyncAt = 0;
  let lastError = '';
  let timer = null;

  const root = () => resolveWorkspaceRoot(dataDir, config);

  async function status() {
    const dir = root();
    const isRepo = fs.existsSync(path.join(dir, '.git'));
    if (!isRepo) {
      return {
        ok: true,
        isRepo: false,
        branch: '',
        remote: '',
        ahead: 0,
        behind: 0,
        dirty: 0,
        conflicts: [],
        syncing: inFlight,
        lastSyncAt,
        lastError,
      };
    }
    const [st, rem] = await Promise.all([
      execGit(dir, ['status', '--porcelain=v1', '-b'], 8000),
      execGit(dir, ['remote', 'get-url', 'origin'], 5000),
    ]);
    const parsed = st.ok ? parsePorcelain(st.stdout) : { branch: '', ahead: 0, behind: 0, dirty: 0, conflicts: [] };
    return {
      ok: true,
      isRepo: true,
      branch: parsed.branch || 'main',
      remote: rem.ok ? rem.stdout.trim() : '',
      ahead: parsed.ahead,
      behind: parsed.behind,
      dirty: parsed.dirty,
      conflicts: parsed.conflicts,
      syncing: inFlight,
      lastSyncAt,
      lastError: st.ok ? lastError : (st.stderr.trim() || lastError),
    };
  }

  function ensureGitignore(dir) {
    const file = path.join(dir, '.gitignore');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, DEFAULT_GITIGNORE, 'utf8');
      return;
    }
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.includes('.ai-workspace')) {
      fs.writeFileSync(file, `${cur.trimEnd()}\n.ai-workspace/\n`, 'utf8');
    }
  }

  async function sync({ init = false, remote = '', message = '' } = {}) {
    if (inFlight) return { status: 409, body: 'Sincronização já em andamento.' };
    inFlight = true;
    try {
      const dir = root();
      fs.mkdirSync(dir, { recursive: true });
      ensureGitignore(dir);

      let isRepo = fs.existsSync(path.join(dir, '.git'));
      if (!isRepo) {
        if (!init) {
          return {
            status: 400,
            body: 'O AI Workspace ainda não é um repositório Git. Inicialize-o com { "init": true } ou configure o remoto.',
          };
        }
        const initRes = await execGit(dir, ['init', '-b', 'main'], 10000);
        if (!initRes.ok) {
          const fb = await execGit(dir, ['init'], 10000);
          if (!fb.ok) {
            lastError = fb.stderr.trim() || 'Falha ao inicializar Git.';
            return { status: 500, body: lastError };
          }
        }
        isRepo = true;
      }

      const cleanRemote = String(remote || '').trim();
      if (cleanRemote) {
        const curRem = await execGit(dir, ['remote', 'get-url', 'origin'], 5000);
        if (curRem.ok) {
          if (curRem.stdout.trim() !== cleanRemote) {
            await execGit(dir, ['remote', 'set-url', 'origin', cleanRemote], 5000);
          }
        } else {
          await execGit(dir, ['remote', 'add', 'origin', cleanRemote], 5000);
        }
      }

      const pre = await status();
      if (pre.conflicts.length) {
        lastError = `Conflitos pendentes: ${pre.conflicts.join(', ')}`;
        return { status: 409, body: { ok: false, error: lastError, conflicts: pre.conflicts, status: pre } };
      }

      let committed = false;
      if (pre.dirty > 0) {
        await execGit(dir, ['add', '-A'], 10000);
        const stamp = new Date(now()).toISOString().slice(0, 16).replace('T', ' ');
        const msg = String(message || `sync(workspace): ${stamp}`).slice(0, 140);
        const ci = await execGit(dir, ['commit', '-m', msg], 15000);
        committed = ci.ok;
      }

      const remRes = await execGit(dir, ['remote', 'get-url', 'origin'], 5000);
      const hasRemote = remRes.ok && !!remRes.stdout.trim();
      let pulled = false;
      let pushed = false;

      if (hasRemote) {
        const branch = pre.branch || 'main';
        const fe = await execGit(dir, ['fetch', 'origin'], 20000);
        if (!fe.ok) {
          lastError = fe.stderr.trim() || 'Falha no git fetch origin.';
          return { status: 502, body: { ok: false, error: lastError, status: await status() } };
        }
        // Faz pull --rebase apenas se o branch remoto já existir
        const refCheck = await execGit(dir, ['rev-parse', '--verify', `origin/${branch}`], 5000);
        if (refCheck.ok) {
          const pull = await execGit(dir, ['pull', '--rebase', '--autostash', 'origin', branch], 25000);
          if (!pull.ok) {
            await execGit(dir, ['rebase', '--abort'], 8000);
            lastError = 'Conflito ao sincronizar com o remoto (rebase abortado sem perder alterações locais).';
            return { status: 409, body: { ok: false, error: lastError, details: pull.stderr.trim().slice(0, 400), status: await status() } };
          }
          pulled = true;
        }
        // Só faz push se existir pelo menos um commit no HEAD
        const headOk = await execGit(dir, ['rev-parse', '--verify', 'HEAD'], 5000);
        if (headOk.ok) {
          const push = await execGit(dir, ['push', '-u', 'origin', branch], 25000);
          if (!push.ok) {
            lastError = push.stderr.trim() || 'Falha no git push origin.';
            return { status: 502, body: { ok: false, error: lastError, status: await status() } };
          }
          pushed = true;
        }
      }

      lastSyncAt = now();
      lastError = '';
      const after = await status();
      return { status: 200, body: { ok: true, committed, pulled, pushed, status: after } };
    } finally {
      inFlight = false;
    }
  }

  function startAutoSync() {
    const ms = typeof config.workspaceAutoSyncMs === 'number' ? config.workspaceAutoSyncMs : 5 * 60 * 1000;
    if (ms <= 0 || timer) return;
    timer = setInterval(async () => {
      try {
        const st = await status();
        if (!st.isRepo || !st.remote || st.conflicts.length) return;
        const r = await sync();
        if (r.status !== 200) log(`workspace sync: ${typeof r.body === 'string' ? r.body : r.body.error}`);
      } catch {}
    }, ms);
    if (timer.unref) timer.unref();
  }

  function stopAutoSync() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { status, sync, startAutoSync, stopAutoSync };
}

module.exports = { createWorkspaceSync, parsePorcelain };
