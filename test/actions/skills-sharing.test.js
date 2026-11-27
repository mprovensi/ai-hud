const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSkillFrontmatter, compareSemver, buildCrossAiSkillPrompt } = require('../../src/core/skills-catalog');
const { collectSkills, collectSkillsCatalog } = require('../../src/collect/skills');
const { createSkillsActions } = require('../../src/actions/skills');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hud-skills-'));

test('parseSkillFrontmatter e compareSemver tratam YAML multi-linha e versões semver', () => {
  const md = [
    '---',
    'name: vulnerabilidades-trivy-trt18',
    'description: >',
    '  Redução de vulnerabilidades Trivy em sistemas Spring Boot do TRT-18.',
    '---',
    '# Fluxo',
  ].join('\n');
  const parsed = parseSkillFrontmatter(md);
  assert.equal(parsed.name, 'vulnerabilidades-trivy-trt18');
  assert.match(parsed.description, /Spring Boot do TRT-18/);
  assert.equal(compareSemver('1.7.0', '1.2.0'), 1);
  assert.equal(compareSemver('1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.1.9', '1.2.0'), -1);

  const prompt = buildCrossAiSkillPrompt({
    cmd: '/vulnerabilidades-trivy-trt18',
    name: 'vulnerabilidades-trivy-trt18',
    skillFile: 'D:\\Projetos TRT18\\trt18-vulnerabilidades\\skills\\vulnerabilidades-trivy-trt18\\SKILL.md',
    pluginName: 'trt18-vulnerabilidades',
    agents: ['D:\\Projetos TRT18\\trt18-vulnerabilidades\\agents\\executor-scripts.md'],
  });
  assert.match(prompt, /SKILL\.md/);
  assert.match(prompt, /executor-scripts\.md/);
});

test('collectSkills herda skills de pasta-pai do workspace, descobre plugins Claude e gera prompt cross-IA para Codex/Gemini', () => {
  const root = tmpDir();
  const fakeHome = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const wsDir = path.join(dataDir, 'workspace');
  const trtRoot = path.join(root, 'Projetos TRT18');
  const subProj = path.join(trtRoot, 'vulnerabilidades');
  const pluginRepo = path.join(trtRoot, 'trt18-vulnerabilidades');
  const cacheDir = path.join(fakeHome, '.claude', 'plugins', 'cache', 'trt18-ferramentas', 'trt18-vulnerabilidades', '1.2.0');

  try {
    // 1. Skill herdada do workspace pai (TRT18\.claude\skills\spring-boot-engineer)
    fs.mkdirSync(path.join(trtRoot, '.claude', 'skills', 'spring-boot-engineer'), { recursive: true });
    fs.writeFileSync(
      path.join(trtRoot, '.claude', 'skills', 'spring-boot-engineer', 'SKILL.md'),
      '---\nname: spring-boot-engineer\ndescription: Padrões Spring Boot do TRT18\n---\n# Guia\n',
    );
    fs.mkdirSync(subProj, { recursive: true });

    // 2. Plugin local v1.7.0 vs cache Claude v1.2.0
    fs.mkdirSync(path.join(pluginRepo, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRepo, 'skills', 'vulnerabilidades-trivy-trt18'), { recursive: true });
    fs.mkdirSync(path.join(pluginRepo, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRepo, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'trt18-vulnerabilidades', version: '1.7.0', description: 'Plugin Trivy TRT18' }),
    );
    fs.writeFileSync(
      path.join(pluginRepo, 'skills', 'vulnerabilidades-trivy-trt18', 'SKILL.md'),
      '---\nname: vulnerabilidades-trivy-trt18\ndescription: Fluxo Trivy 0-H\n---\n# Trivy\n',
    );
    fs.writeFileSync(path.join(pluginRepo, 'agents', 'executor-scripts.md'), '# Executor\n');

    fs.mkdirSync(path.join(cacheDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'trt18-vulnerabilidades', version: '1.2.0' }));

    fs.mkdirSync(path.join(fakeHome, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'trt18-vulnerabilidades@trt18-ferramentas': true },
      extraKnownMarketplaces: { 'trt18-ferramentas': { source: { source: 'directory', path: pluginRepo } } },
    }));
    fs.writeFileSync(path.join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'trt18-vulnerabilidades@trt18-ferramentas': [{ scope: 'user', installPath: cacheDir, version: '1.2.0' }],
      },
    }));

    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({
      format: 'ai-workspace',
      version: 1,
      groups: ['TRT18'],
      groupMeta: { TRT18: { rootCwd: trtRoot, machine: 'MateusNote' } },
      entities: [],
    }));

    // Autocomplete no subprojeto `vulnerabilidades` usando Codex: deve achar herdada + plugin com prompt cross-IA!
    const listCodex = collectSkills({ workspaceRoot: wsDir, cwd: subProj, home: fakeHome, tool: 'Codex' });
    const trivy = listCodex.find((s) => s.cmd === '/vulnerabilidades-trivy-trt18');
    const spring = listCodex.find((s) => s.cmd === '/spring-boot-engineer');
    assert.ok(trivy, 'deve descobrir /vulnerabilidades-trivy-trt18 do plugin');
    assert.ok(spring, 'deve herdar /spring-boot-engineer de Projetos TRT18\\.claude\\skills');
    assert.equal(trivy.crossAi, true);
    assert.match(trivy.prompt, /SKILL\.md/);

    // Catálogo deve marcar plugin como desatualizado (1.2.0 -> 1.7.0)
    const cat = collectSkillsCatalog({ workspaceRoot: wsDir, home: fakeHome, machineName: 'MateusNote' });
    assert.equal(cat.plugins.length, 1);
    assert.equal(cat.plugins[0].outdated, true);
    assert.equal(cat.plugins[0].sourceVersion, '1.7.0');
    assert.equal(cat.plugins[0].cacheVersion, '1.2.0');

    // Ações: compartilhar plugin com Codex + Antigravity (via junction/symlink) e atualizar cache Claude -> 1.7.0
    const actions = createSkillsActions({ dataDir, config: {}, machineName: 'MateusNote', home: fakeHome });
    const shared = actions.batchShare({ pluginId: 'trt18-vulnerabilidades@trt18-ferramentas', targets: ['codex', 'antigravity'], enable: true });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.ok, true);
    assert.ok(fs.existsSync(path.join(fakeHome, '.codex', 'skills', 'vulnerabilidades-trivy-trt18', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(fakeHome, '.gemini', 'antigravity', 'skills', 'vulnerabilidades-trivy-trt18', 'SKILL.md')));

    // Descompartilhar do Codex remove apenas o link, preservando origem
    const unshared = actions.shareSkill({
      sourceDir: path.join(pluginRepo, 'skills', 'vulnerabilidades-trivy-trt18'),
      name: 'vulnerabilidades-trivy-trt18',
      targets: { codex: false },
    });
    assert.equal(unshared.status, 200);
    assert.equal(fs.existsSync(path.join(fakeHome, '.codex', 'skills', 'vulnerabilidades-trivy-trt18')), false);
    assert.equal(fs.existsSync(path.join(pluginRepo, 'skills', 'vulnerabilidades-trivy-trt18', 'SKILL.md')), true);

    // Atualizar cache do plugin no Claude Code: 1.2.0 -> 1.7.0 com backup
    const updated = actions.updateClaudePluginCache({ pluginId: 'trt18-vulnerabilidades@trt18-ferramentas' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, '1.7.0');
    assert.equal(updated.body.catalog.plugins[0].outdated, false);
    assert.equal(updated.body.catalog.plugins[0].cacheVersion, '1.7.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
