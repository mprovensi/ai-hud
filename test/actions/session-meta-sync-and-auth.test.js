const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCapabilities, checkClaudeFileAuth, checkCodexFileAuth } = require('../../src/collect/capabilities');
const { createSessionMeta } = require('../../src/actions/session-meta');
const { createWorkspacePeerSync } = require('../../src/federation/workspace-peer-sync');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('capabilities detecta status de login de Claude Code, Codex e Gemini (agy)', async (t) => {
  const dir = mkTmp('ai-hud-auth-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const claudeHome = path.join(dir, '.claude');
  const codexHome = path.join(dir, '.codex');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  // Sem arquivos de credenciais -> deslogado
  assert.equal(checkClaudeFileAuth({ claudeHome, env: {} }).ok, false);
  assert.equal(checkCodexFileAuth({ codexHome, env: {} }).ok, false);

  // Credencial expirada sem refresh token -> deslogado
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: 1000 },
  }));
  assert.equal(checkClaudeFileAuth({ claudeHome, env: {}, now: 5000 }).ok, false);

  // Credencial válida com refreshToken -> ok
  fs.writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt: 1000, refreshToken: 'ref' },
  }));
  assert.equal(checkClaudeFileAuth({ claudeHome, env: {}, now: 5000 }).ok, true);

  // Codex com auth.json válido -> ok
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'abc.def.ghi', refresh_token: 'r1' },
  }));
  assert.equal(checkCodexFileAuth({ codexHome, env: {} }).ok, true);

  // `claude auth status` reportando loggedIn: false prevalece sobre arquivo antigo (caso real da VPS!)
  const claudeExe = path.join(dir, 'claude');
  const codexExe = path.join(dir, 'codex');
  const agyExe = path.join(dir, 'agy');
  fs.writeFileSync(claudeExe, '');
  fs.writeFileSync(codexExe, '');
  fs.writeFileSync(agyExe, '');

  const caps = createCapabilities({
    claudeExe,
    codexExe,
    agyExe,
    claudeHome,
    codexHome,
    env: {},
    exec: (exe, args, opts, cb) => {
      if (exe === claudeExe && args[0] === 'auth') {
        return cb(null, JSON.stringify({ loggedIn: false, authMethod: 'none' }), '');
      }
      if (exe === agyExe && args[0] === 'models') {
        return cb(new Error('Not logged in'), '', 'Please login first');
      }
      cb(null, '', '');
    },
  });

  await caps.refreshClaudeAuth();
  await caps.refreshAgyModels();
  const out = caps.get([], 'VPS-Oracle');
  assert.equal(out.tools['Claude Code'].auth.ok, false);
  assert.equal(out.tools['Claude Code'].auth.loginCmd, 'claude auth login');
  assert.equal(out.tools.Codex.auth.ok, true);
  assert.equal(out.tools.Gemini.auth.ok, false);
  assert.equal(out.tools.Gemini.auth.loginCmd, 'agy');
});

test('session-meta sincroniza bidirecionalmente entre VPS e Local traduzindo prefixos m<n>: e tombstones', async (t) => {
  const dirVps = mkTmp('ai-hud-meta-vps-');
  const dirLocal = mkTmp('ai-hud-meta-loc-');
  t.after(() => {
    fs.rmSync(dirVps, { recursive: true, force: true });
    fs.rmSync(dirLocal, { recursive: true, force: true });
  });

  const vpsMeta = createSessionMeta(dirVps);
  const localMeta = createSessionMeta(dirLocal);

  // Na VPS: sessão local da VPS `vps-1` foi fixada; sessão remota do MateusNote `m0:loc-1` recebeu alias
  vpsMeta.set({ id: 'vps-1', pinned: true, alias: 'Deploy VPS', group: 'Infra' });
  vpsMeta.set({ id: 'm0:loc-1', pinned: true, alias: 'Trivy TRT18', group: 'TRT18' });

  // No MateusNote: sessão local `loc-2` foi fixada
  localMeta.set({ id: 'loc-2', pinned: true, alias: 'Godot MVP', group: 'Jogos' });

  const vpsSync = createWorkspacePeerSync({
    dataDir: dirVps,
    config: {},
    peers: { list: [{ i: 0, name: 'MateusNote', url: 'http://local', token: 't' }] },
    machineName: 'VPS-Oracle',
    sessionMeta: vpsMeta,
  });

  const localSync = createWorkspacePeerSync({
    dataDir: dirLocal,
    config: { peers: [{ name: 'VPS-Oracle', url: 'http://vps', token: 't', primary: true }] },
    peers: { list: [{ i: 0, name: 'VPS-Oracle', url: 'http://vps', token: 't' }] },
    machineName: 'MateusNote',
    sessionMeta: localMeta,
    callPeer: async (_peer, method, route, body) => {
      if (method === 'POST' && route === '/api/workspace/peer-sync/session-meta') {
        return { status: 200, json: vpsSync.importSessionMeta(body.entries) };
      }
      return { status: 404, text: 'not found' };
    },
  });

  // 1. Sync bidirecional: VPS recebe `m0:loc-2`, Local recebe `m0:vps-1` e `loc-1`
  const r1 = await localSync.syncSessionMeta();
  assert.equal(r1.ok, true);
  assert.equal(r1.pushed, 1);
  assert.equal(r1.pulled, 2);

  assert.equal(vpsMeta.get('m0:loc-2').alias, 'Godot MVP');
  assert.equal(localMeta.get('m0:vps-1').alias, 'Deploy VPS');
  assert.equal(localMeta.get('loc-1').alias, 'Trivy TRT18');
  assert.equal(localMeta.get('loc-1').pinned, true);

  // 2. Desfixar/limpar `loc-1` no MateusNote gera tombstone que propaga e remove `m0:loc-1` na VPS
  await new Promise((resolve) => setTimeout(resolve, 15));
  localMeta.set({ id: 'loc-1', pinned: false, alias: '', group: '' });
  assert.equal(localMeta.get('loc-1'), null);

  const r2 = await localSync.syncSessionMeta();
  assert.equal(r2.ok, true);
  assert.equal(vpsMeta.get('m0:loc-1'), null);
});
