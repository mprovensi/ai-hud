// Gemini: junta sessões do Gemini CLI (~/.gemini/tmp) e do Antigravity (~/.gemini/antigravity).
// Todas chegam como tool='Gemini', distinguindo a origem em `where` ('gemini-cli', 'antigravity', 'antigravity-cli').
const path = require('path');
const os = require('os');
const { geminiCliSessions } = require('./cli');
const { antigravitySessions } = require('./antigravity');

const GEMINI_HOME = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');

function geminiSessions(root = GEMINI_HOME) {
  return [...geminiCliSessions(root), ...antigravitySessions(root)];
}

module.exports = { geminiSessions, geminiCliSessions, antigravitySessions };
