const vscode = require('vscode');
const { startBridge } = require('./bridge');

async function activate(context) {
  const bridge = await startBridge(vscode);
  context.subscriptions.push({ dispose: () => bridge.dispose() });
}

module.exports = { activate };
