// Persistência das sessões compartilhadas entre IAs em `<cwd>/.ai-workspace/sessions/<id>.json`
// e publicação de fatos na memória compartilhada do projeto. Usado pelo MCP `ai-hud-memory`
// (qualquer IA) e pelo handoff do HUD. Concorrência: lock exclusivo por arquivo + revisão otimista.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PUBLISH_KINDS,
  isValidSessionId,
  newSessionId,
  createSessionRecord,
  applySessionUpdate,
  applyHandoff,
  applyLink,
  sessionBrief,
  buildSessionPackage,
  formatPublishLine,
} = require('../core/shared-session');
const { projectSlug } = require('../core/memory');
const { writeAtomic } = require('../infra/workspace-paths');
const { resolveProjectMemoryDir } = require('../collect/memory');

const LOCK_STALE_MS = 10e3;
const LOCK_WAIT_MS = 2e3;
const PUBLISH_FILES = { decision: ['decisions.md', '# Decisões'], pitfall: ['pitfalls.md', '# Armadilhas'] };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Executa fn com lock exclusivo (arquivo `.lock` criado com 'wx'); locks órfãos expiram.
function withFileLock(filePath, fn) {
  const lock = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { continue; }
      if (Date.now() > deadline) return { error: 'Sessão ocupada por outra IA (lock). Tente novamente.', code: 'locked' };
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

function createSharedSessions({ workspaceRoot, now = () => Date.now(), randomHex = () => crypto.randomBytes(4).toString('hex') } = {}) {
  function resolveCwd(cwd) {
    const raw = String(cwd || '').trim().replace(/^\\\\\?\\/, '');
    if (!raw) return { error: 'Informe o caminho da pasta do projeto (cwd).' };
    const abs = path.resolve(raw);
    try { if (!fs.statSync(abs).isDirectory()) throw new Error(); } catch { return { error: `Pasta do projeto não encontrada: ${abs}` }; }
    return { root: abs, dir: path.join(abs, '.ai-workspace', 'sessions') };
  }

  function fileOf(dir, id) {
    return path.join(dir, `${id}.json`);
  }

  function readFile(file) {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      return r && typeof r === 'object' && isValidSessionId(r.id) ? r : null;
    } catch { return null; }
  }

  function write(file, record) {
    writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  }

  // Lê-modifica-grava sob lock, recusando escrita se expectedRev não bater (outra IA escreveu antes).
  function mutate({ cwd, id, expectedRev }, change) {
    const r = resolveCwd(cwd);
    if (r.error) return r;
    if (!isValidSessionId(id)) return { error: 'Id de sessão inválido.' };
    const file = fileOf(r.dir, id);
    return withFileLock(file, () => {
      const cur = readFile(file);
      if (!cur) return { error: `Sessão não encontrada: ${id}` };
      if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== cur.rev) {
        return { error: `Conflito: a sessão está na rev ${cur.rev} (esperada ${expectedRev}). Releia com session_read e reaplique.`, code: 'conflict', rev: cur.rev };
      }
      const out = change(cur);
      if (out.error) return out;
      write(file, out.record);
      return { ok: true, session: out.record };
    });
  }

  function create({ cwd, goal = '', tool = '', model = '', nativeSessionId = '' } = {}) {
    const r = resolveCwd(cwd);
    if (r.error) return r;
    if (!String(tool || '').trim()) return { error: 'Informe a IA que cria a sessão (tool).' };
    const ts = now();
    let id = newSessionId(ts, randomHex());
    for (let n = 2; fs.existsSync(fileOf(r.dir, id)); n++) id = `${newSessionId(ts, randomHex())}-${n}`;
    const record = createSessionRecord({ id, cwd: r.root, project: projectSlug(r.root), goal, tool, model, nativeSessionId, now: ts });
    fs.mkdirSync(r.dir, { recursive: true });
    write(fileOf(r.dir, id), record);
    return { ok: true, session: record };
  }

  function read({ cwd, id } = {}) {
    const r = resolveCwd(cwd);
    if (r.error) return r;
    if (!isValidSessionId(id)) return { error: 'Id de sessão inválido.' };
    const record = readFile(fileOf(r.dir, id));
    if (!record) return { error: `Sessão não encontrada: ${id}` };
    return { ok: true, session: record, package: buildSessionPackage(record) };
  }

  function listRecords(dir) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch {}
    return names.map((n) => readFile(path.join(dir, n))).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function list({ cwd, status = '' } = {}) {
    const r = resolveCwd(cwd);
    if (r.error) return r;
    const all = listRecords(r.dir).filter((s) => !status || s.status === status);
    return { ok: true, cwd: r.root, total: all.length, sessions: all.slice(0, 50).map(sessionBrief) };
  }

  function findByNative({ cwd, nativeSessionId }) {
    const r = resolveCwd(cwd);
    if (r.error || !nativeSessionId) return null;
    return listRecords(r.dir).find((s) => (s.natives || []).includes(nativeSessionId)) || null;
  }

  const update = (args = {}) => mutate(args, (cur) => applySessionUpdate(cur, args, now()));

  function handoff(args = {}) {
    const out = mutate(args, (cur) => applyHandoff(cur, args, now()));
    return out.error ? out : { ...out, package: buildSessionPackage(out.session) };
  }

  function link({ cwd, id, otherId, note = '', tool = '' } = {}) {
    const other = read({ cwd, id: otherId });
    if (other.error) return other;
    const out = mutate({ cwd, id }, (cur) => applyLink(cur, { otherId, note, tool }, now()));
    if (out.error) return out;
    mutate({ cwd, id: otherId }, (cur) => applyLink(cur, { otherId: id, note, tool }, now()));
    return { ...out, linkedPackage: other.package };
  }

  function publish({ cwd, id = '', kind, text, tool = '' } = {}) {
    const r = resolveCwd(cwd);
    if (r.error) return r;
    if (!PUBLISH_KINDS.includes(kind)) return { error: `kind deve ser um de: ${PUBLISH_KINDS.join(', ')} (pinned.md é editado só pelo usuário).` };
    if (!String(text || '').trim()) return { error: 'Informe o texto a publicar.' };
    if (id && !isValidSessionId(id)) return { error: 'Id de sessão inválido.' };
    const mem = resolveProjectMemoryDir({ workspaceRoot, cwd: r.root });
    const ts = now();
    const line = formatPublishLine({ text, tool, sessionId: id, now: ts });
    let target;
    let header;
    if (kind === 'episodic') {
      target = path.join(mem.dir, 'sessions', `${new Date(ts).toISOString().slice(0, 10)}-${id || 'manual'}.md`);
      header = `# Notas da sessão ${id || 'manual'}`;
    } else {
      target = path.join(mem.dir, PUBLISH_FILES[kind][0]);
      header = PUBLISH_FILES[kind][1];
    }
    const out = withFileLock(target, () => {
      let prev = '';
      try { prev = fs.readFileSync(target, 'utf8').trimEnd(); } catch {}
      writeAtomic(target, `${prev || header}\n${line}\n`);
      return { ok: true };
    });
    if (out.error) return out;
    if (id) update({ cwd: r.root, id, tool, note: `publicou ${kind} na memória` });
    return { ok: true, kind, file: target, memoryMode: mem.mode, project: mem.slug, line };
  }

  return { create, read, list, update, handoff, link, publish, findByNative };
}

module.exports = { createSharedSessions };
