const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSharedSessions } = require('../../src/actions/shared-sessions');
const { createHandoff } = require('../../src/actions/handoff');
const { handleRpc } = require('../../integrations/mcp/memory-server');

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const call = (ws, name, args) => {
  const r = handleRpc({ id: 1, method: 'tools/call', params: { name, arguments: args } }, ws);
  return { isError: r.result.isError, data: JSON.parse(r.result.content[0].text) };
};

test('sessão compartilhada via MCP: criar, atualizar, conflito de rev, handoff, vínculo e publicação', () => {
  const ws = tmpDir('hud-ss-ws-');
  const proj = path.join(tmpDir('hud-ss-proj-'), 'meu-app');
  fs.mkdirSync(proj);

  const created = call(ws, 'session_create', { cwd: proj, goal: 'Migrar login', tool: 'Claude Code' });
  assert.equal(created.isError, false);
  const s = created.data.session;
  assert.match(s.id, /^s-\d{8}-[a-z0-9]+$/);
  assert.ok(fs.existsSync(path.join(proj, '.ai-workspace', 'sessions', `${s.id}.json`)));

  const upd = call(ws, 'session_update', {
    cwd: proj, id: s.id, tool: 'Claude Code', expectedRev: 1,
    summary: 'Login migrado; falta teste. API_KEY=abcd1234efgh5678',
    addFiles: ['src/login.js'], addPending: ['escrever teste', 'revisar UI'], addDecisions: ['usar JWT'],
  });
  assert.equal(upd.isError, false);
  assert.equal(upd.data.session.rev, 2);
  assert.doesNotMatch(upd.data.session.summary, /abcd1234efgh5678/);

  // Outra IA com rev antiga recebe conflito em vez de sobrescrever
  const stale = call(ws, 'session_update', { cwd: proj, id: s.id, tool: 'Codex', expectedRev: 1, summary: 'x' });
  assert.equal(stale.isError, true);
  assert.equal(stale.data.code, 'conflict');

  const ho = call(ws, 'session_handoff', { cwd: proj, id: s.id, toTool: 'Codex', note: 'foque no teste' });
  assert.equal(ho.isError, false);
  assert.equal(ho.data.session.driver.tool, 'Codex');
  assert.match(ho.data.package, /- \[ \] escrever teste/);
  assert.match(ho.data.package, /handoff Claude Code → Codex: foque no teste/);

  const done = call(ws, 'session_update', { cwd: proj, id: s.id, tool: 'Codex', resolvePending: ['escrever teste'] });
  assert.deepEqual(done.data.session.pending, ['revisar UI']);

  const other = call(ws, 'session_create', { cwd: proj, goal: 'Refatorar UI', tool: 'Gemini' }).data.session;
  const linked = call(ws, 'session_link', { cwd: proj, id: other.id, otherId: s.id, tool: 'Gemini' });
  assert.equal(linked.isError, false);
  assert.match(linked.data.linkedPackage, /Migrar login/);
  const back = call(ws, 'session_read', { cwd: proj, id: s.id });
  assert.equal(back.data.session.links[0].id, other.id);

  const listed = call(ws, 'session_read', { cwd: proj });
  assert.equal(listed.data.total, 2);

  const pub = call(ws, 'session_publish', { cwd: proj, id: s.id, kind: 'pitfall', text: 'Token expira em 5 min; senha: password=SuperSecreta123', tool: 'Codex' });
  assert.equal(pub.isError, false);
  const pit = fs.readFileSync(path.join(ws, 'memory', 'meu-app', 'pitfalls.md'), 'utf8');
  assert.match(pit, /^# Armadilhas\n- \[\d{4}-\d\d-\d\d\] \(Codex · s-/);
  assert.doesNotMatch(pit, /SuperSecreta123/);
  // Outra sessão encontra o fato via memory_search
  const found = call(ws, 'memory_search', { query: 'expira', project: 'meu-app' });
  assert.equal(found.data.total, 1);

  assert.equal(call(ws, 'session_publish', { cwd: proj, kind: 'pinned', text: 'x' }).isError, true);
  assert.equal(call(ws, 'session_read', { cwd: proj, id: '../../etc' }).isError, true);
});

test('lock exclusivo: escrita concorrente aguarda e lock órfão expira', () => {
  const ws = tmpDir('hud-ss-ws-');
  const proj = tmpDir('hud-ss-lock-');
  const store = createSharedSessions({ workspaceRoot: ws });
  const s = store.create({ cwd: proj, tool: 'Claude Code', goal: 'g' }).session;
  const lock = path.join(proj, '.ai-workspace', 'sessions', `${s.id}.json.lock`);

  fs.writeFileSync(lock, '');
  const busy = store.update({ cwd: proj, id: s.id, tool: 'Codex', note: 'n' });
  assert.equal(busy.code, 'locked');

  const old = new Date(Date.now() - 60e3);
  fs.utimesSync(lock, old, old);
  const ok = store.update({ cwd: proj, id: s.id, tool: 'Codex', note: 'n' });
  assert.equal(ok.ok, true);
  assert.equal(fs.existsSync(lock), false);
});

test('handoff do HUD registra a troca na sessão compartilhada e a reutiliza no próximo handoff', async () => {
  const dataDir = tmpDir('hud-ss-data-');
  const proj = tmpDir('hud-ss-ho-');
  let n = 0;
  const prompts = [];
  const launch = async ({ tool, prompt }) => { prompts.push(prompt); return { status: 200, body: { ok: true, tool, id: `native-${++n}` } }; };
  const handoff = createHandoff({ dataDir, launch, readGit: async () => ({ branch: 'main', status: '' }) });

  const session = { id: 'native-0', tool: 'Claude Code', cwd: proj, project: 'p', title: 'Corrigir bug', files: { 'a.js': 2 } };
  const r1 = await handoff({ session, targetTool: 'Codex', note: 'continue' });
  assert.equal(r1.status, 200);
  const sid = r1.body.sharedSessionId;
  assert.ok(sid);
  assert.match(prompts[0], new RegExp(`Sessão compartilhada AI HUD: ${sid}`));

  // Handoff a partir da nova sessão nativa (Codex) cai na mesma sessão compartilhada
  const r2 = await handoff({ session: { ...session, id: 'native-1', tool: 'Codex' }, targetTool: 'Gemini' });
  assert.equal(r2.body.sharedSessionId, sid);

  // Prompt longo (última resposta + nota grandes) não pode truncar a referência da sessão compartilhada
  const big = 'x'.repeat(5000);
  const r3 = await handoff({ session: { ...session, id: 'native-z', lastReply: big }, targetTool: 'Codex', note: big });
  assert.ok(prompts[2].length <= 4000);
  assert.ok(prompts[2].endsWith(`id="${r3.body.sharedSessionId}".`));

  const rec = JSON.parse(fs.readFileSync(path.join(proj, '.ai-workspace', 'sessions', `${sid}.json`), 'utf8'));
  assert.equal(rec.driver.tool, 'Gemini');
  assert.deepEqual(rec.natives, ['native-0', 'native-1', 'native-2']);
  assert.deepEqual(rec.files, ['a.js']);
  assert.deepEqual(rec.timeline.filter((e) => e.type === 'handoff').map((e) => e.text), ['handoff Claude Code → Codex: continue', 'handoff Codex → Gemini']);
});
