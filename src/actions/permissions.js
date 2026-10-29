// Permissões no modo remoto: ligado pelo HUD quando o usuário sai do PC, o hook-permission.js segura
// cada pedido de permissão do Claude até Permitir/Negar no HUD. Desligado, o hook sai na hora e o
// pedido aparece no PC.
const crypto = require('crypto');

function createPermissions({ remoteMode = false, onRemoteChange = () => {} } = {}) {
  const pending = new Map(); // id -> { session, tool, summary, at, decision, seen }
  let remote = !!remoteMode;

  return {
    get remoteMode() { return remote; },
    setRemote(on) {
      remote = !!on;
      // Desligou: pedidos em espera voltam para o PC na próxima consulta do hook
      if (!remote) for (const p of pending.values()) if (!p.decision) p.decision = 'release';
      onRemoteChange(remote);
    },
    // Pedido aberto da sessão, para o cartão; descarta os de hooks que pararam de consultar
    pendingFor(key, now) {
      for (const [id, p] of pending) {
        if (now - p.seen > 15e3) { pending.delete(id); continue; } // hook encerrou (respondido no PC, Esc, timeout)
        if (p.session === key && !p.decision) return { id, tool: p.tool, summary: p.summary, at: p.at };
      }
      return null;
    },
    // Hook: novo pedido. Fora do modo remoto, não segura (null)
    open(session, tool, summary) {
      if (!remote || !session) return null;
      const id = crypto.randomBytes(8).toString('hex');
      pending.set(id, { session, tool: String(tool || ''), summary: String(summary || ''), at: Date.now(), decision: null, seen: Date.now() });
      return id;
    },
    // Hook: consulta a decisão. { gone } se o pedido acabou ou voltou para o PC
    poll(id) {
      const p = pending.get(id);
      if (!p) return { gone: true };
      p.seen = Date.now();
      if (p.decision === 'release') { pending.delete(id); return { gone: true }; }
      if (p.decision) pending.delete(id);
      return { decision: p.decision };
    },
    expire(id) { pending.delete(id); },
    // HUD: Permitir/Negar. 'gone' se o pedido já foi respondido ou expirou
    decide(id, decision) {
      const p = pending.get(id);
      if (!p || p.decision) return 'gone';
      if (decision !== 'allow' && decision !== 'deny') return 'invalid';
      p.decision = decision;
      return 'ok';
    },
  };
}

module.exports = { createPermissions };
