// Respostas rápidas: o HUD enfileira uma resposta por sessão; o hook-stop.js de cada sessão parada busca
// a cada 2 s. A chave é o id que o próprio CLI passa ao hook: Claude = nome do .jsonl, Codex = uuid no
// fim do rollout. A fila fica em disco: um reinício do servidor não perde respostas ainda não entregues.
const { readJson, writeJson } = require('../store');

const replyKey = (s) => (s.tool === 'Codex' ? s.id.slice(-36) : s.id);

function createReplyQueue(file) {
  const queue = new Map(Object.entries(readJson(file, {}))); // chave -> { text, at }
  const listening = new Map(); // chave -> { tool, until, seen }
  const save = () => writeJson(file, Object.fromEntries(queue));

  // Até quando o hook da sessão espera respostas; null se não está esperando
  function listenState(key, now) {
    const l = listening.get(key);
    // Hook encerrado sem avisar (Esc, sessão fechada): some se parar de consultar
    if (!l || l.until < now || now - l.seen > 15e3) { listening.delete(key); return null; }
    return l.until;
  }

  return {
    listenState,
    queued: (key) => { const q = queue.get(key); return q ? q.text : null; },
    // "" cancela a resposta enfileirada
    set(key, text) {
      if (text) queue.set(key, { text, at: Date.now() }); else queue.delete(key);
      save();
    },
    listen(key, tool, until) { listening.set(key, { tool, until: Number(until) || Date.now() + 30 * 60e3, seen: Date.now() }); },
    unlisten(key) { listening.delete(key); },
    // Consulta do hook: marca que ainda está vivo e entrega a resposta, se houver
    take(key) {
      const l = listening.get(key);
      if (l) l.seen = Date.now();
      const q = queue.get(key);
      if (!q) return null;
      queue.delete(key);
      save();
      listening.delete(key);
      return q.text;
    },
  };
}

module.exports = { createReplyQueue, replyKey };
