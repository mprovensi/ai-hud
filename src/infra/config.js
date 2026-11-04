// data/config.json: token de acesso, PIN e opções (peers, ollama, name, remoteMode).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');

// Instalações antigas guardavam os arquivos de dados na raiz: move-os uma vez para data/
const LEGACY = ['config.json', 'quota-history.json', 'replies.json', 'last-statusline.json', 'ollama-replies.json'];
function migrateLegacy(root, dataDir) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  for (const name of LEGACY) {
    try { fs.renameSync(path.join(root, name), path.join(dataDir, name)); } catch {}
  }
}

function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  const config = readJson(file, {});
  const save = () => writeJson(file, config, true);
  // O HUD envia respostas às sessões (executam comandos no PC): PIN de 8 dígitos e token gerados na primeira execução
  if (!config.token || !config.pin || config.pin.length < 8) {
    config.token = config.token || crypto.randomBytes(12).toString('hex');
    config.pin = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
    save();
  }
  return { config, save };
}

module.exports = { loadConfig, migrateLegacy };
