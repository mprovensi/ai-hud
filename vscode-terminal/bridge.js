const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

async function startBridge(vscode, options = {}) {
  const directory = options.directory || path.join(os.homedir(), '.ai-hud', 'terminal-bridges');
  fs.mkdirSync(directory, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  const file = path.join(directory, `${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  let disposed = false;
  const processId = (terminal) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 1000);
    Promise.resolve(terminal.processId).then((pid) => { clearTimeout(timer); resolve(pid); }, () => { clearTimeout(timer); resolve(undefined); });
  });
  const terminals = async () => (await Promise.all(vscode.window.terminals.map(async (terminal) => ({ terminal, pid: await processId(terminal) }))))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && !item.terminal.exitStatus);
  const server = http.createServer((req, res) => {
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); return res.end(); }
    if (req.method !== 'POST' || req.url !== '/focus') { res.writeHead(404); return res.end(); }
    let body = '', size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= 2048) body += chunk; });
    req.on('error', () => {});
    req.on('end', async () => {
      try {
        if (size > 2048) { res.writeHead(413); return res.end(); }
        let input;
        try { input = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
        if (!input || !Number.isInteger(input.pid) || input.pid <= 0) { res.writeHead(400); return res.end(); }
        const matches = (await terminals()).filter((item) => item.pid === input.pid);
        if (matches.length !== 1) { res.writeHead(matches.length ? 409 : 404); return res.end(); }
        matches[0].terminal.show(false);
        for (let attempt = 0; attempt < 40 && vscode.window.activeTerminal !== matches[0].terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
        if (vscode.window.activeTerminal !== matches[0].terminal) { res.writeHead(409); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, selectedPid: matches[0].pid }));
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let publishing = Promise.resolve();
  const publish = () => {
    publishing = publishing.then(async () => {
      const items = await terminals();
      if (disposed) return;
      const data = { protocol: 1, port: server.address().port, token, at: Date.now(), workspaceName: vscode.workspace.name || '',
        folders: (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
        terminals: items.map((item) => ({ pid: item.pid, name: item.terminal.name })) };
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, file);
    }).catch(() => {});
    return publishing;
  };
  const subscriptions = [vscode.window.onDidOpenTerminal(publish), vscode.window.onDidCloseTerminal(publish)];
  const timer = setInterval(publish, 5000);
  timer.unref();
  await publish();
  return { port: server.address().port, token, file,
    async dispose() {
      disposed = true;
      clearInterval(timer);
      for (const subscription of subscriptions) subscription.dispose();
      await publishing;
      try { fs.unlinkSync(file); } catch {}
      await new Promise((resolve) => server.close(resolve));
    } };
}

module.exports = { startBridge };
