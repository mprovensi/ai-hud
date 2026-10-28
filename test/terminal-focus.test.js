const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTerminalFocus, selectBridge, titleHints } = require('../src/terminal-focus');

const record = (overrides = {}) => ({ at: 10000, port: 12345, token: 'a'.repeat(48), terminals: [{ pid: 20, name: 'mesmo nome' }], folders: ['C:\\project'], ...overrides });

test('VS Code binding uses shell ancestry rather than terminal names', () => {
  const first = record(), second = record({ terminals: [{ pid: 30, name: 'mesmo nome' }] });
  const match = selectBridge([first, second], [{ pid: 99 }, { pid: 30 }], 10000);
  assert.equal(match.record, second);
  assert.equal(match.pid, 30);
});

test('stale, invalid and ambiguous bindings are rejected', () => {
  assert.equal(selectBridge([record({ at: 0 })], [{ pid: 20 }], 20000), null);
  assert.equal(selectBridge([record({ token: 'invalid' })], [{ pid: 20 }], 10000), null);
  assert.equal(selectBridge([record({ port: 0 })], [{ pid: 20 }], 10000), null);
  assert.equal(selectBridge([record(), record()], [{ pid: 20 }], 10000), null);
});

test('terminal hints preserve exact console identity and remove duplicates', () => {
  assert.deepEqual(titleHints({ title: 'Projeto', cwd: 'C:\\work\\Projeto', models: new Set(['modelo']) }, { consoleTitle: 'Sessão específica' }), ['Sessão específica', 'Projeto', 'modelo']);
});

test('focus uses the registered VS Code terminal and never tries another tab after a failed request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-focus-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, '.ai-hud', 'terminal-bridges'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'bridge.json'), JSON.stringify(record({ at: Date.now() })));
  const calls = [];
  const focus = createTerminalFocus({ home: root, native: async (args) => { calls.push(args); return { ok: true, clientPid: 99, ancestors: [{ pid: 99 }, { pid: 20, name: 'pwsh.exe' }, { pid: 1, name: 'Code.exe' }] }; },
    send: async (bridge, pid) => { assert.equal(pid, 20); return false; } });
  const result = await focus({ tool: 'Codex', file: 'session.jsonl' });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test('a missing live client does not focus a similarly named tab', async () => {
  let calls = 0;
  const focus = createTerminalFocus({ native: async () => { calls++; return { ok: true, clientPid: 0, ancestors: [] }; } });
  assert.equal((await focus({ tool: 'Codex', file: 'closed.jsonl' })).ok, false);
  assert.equal(calls, 1);
});

test('successful VS Code binding selects its exact process without Windows Terminal fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-focus-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, '.ai-hud', 'terminal-bridges'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'bridge.json'), JSON.stringify(record({ at: Date.now(), workspaceName: 'Projeto', folders: ['C:\\project', null] })));
  let nativeCalls = 0;
  const focus = createTerminalFocus({ home: root,
    native: async () => { nativeCalls++; return { ok: true, clientPid: 99, ancestors: [{ pid: 99 }, { pid: 20 }] }; },
    send: async (bridge, pid) => { assert.equal(pid, 20); return true; } });
  const result = await focus({ tool: 'Codex', file: 'session.jsonl' });
  assert.equal(result.ok, true);
  assert.equal(result.host, 'vscode');
  assert.equal(result.workspaceName, 'Projeto');
  assert.deepEqual(result.folders, ['C:\\project']);
  assert.equal(nativeCalls, 1);
});

test('Windows Terminal selection errors remain explicit', async () => {
  const calls = [];
  const focus = createTerminalFocus({ home: path.join(os.tmpdir(), 'no-hud-bridge'), native: async (args) => {
    calls.push(args);
    return args[1] === 'Inspect' ? { ok: true, clientPid: 99, ancestors: [], consoleTitle: 'Projeto único' } : { ok: false, code: 'ambiguous', message: 'Há várias abas com o mesmo título.' };
  } });
  const result = await focus({ tool: 'Ollama', pid: 99, models: new Set(['modelo']) });
  assert.equal(result.ok, false);
  assert.match(result.message, /mesmo título/);
  assert.equal(calls[1][1], 'Select');
});

test('title hints keep "|" from the console title (Codex CLI uses "subject | folder")', () => {
  assert.deepEqual(titleHints({ cwd: 'C:\\Users\\mprov' }, { consoleTitle: 'Responder saudação | mprov' }), ['Responder saudação | mprov', 'mprov']);
});

test('without a Windows Terminal tab, focuses the CLI own console window (PowerShell/cmd)', async () => {
  const calls = [];
  const focus = createTerminalFocus({ home: path.join(os.tmpdir(), 'no-hud-bridge'), native: async (args) => {
    calls.push(args);
    if (args[1] === 'Inspect') return { ok: true, clientPid: 99, ancestors: [{ pid: 99, name: 'codex.exe' }, { pid: 20, name: 'powershell.exe' }], consoleTitle: 'Projeto', consoleWindow: 4242 };
    return args[1] === 'Select' ? { ok: false, code: 'not_found', message: 'Não identifiquei a aba.' } : { ok: true };
  } });
  const result = await focus({ tool: 'Codex', pid: 99, cwd: 'C:\\work\\Projeto' });
  assert.equal(result.ok, true);
  assert.equal(result.host, 'console');
  assert.deepEqual(calls[2], ['-Mode', 'Window', '-WindowHandle', '4242']);
});
