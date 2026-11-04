// Responder a uma sessão pelo HUD. Cada ferramenta tem o seu caminho:
//   Claude  fila do HUD, entregue pelo hook-stop.js da sessão (substitui a anterior; "" cancela)
//   Codex   fila nativa (`codex queue`)
//   Ollama  continua a conversa pelo Ollama local; a resposta fica no HUD (não aparece no app)
// Resolve { status, body } (status HTTP já escolhido; body objeto = JSON, texto = mensagem).
const { codexQueue } = require('./codex-queue');

function createReplies({ queue, codexExe, exec, findSession, ollamaReply, ollamaUrl }) {
  return async function reply({ key, text, tool }) {
    if (!key || typeof key !== 'string') return { status: 400, body: 'sessão inválida' };
    text = String(text || '').trim().slice(0, 4000);
    if (tool === 'Ollama') {
      const s = findSession((x) => x.tool === 'Ollama' && x.id === key);
      if (!s || !text) return { status: 400, body: 'sessão inválida' };
      try { return { status: 200, body: await ollamaReply(s, text, ollamaUrl()) }; } catch (e) { return { status: 409, body: e.message }; }
    }
    if (tool === 'Codex') {
      if (!/^[0-9a-f-]{36}$/.test(key) || !text) return { status: 400, body: 'sessão inválida' };
      try { await codexQueue({ exe: codexExe, key, text, exec }); return { status: 200, body: { sent: true } }; } catch (e) { return { status: 502, body: e.message }; }
    }
    queue.set(key, text);
    return { status: 200, body: { queued: text || null, listening: queue.listenState(key, Date.now()) } };
  };
}

module.exports = { createReplies };
