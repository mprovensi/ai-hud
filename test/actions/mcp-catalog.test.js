// Testes unitários e de integração para MCPs Compartilhados (Claude, Codex TOML, Antigravity) e ciclo de vida.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractSecretRefs,
  parseCodexTomlMcp,
  applyCodexTomlMcp,
  applyClaudeMcp,
  applyAntigravityMcp,
} = require('../../src/core/mcp-catalog');
const { createMcpActions } = require('../../src/actions/mcp');
const { createApp } = require('../../src/main');

function mkTmp(prefix = 'ai-hud-mcp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('extractSecretRefs separa segredos em placeholders ${VAR} preservando valores comuns', () => {
  const { clean, secrets } = extractSecretRefs({
    JIRA_URL: 'https://empresa.atlassian.net',
    JIRA_API_TOKEN: 'super-secret-123',
    GITHUB_TOKEN: '${GITHUB_TOKEN}',
  }, 'mcp-atlassian');

  assert.equal(clean.JIRA_URL, 'https://empresa.atlassian.net');
  assert.equal(clean.JIRA_API_TOKEN, '${JIRA_API_TOKEN}');
  assert.equal(clean.GITHUB_TOKEN, '${GITHUB_TOKEN}');
  assert.deepEqual(secrets, { JIRA_API_TOKEN: 'super-secret-123' });
});

test('applyCodexTomlMcp preserva seções não gerenciadas (node_repl, projects) e atualiza apenas IDs gerenciados', () => {
  const original = [
    'model = "gpt-5-codex"',
    '',
    '[projects."D:\\\\Projetos\\\\ai-hud"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.node_repl]',
    'command = \'C:\\Users\\demo\\node_repl.exe\'',
    'args = []',
    '',
    '[mcp_servers.node_repl.env]',
    'FOO = "1"',
    '',
    '[mcp_servers.old_managed]',
    'command = "old"',
    'args = []',
    '',
  ].join('\n');

  const updated = applyCodexTomlMcp(
    original,
    [
      {
        id: 'ai-hud-memory',
        transport: 'stdio',
        command: 'node',
        args: ['D:/Projetos/ai-hud/integrations/mcp/memory-server.js'],
        env: { AI_HUD_TOKEN: 'tok-xyz' },
        headers: {},
      },
      {
        id: 'figma',
        transport: 'http',
        url: 'https://mcp.figma.com/mcp',
        env: {},
        headers: {},
      },
    ],
    ['old_managed', 'ai-hud-memory', 'figma'],
  );

  // Preservou config existente e node_repl
  assert.match(updated, /model = "gpt-5-codex"/);
  assert.match(updated, /\[projects\."D:\\\\Projetos\\\\ai-hud"\]/);
  assert.match(updated, /\[mcp_servers\.node_repl\]/);
  assert.doesNotMatch(updated, /\[mcp_servers\.old_managed\]/);

  // Round-trip parse
  const parsed = parseCodexTomlMcp(updated);
  assert.ok(parsed.node_repl);
  assert.equal(parsed.node_repl.command, 'C:\\Users\\demo\\node_repl.exe');
  assert.equal(parsed['ai-hud-memory'].command, 'node');
  assert.deepEqual(parsed['ai-hud-memory'].args, ['D:/Projetos/ai-hud/integrations/mcp/memory-server.js']);
  assert.equal(parsed['ai-hud-memory'].env.AI_HUD_TOKEN, 'tok-xyz');
  assert.equal(parsed.figma.transport, 'http');
  assert.equal(parsed.figma.url, 'https://mcp.figma.com/mcp');
});

