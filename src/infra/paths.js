// Pastas do projeto. Dados gerados em execução (token, filas, históricos) ficam em data/, fora do git.
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = { ROOT, DATA: path.join(ROOT, 'data'), WEB: path.join(ROOT, 'web') };
