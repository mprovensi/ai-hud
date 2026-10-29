// O app.js que os aparelhos recebem: os pedaços de public/js/ juntados pelo servidor
const path = require('node:path');
const { bundleScripts } = require('../../src/web-assets');

module.exports = bundleScripts(path.join(__dirname, '../../public'));
