// Todas as fontes de sessão deste PC, no formato Session (core/session.js). Para incluir uma ferramenta nova,
// crie collect/sources/<ferramenta>.js devolvendo sessões nesse formato e some aqui.
const path = require('path');
const { claudeSessions } = require('./claude');
const { codexData } = require('./codex');
const { geminiSessions } = require('./gemini');
const { createOllamaSource } = require('./ollama');

function createSources({ dataDir, ollama = createOllamaSource({ dataDir }) }) {
  const statuslineFile = path.join(dataDir, 'last-statusline.json');
  return {
    start: () => ollama.start(),
    all: () => [...claudeSessions({ statuslineFile }), ...codexData().sessions, ...geminiSessions(), ...ollama.sessions()],
    ollamaReply: (session, text, url) => ollama.reply(session, text, url),
    ollamaCreate: (model, text, url) => ollama.createChat(model, text, url),
  };
}

module.exports = { createSources };
