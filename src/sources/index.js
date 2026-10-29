// Todas as fontes de sessão deste PC, no formato comum (common.js). Para incluir uma ferramenta nova,
// crie sources/<ferramenta>.js devolvendo sessões nesse formato e some aqui.
const path = require('path');
const { claudeSessions } = require('./claude');
const { codexData } = require('./codex');
const { antigravitySessions } = require('./antigravity');
const { createOllamaSource } = require('./ollama');

function createSources({ dataDir, ollama = createOllamaSource({ dataDir }) }) {
  const statuslineFile = path.join(dataDir, 'last-statusline.json');
  return {
    start: () => ollama.start(),
    all: () => [...claudeSessions({ statuslineFile }), ...codexData().sessions, ...antigravitySessions(), ...ollama.sessions()],
    ollamaReply: (session, text, url) => ollama.reply(session, text, url),
  };
}

module.exports = { createSources };
