// Teste nativo manual: cria apenas abas próprias e encerra os processos de teste ao terminar.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawn, execFile } = require('child_process');

if (process.platform !== 'win32') { console.log('Teste exclusivo do Windows.'); process.exit(0); }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-wt-test-'));
const hold = path.join(directory, 'hold.js');
fs.writeFileSync(hold, "const fs=require('fs');const file=process.argv[2];const fd=fs.openSync(file,'a');fs.writeSync(fd,'test');fs.writeFileSync(file+'.pid',String(process.pid));setInterval(()=>{if(fs.existsSync(file+'.stop')){fs.closeSync(fd);process.exit(0)}},100);");
const suffix = path.basename(directory);
const files = ['a', 'b', 'c'].map((name) => path.join(directory, name + '.log'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let launchError;
const native = (args) => new Promise((resolve, reject) => execFile('powershell',
  ['-NoProfile', '-File', path.join(__dirname, '../terminal-focus.ps1'), ...args, '-Verbose'],
  { windowsHide: true, timeout: 15000 }, (error, out, stderr) => {
    try {
      const lines = out.trim().split(/\r?\n/);
      const result = JSON.parse(lines[lines.length - 1]);
      if (error) result.diagnostic = lines.slice(0, -1).join('\n') || stderr;
      resolve(result);
    } catch { reject(new Error((stderr || out || error.message).slice(0, 1500))); }
  }));
function launch(title, file) {
  const child = spawn(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe'),
    ['-w', suffix, 'new-tab', '--title', title, '--suppressApplicationTitle', process.execPath, hold, file],
    { windowsHide: true, stdio: 'ignore' });
  child.on('error', (error) => { launchError = error; });
  child.unref();
}
async function ready(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (fs.existsSync(file + '.pid')) { await sleep(200); return Number(fs.readFileSync(file + '.pid', 'utf8')); }
    await sleep(100);
  }
  throw new Error('Windows Terminal não iniciou o processo de teste.');
}
const select = (title) => native(['-Mode', 'Select', '-TitleHintsBase64', Buffer.from(JSON.stringify([title])).toString('base64')]);
(async () => {
  try {
    const a = 'HUD-A-' + suffix, b = 'HUD-B-' + suffix;
    launch(a, files[0]); await ready(files[0]);
    launch(b, files[1]); const bProcessId = await ready(files[1]);
    const owner = await native(['-Mode', 'Inspect', '-SessionFile', files[1], '-ExpectedProcess', 'node']);
    assert.equal(owner.clientPid, bProcessId);
    const first = await select(a); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.tab, a);
    const second = await select(b); assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(second.tab, b);
    launch(a, files[2]); await ready(files[2]);
    const duplicate = await select(a); assert.equal(duplicate.ok, false); assert.equal(duplicate.code, 'ambiguous');
    console.log('Windows Terminal: processo identificado, abas A/B selecionadas e títulos duplicados recusados.');
  } finally {
    for (const file of files) fs.writeFileSync(file + '.stop', 'stop');
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
