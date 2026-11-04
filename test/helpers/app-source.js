// O app.js que os aparelhos recebem: os pedaços de web/js/ juntados pelo servidor
const path = require('node:path');
const { bundleScripts } = require('../../src/infra/web-bundle');

module.exports = bundleScripts(path.join(__dirname, '../../web'));
