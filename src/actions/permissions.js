// Permissões no modo remoto: ligado pelo HUD quando o usuário sai do PC, o hook-permission.js segura
// cada pedido de permissão do Claude até Permitir/Negar no HUD. Desligado, o hook sai na hora e o
// pedido aparece no PC. Os pedidos ficam no registro de pendências (pending.js).
const crypto = require('crypto');
const { normalizeQuestions } = require('../core/questions');

// store: createPendingStore(...)
function createPermissions({ store, remoteMode = false, onRemoteChange = () => {} }) {
  const pending = store.section('permissions'); // id -> { session, tool, summary, questions?, at, decision, answers?, text?, seen }
  let remote = !!remoteMode;

  return {
    get remoteMode() { return remote; },
    setRemote(on) {
      remote = !!on;
      // Desligou: pedidos em espera voltam para o PC na próxima consulta do hook
      if (!remote) for (const [id, p] of [...pending.entries()]) if (!p.decision) pending.set(id, { ...p, decision: 'release' });
      onRemoteChange(remote);
    },
    // Pedido aberto da sessão, para o cartão; descarta os de hooks que pararam de consultar
    pendingFor(key, now) {
      for (const [id, p] of [...pending.entries()]) {
        if (now - p.seen > 15e3) { pending.delete(id); continue; } // hook encerrou (respondido no PC, Esc, timeout)
        if (p.session === key && !p.decision) {
          const out = { id, tool: p.tool, summary: p.summary, at: p.at };
          if (p.questions && p.questions.length) out.questions = p.questions;
          return out;
        }
      }
      return null;
    },
    // Hook: novo pedido. Fora do modo remoto, não segura (null)
    open(session, tool, summary, extra) {
      if (!remote || !session) return null;
      const id = crypto.randomBytes(8).toString('hex');
      const questions = extra && extra.questions ? normalizeQuestions({ questions: extra.questions }) : [];
      const entry = { session, tool: String(tool || ''), summary: String(summary || ''), at: Date.now(), decision: null, seen: Date.now() };
      if (questions.length) entry.questions = questions;
      pending.set(id, entry);
      return id;
    },
    // Hook: consulta a decisão. { gone } se o pedido acabou ou voltou para o PC
    poll(id) {
      const p = pending.get(id);
      if (!p) return { gone: true };
      p.seen = Date.now();
      pending.touch();
      if (p.decision === 'release') { pending.delete(id); return { gone: true }; }
      if (p.decision) pending.delete(id);
      const out = { decision: p.decision };
      if (p.decision === 'answer') {
        if (p.answers) out.answers = p.answers;
        if (p.text) out.text = p.text;
      }
      return out;
    },
    expire(id) { pending.delete(id); },
    // HUD: Permitir/Negar ou responder AskUserQuestion. 'gone' se o pedido já foi respondido ou expirou
    decide(id, decision, payload) {
      const p = pending.get(id);
      if (!p || p.decision) return 'gone';
      if (decision === 'answer') {
        const answers = payload && payload.answers && typeof payload.answers === 'object' ? payload.answers : null;
        const text = payload && typeof payload.text === 'string' ? payload.text.trim().slice(0, 4000) : '';
        if (!answers && !text) return 'invalid';
        pending.set(id, { ...p, decision: 'answer', answers, text });
        return 'ok';
      }
      if (decision !== 'allow' && decision !== 'deny') return 'invalid';
      pending.set(id, { ...p, decision });
      return 'ok';
    },
  };
}

module.exports = { createPermissions };
