// Arquivos JSON em data/: leitura tolerante (arquivo ausente ou corrompido = valor padrão) e gravação
// por arquivo temporário + rename, para um desligamento no meio da escrita não deixar o JSON pela metade.
const fs = require('fs');

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value == null ? fallback : value;
  } catch { return fallback; }
}

function writeJson(file, value, pretty = false) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

module.exports = { readJson, writeJson };
