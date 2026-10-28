const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startBridge } = require('../vscode-terminal/bridge');

test('VS Code bridge selects the exact PID with duplicate tab names and rejects unauthorized requests', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-vscode-'));
  const selected = [];
  const terminals = [101, 202].map((pid) => ({ processId: Promise.resolve(pid), name: 'pwsh',
    show(preserve) { assert.equal(preserve, false); selected.push(pid); vscode.window.activeTerminal = this; }, sendText: () => assert.fail('must never type into the terminal') }));
  const disposable = () => ({ dispose() {} });
  const vscode = { window: { terminals, onDidOpenTerminal: disposable, onDidCloseTerminal: disposable }, workspace: { workspaceFolders: [] } };
  const bridge = await startBridge(vscode, { directory });
  t.after(async () => { await bridge.dispose(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (body, token = bridge.token) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: bridge.port, path: '/focus', method: 'POST', agent: false,
      headers: { Authorization: 'Bearer ' + token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(await request('{"pid":202}', 'wrong'), 401);
  assert.equal(await request('null'), 400);
  assert.equal(await request('{"pid":999}'), 404);
  assert.equal(await request('{"pid":202}'), 200);
  assert.deepEqual(selected, [202]);
  terminals[1].exitStatus = { code: 0 };
  assert.equal(await request('{"pid":202}'), 404);
  assert.deepEqual(selected, [202]);
  const record = JSON.parse(fs.readFileSync(bridge.file, 'utf8'));
  assert.deepEqual(record.terminals.map((item) => item.pid), [101, 202]);
});
