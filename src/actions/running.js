// Registro em memória dos processos headless iniciados pelo próprio HUD (via + Nova ou Responder).
// Evita disparos concorrentes na mesma sessão, permite encerrar o processo pelo HUD e guarda
// erros recentes de execução para exibir na gaveta em vez de um 404 genérico.
const ERROR_TTL_MS = 60e3;

function createRunning() {
  const active = new Map(); // key -> { pid, child, startedAt }
  const errors = new Map(); // key -> { message, at }

  const norm = (id) => String(id || '').trim();
  const findKey = (id) => {
    const k = norm(id);
    if (!k) return null;
    if (active.has(k)) return k;
    const tail = k.length > 36 ? k.slice(-36) : '';
    if (tail && active.has(tail)) return tail;
    return null;
  };

  function isBusy(id) {
    return !!findKey(id);
  }

  function track(key, child) {
    const k = norm(key);
    if (!k || !child) return;
    errors.delete(k);
    const entry = { pid: Number.isInteger(child.pid) ? child.pid : null, child, startedAt: Date.now() };
    active.set(k, entry);
    const cleanup = () => {
      for (const [ek, ev] of active.entries()) {
        if (ev === entry) active.delete(ek);
      }
    };
    child.once('exit', cleanup);
    child.once('error', cleanup);
  }

  function rekey(oldKey, newKey) {
    const ok = norm(oldKey), nk = norm(newKey);
    if (!ok || !nk || ok === nk) return;
    const entry = active.get(ok);
    if (entry) { active.delete(ok); active.set(nk, entry); }
    const err = errors.get(ok);
    if (err) { errors.delete(ok); errors.set(nk, err); }
  }

  function recordError(key, message) {
    const k = norm(key);
    const msg = String(message || '').trim();
    if (!k || !msg) return;
    const now = Date.now();
    for (const [ek, ev] of errors.entries()) if (now - ev.at > ERROR_TTL_MS) errors.delete(ek);
    errors.set(k, { message: msg, at: now });
  }

  function lastError(id) {
    const k = norm(id);
    const now = Date.now();
    for (const cand of [k, k.length > 36 ? k.slice(-36) : '']) {
      if (!cand) continue;
      const e = errors.get(cand);
      if (e && now - e.at <= ERROR_TTL_MS) return e.message;
    }
    return null;
  }

  function getPid(id) {
    const k = findKey(id);
    return k ? active.get(k).pid : null;
  }

  function drop(id) {
    const k = findKey(id);
    if (k) active.delete(k);
  }

  return { isBusy, track, rekey, recordError, lastError, getPid, drop };
}

module.exports = { createRunning };
