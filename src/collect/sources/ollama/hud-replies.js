// Continuações de conversas do Ollama feitas pelo HUD. A API interna do app exige um token que só existe
// na memória dele, então responder pelo HUD não passa pelo app: o servidor monta o histórico da conversa
// + a mensagem nova, gera no Ollama (:11434) e guarda essa continuação em data/ollama-replies.json.
// Ela aparece no HUD, não no app.
const http = require('http');
const { generationMetrics } = require('../../../core/ollama-metrics');
const { readJson, writeJson } = require('../../../infra/store');

function createOllamaReplies({ file, request = http.request }) {
  let cont = readJson(file, {}); // chatId -> { messages: [{ role, content, at, model, tokens }], generating }
  if (typeof cont !== 'object' || Array.isArray(cont)) cont = {};
  const save = () => writeJson(file, cont);

  // Uma geração pertence ao processo anterior e não pode continuar após um reinício.
  let recovered = false;
  for (const entry of Object.values(cont)) {
    if (!entry || !entry.generating) continue;
    entry.generating = false;
    if (!Array.isArray(entry.messages)) entry.messages = [];
    entry.messages.push({ role: 'assistant', content: '⚠ Geração interrompida pelo reinício do HUD. Envie uma nova mensagem para continuar.', at: Date.now() });
    recovered = true;
  }
  if (recovered) save();

  const extra = (chatId) => (cont[chatId] && cont[chatId].messages) || [];
  const generating = (chatId) => !!(cont[chatId] && cont[chatId].generating);

  // Responder: histórico da conversa + mensagem nova → Ollama /api/chat; guarda a continuação
  function reply(session, text, ollamaUrl) {
    const chatId = session.chatId;
    const model = [...session.models][0];
    if (!model) return Promise.reject(new Error('não sei qual modelo esta conversa usa'));
    const entry = cont[chatId] = cont[chatId] || { messages: [] };
    if (entry.generating) return Promise.reject(new Error('ainda gerando a resposta anterior'));
    const messages = session.history.filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: text }]);
    entry.messages.push({ role: 'user', content: text, at: Date.now() });
    entry.generating = true;
    save();
    const body = JSON.stringify({ model, messages, stream: false });
    const req = request(new URL('/api/chat', ollamaUrl), { method: 'POST', timeout: 10 * 60e3,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'ai-hud' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        const content = (j.message && j.message.content) || (j.error ? `⚠ ${j.error}` : '⚠ resposta vazia');
        entry.messages.push({ role: 'assistant', content, at: Date.now(), model,
          tokens: (j.prompt_eval_count || 0) + (j.eval_count || 0), metrics: generationMetrics(j) });
        entry.generating = false;
        save();
      });
    });
    const fail = (e) => { entry.messages.push({ role: 'assistant', content: `⚠ ${e.message}`, at: Date.now(), model }); entry.generating = false; save(); };
    req.on('timeout', () => req.destroy(new Error('o Ollama demorou demais')));
    req.on('error', fail);
    req.end(body);
    return Promise.resolve({ sent: true });
  }

  return { extra, generating, reply };
}

module.exports = { createOllamaReplies };
