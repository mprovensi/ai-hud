// Respostas rápidas para o Claude Code: o HUD enfileira uma resposta por sessão e o hook-stop.js da
// sessão parada busca a cada 2 s. A chave é o id que o próprio CLI passa ao hook: Claude = nome do
// .jsonl, Codex = uuid no fim do rollout. Fila e escutas ficam no registro de pendências (pending.js).

const replyKey = (s) => (s.tool === 'Codex' ? s.id.slice(-36) : s.id);

// store: createPendingStore(...)
function createReplyQueue(store) {
  const queue = store.section('replies');       // chave -> { text, at }
  const listening = store.section('listening'); // chave -> { tool, until, seen }

  // Até quando o hook da sessão espera respostas; null se não está esperando
  function listenState(key, now) {
    const l = listening.get(key);
    if (!l) return null;
    // Hook encerrado sem avisar (Esc, sessão fechada): some se parar de consultar
    if (l.until < now || now - l.seen > 15e3) { listening.delete(key); return null; }
    return l.until;
  }

  return {
    listenState,
    queued: (key) => { const q = queue.get(key); return q ? q.text : null; },
    // "" cancela a resposta enfileirada
    set(key, text) {
      if (text) queue.set(key, { text, at: Date.now() }); else queue.delete(key);
    },
    listen(key, tool, until) { listening.set(key, { tool, until: Number(until) || Date.now() + 30 * 60e3, seen: Date.now() }); },
    unlisten(key) { listening.delete(key); },
    // Consulta do hook: marca que ainda está vivo e entrega a resposta, se houver
    take(key) {
      const l = listening.get(key);
      if (l) { l.seen = Date.now(); listening.touch(); }
      const q = queue.get(key);
      if (!q) return null;
      queue.delete(key);
      listening.delete(key);
      return q.text;
    },
  };
}

module.exports = { createReplyQueue, replyKey };