test('createMcpActions importa das CLIs isolando segredos, instala preset ai-hud-memory e sincroniza nas 3 CLIs', () => {
  const dir = mkTmp('ai-hud-mcp-act-');
  const home = mkTmp('ai-hud-mcp-home-');
  const proj = mkTmp('ai-hud-mcp-proj-');
  const cliPaths = {
    claude: path.join(home, '.claude.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    antigravity: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
  };
  try {
    fs.mkdirSync(path.dirname(cliPaths.codex), { recursive: true });
    fs.mkdirSync(path.dirname(cliPaths.antigravity), { recursive: true });

    // Estado inicial simulando o PC real do usuário
    fs.writeFileSync(cliPaths.claude, JSON.stringify({
      theme: 'dark',
      mcpServers: {
        'mcp-atlassian': {
          command: 'uvx',
          args: ['mcp-atlassian'],
          env: { JIRA_URL: 'https://jira.local', JIRA_API_TOKEN: 'SECRET-JIRA-999' },
        },
        figma: { type: 'http', url: 'https://mcp.figma.com/mcp' },
      },
    }, null, 2));
    fs.writeFileSync(cliPaths.codex, '[mcp_servers.node_repl]\ncommand = "node_repl"\nargs = []\n');
    fs.writeFileSync(cliPaths.antigravity, JSON.stringify({ mcpServers: { manual_only: { command: 'echo', args: ['hi'] } } }, null, 2));

    const mcp = createMcpActions({
      dataDir: dir,
      config: {},
      machineName: 'MateusNote',
      cliPaths,
      aiHudRoot: 'D:\\Projetos\\ai-hud',
    });

    // 1. Importa das CLIs (ignora node_repl, extrai JIRA_API_TOKEN para mcp-secrets.json)
    const imp = mcp.importFromClis({ targets: ['claude', 'codex'] });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.importedCount, 2);

    const catalogRaw = fs.readFileSync(path.join(dir, 'workspace', 'mcp-servers.json'), 'utf8');
    assert.doesNotMatch(catalogRaw, /SECRET-JIRA-999/, 'segredo nunca deve vazar em mcp-servers.json');
    assert.match(catalogRaw, /\$\{JIRA_API_TOKEN\}/);

    const secretsJson = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-secrets.json'), 'utf8'));
    assert.equal(secretsJson.JIRA_API_TOKEN, 'SECRET-JIRA-999');

    // 2. Habilita mcp-atlassian também no Antigravity e instala preset ai-hud-memory com sync
    const atlassian = imp.body.status.servers.find((s) => s.id === 'mcp-atlassian');
    const up = mcp.upsertServer({
      server: { ...atlassian, targets: { claude: true, codex: true, antigravity: true } },
    });
    assert.equal(up.status, 200);

    const preset = mcp.installMemoryPreset({ sync: true });
    assert.equal(preset.status, 200);

    // 3. Confirma que as 3 CLIs receberam ai-hud-memory e mcp-atlassian com segredo expandido, preservando entradas não gerenciadas
    const claudeAfter = JSON.parse(fs.readFileSync(cliPaths.claude, 'utf8'));
    assert.equal(claudeAfter.theme, 'dark');
    assert.equal(claudeAfter.mcpServers['ai-hud-memory'].args[0], 'D:/Projetos/ai-hud/integrations/mcp/memory-server.js');
    assert.equal(claudeAfter.mcpServers['mcp-atlassian'].env.JIRA_API_TOKEN, 'SECRET-JIRA-999');

    const agyAfter = JSON.parse(fs.readFileSync(cliPaths.antigravity, 'utf8'));
    assert.ok(agyAfter.mcpServers.manual_only, 'entrada não gerenciada do Antigravity deve ser preservada');
    assert.equal(agyAfter.mcpServers['ai-hud-memory'].command, 'node');
    assert.equal(agyAfter.mcpServers['mcp-atlassian'].env.JIRA_API_TOKEN, 'SECRET-JIRA-999');

    const codexParsed = parseCodexTomlMcp(fs.readFileSync(cliPaths.codex, 'utf8'));
    assert.ok(codexParsed.node_repl, 'node_repl do Codex deve ser preservado');
    assert.equal(codexParsed['ai-hud-memory'].command, 'node');
    assert.equal(codexParsed['mcp-atlassian'].env.JIRA_API_TOKEN, 'SECRET-JIRA-999');

    // 4. Sync por projeto (.mcp.json)
    const projSync = mcp.syncToClis({ projectCwd: proj });
    assert.equal(projSync.status, 200);
    const projMcp = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
    assert.ok(projMcp.mcpServers['ai-hud-memory']);

    // 5. Status agora reporta ai-hud-memory como synced nas 3 CLIs
    const st = mcp.getStatus();
    const memSrv = st.servers.find((s) => s.id === 'ai-hud-memory');
    assert.deepEqual(memSrv.targetStatus, { claude: 'synced', codex: 'synced', antigravity: 'synced' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('createApp expõe start() e stop() idempotentes sem vazar timers ativos', () => {
  const dir = mkTmp('ai-hud-life-');
  try {
    const app = createApp({
      dataDir: dir,
      sources: { collect: () => [], start() {}, stop() {} },
      quotaFetchers: { claude: async () => ({ error: 'off' }), codex: async () => ({ error: 'off' }), gemini: async () => ({ error: 'off' }) },
      brands: false,
      log: () => {},
    });
    assert.equal(typeof app.start, 'function');
    assert.equal(typeof app.stop, 'function');
    app.start();
    app.start(); // idempotente
    app.stop();
    app.stop(); // idempotente
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
