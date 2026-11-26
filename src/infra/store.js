// Arquivos JSON em data/: leitura tolerante (arquivo ausente ou corrompido = valor padrão) e gravação
// por arquivo temporário + rename, para um desligamento no meio da escrita não deixar o JSON pela metade.
const fs = require('fs');

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value == null ? fallback : value;
  } catch { return fallback; }
}

function writeJsonStrict(file, value, pretty = false) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp) && fs.lstatSync(tmp).isFile()) fs.unlinkSync(tmp); } catch {}
    const out = new Error(`Falha ao gravar ${file}: ${err && err.message ? err.message : err}`);
    out.status = 500;
    out.code = (err && err.code) || 'EWRITEJSON';
    throw out;
  }
}

function writeJson(file, value, pretty = false) {
  try {
    writeJsonStrict(file, value, pretty);
    return true;
  } catch { return false; }
}

module.exports = { readJson, writeJson, writeJsonStrict };
