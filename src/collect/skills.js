// Catálogo somente leitura de comandos `/`, skills e plugins locais (Claude, Codex, Antigravity, Workspaces e Plugins).
// Camada collect/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sanitizeSkillName,
  parseSkillFrontmatter,
  compareSemver,
  buildCrossAiSkillPrompt,
} = require('../core/skills-catalog');
const { readWorkspaceJson } = require('./workspace');

const BUILTIN_COMMANDS = [
  {
    cmd: '/board-sync',
    name: 'board-sync',
    description: 'Auditar .ai-workspace/board.card.json contra o código/git e atualizar status',
    prompt: 'Leia `.ai-workspace/board.card.json` (ou use a tool MCP `board_read`), compare as tarefas em `idea`, `spec` e `in-progress` com o código e o git atual do projeto, liste quais já foram concluídas com evidência curta e atualize os status delas (usando `board_update_status` ou editando `.ai-workspace/board.card.json` mantendo o schema `ai-card` v1 e sincronizando `- [x]` nos docs vinculados).',
    source: 'workspace',
  },
  {
    cmd: '/board-status',
    name: 'board-status',
    description: 'Resumir rapidamente o Quadro (.ai-workspace/board.card.json) e sugerir próxima tarefa',
    prompt: 'Leia `.ai-workspace/board.card.json` (ou use `board_read`) e faça um resumo curto por coluna (Ideia, Spec, Em andamento, Revisão, Concluído) indicando qual é a próxima tarefa mais prioritária.',
    source: 'workspace',
  },
  {
    cmd: '/egm-spec',
    name: 'egm-spec',
    description: 'EGM (Elefante): gerar especificação enxuta em docs/specs/ antes de codar',
    prompt: 'Aplique o padrão Elephant-Goldfish (fase Spec-First): NÃO implemente código de produção ainda. Leia apenas os arquivos relevantes do projeto (se delegar buscas/leitura mecânica a subagentes, use modelo leve `haiku`/`flash`/`mini`; mantenha raciocínio arquitetural no modelo principal), levante escopo, fora de escopo, arquivos impactados e critérios de aceite objetivos, e salve/atualize uma especificação enxuta em `docs/specs/`.',
    source: 'workspace',
  },
  {
    cmd: '/egm-implement',
    name: 'egm-implement',
    description: 'EGM (Execução): implementar estritamente no escopo da spec e validar com testes',
    prompt: 'Aplique o padrão Elephant-Goldfish (fase Implementação): siga rigorosamente a spec/critérios de aceite sem expandir escopo. Roteamento de subagentes EGM: delegue buscas/inspeções/tarefas mecânicas simples para subagentes rápidos (`haiku`/`flash`/`mini`) e reserve modelos equilibrados/fortes (`sonnet`/`opus`/`pro`) para implementação complexa ou multi-arquivo. Rode testes/build para validar e entregue um resumo objetivo do que foi alterado.',
    source: 'workspace',
  },
  {
    cmd: '/egm-goldfish',
    name: 'egm-goldfish',
    description: 'EGM (Goldfish): revisão fria de git diff/spec buscando bugs, riscos e regressões',
    prompt: 'Atue como revisor independente Goldfish (revisão a frio — use modelo forte/equilibrado `sonnet`/`opus`/`pro`, nunca modelo mínimo em revisões complexas): inspecione o `git diff` atual contra a spec/critérios de aceite, valide se o projeto possui `.ai-workspace/run.json` configurado e sobe sem erros, aponte apenas bugs concretos, regressões, riscos de segurança ou testes faltantes, corrija pendências críticas e confirme todos os testes passando.',
    source: 'workspace',
  },
  {
    cmd: '/design-system',
    name: 'design-system',
    description: 'Aplicar tokens e regras do Design System Obsidian Slate (AI HUD & AI Workspace)',
    prompt: 'Leia `docs/design-system.md` e `workspace-app/src/design-system/tokens.css` e aplique rigorosamente os tokens de cor, tipografia, raios, primitivos de `workspace-app/src/ui/index.tsx` e regras de UX (modais sem fechamento por clique fora, ES5 sem gap em `web/`) na tarefa atual.',
    source: 'workspace',
  },
  { cmd: '/plan', name: 'plan', description: 'Planejar passo a passo antes de implementar', source: 'builtin' },
  { cmd: '/compact', name: 'compact', description: 'Compactar contexto da conversa', source: 'builtin' },
  { cmd: '/review', name: 'review', description: 'Revisar alterações e buscar falhas/melhorias', source: 'builtin' },
  { cmd: '/test', name: 'test', description: 'Executar a suíte de testes e reportar falhas', source: 'builtin' },
];

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function realPathSafe(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function pathsEqual(a, b) {
  if (!a || !b) return false;
  const na = realPathSafe(a);
  const nb = realPathSafe(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function getCliSkillDirs(home = os.homedir()) {
  return {
    claude: path.join(home, '.claude', 'skills'),
    codex: path.join(home, '.codex', 'skills'),
    antigravity: path.join(home, '.gemini', 'antigravity', 'skills'),
  };
}

function readSkillMeta(skillFile, fallbackName) {
  let raw = '';
  try { raw = fs.readFileSync(skillFile, 'utf8').slice(0, 2400); } catch {}
  const fm = parseSkillFrontmatter(raw);
  const name = sanitizeSkillName(fallbackName || fm.name) || sanitizeSkillName(fm.name);
  return {
    name,
    description: fm.description || '',
  };
}

function scanFlatMdDir(dir, source, out, seen) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
      const name = sanitizeSkillName(e.name.replace(/\.md$/i, ''));
      const cmd = `/${name}`;
      if (!name || seen.has(cmd)) continue;
      seen.add(cmd);
      const filePath = path.join(dir, e.name);
      const meta = readSkillMeta(filePath, name);
      out.push({
        cmd,
        name,
        description: meta.description,
        source,
        skillFile: filePath,
      });
    }
  } catch {}
}

function scanSkillFolders(dir, source, out, seen, extra = {}) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const folder = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try { isDir = fs.statSync(folder).isDirectory(); } catch { isDir = false; }
      }
      if (!isDir) continue;
      const skillFile = path.join(folder, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const name = sanitizeSkillName(e.name);
      const cmd = `/${name}`;
      if (!name || seen.has(cmd)) continue;
      seen.add(cmd);
      const meta = readSkillMeta(skillFile, name);
      out.push({
        cmd,
        name,
        description: meta.description,
        source,
        skillDir: realPathSafe(folder),
        skillFile: realPathSafe(skillFile),
        plugin: extra.plugin || '',
        crossAiPrompt: buildCrossAiSkillPrompt({
          cmd,
          name,
          skillFile: realPathSafe(skillFile),
          pluginName: extra.plugin || '',
          agents: extra.agents || [],
        }),
      });
    }
  } catch {}
}

// Descobre plugins do Claude Code (installed_plugins.json + extraKnownMarketplaces em settings.json)
function discoverClaudePlugins(home = os.homedir()) {
  const settings = readJsonSafe(path.join(home, '.claude', 'settings.json'), {}) || {};
  const installed = readJsonSafe(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {}) || {};
  const enabledMap = settings.enabledPlugins || {};
  const marketplaces = settings.extraKnownMarketplaces || {};
  const pluginsMap = installed.plugins || {};
  const byId = new Map();

  // 1. Plugins instalados via installed_plugins.json
  for (const [pluginId, entries] of Object.entries(pluginsMap)) {
    const entry = Array.isArray(entries) ? entries[0] : null;
    if (!entry || !entry.installPath) continue;
    const [pName, marketplace = ''] = pluginId.split('@');
    byId.set(pluginId, {
      id: pluginId,
      name: pName || pluginId,
      marketplace,
      enabled: enabledMap[pluginId] !== false,
      cachePath: entry.installPath,
      cacheVersion: String(entry.version || ''),
      sourcePath: '',
      sourceVersion: '',
    });
  }

  // 2. Marketplaces locais (extraKnownMarketplaces com source: "directory")
  for (const [mktName, mktCfg] of Object.entries(marketplaces)) {
    const src = mktCfg && mktCfg.source;
    const dirPath = src && src.source === 'directory' && src.path ? String(src.path).trim() : '';
    if (!dirPath || !fs.existsSync(dirPath)) continue;

    // Caso A: o próprio diretório é um plugin (.claude-plugin/plugin.json)
    const directPluginJson = path.join(dirPath, '.claude-plugin', 'plugin.json');
    const candidates = [];
    if (fs.existsSync(directPluginJson)) {
      candidates.push(dirPath);
    } else {
      // Caso B: marketplace com subpastas de plugins ou marketplace.json
      const mktJson = readJsonSafe(path.join(dirPath, '.claude-plugin', 'marketplace.json'), null);
      if (mktJson && Array.isArray(mktJson.plugins)) {
        for (const p of mktJson.plugins) {
          const pDir = p && p.source ? path.resolve(dirPath, String(p.source)) : dirPath;
          if (fs.existsSync(path.join(pDir, '.claude-plugin', 'plugin.json'))) candidates.push(pDir);
        }
      }
    }

    for (const pDir of candidates) {
      const pj = readJsonSafe(path.join(pDir, '.claude-plugin', 'plugin.json'), null);
      if (!pj || !pj.name) continue;
      const pluginId = `${pj.name}@${mktName}`;
      const cur = byId.get(pluginId) || {
        id: pluginId,
        name: pj.name,
        marketplace: mktName,
        enabled: enabledMap[pluginId] !== false,
        cachePath: '',
        cacheVersion: '',
        sourcePath: '',
        sourceVersion: '',
      };
      cur.sourcePath = path.resolve(pDir);
      cur.sourceVersion = String(pj.version || '');
      cur.description = String(pj.description || '');
      cur.author = (pj.author && pj.author.name) || '';
      byId.set(pluginId, cur);
    }
  }

  // Enriquecer cada plugin com skills, agents, versão efetiva e flag de cache desatualizado
  const results = [];
  for (const p of byId.values()) {
    const hasSource = !!(p.sourcePath && fs.existsSync(p.sourcePath));
    const hasCache = !!(p.cachePath && fs.existsSync(p.cachePath));
    // Prefere o repositório local se existir e for mais novo ou igual ao cache
    const useSource = hasSource && (!hasCache || compareSemver(p.sourceVersion, p.cacheVersion) >= 0);
    const activeDir = useSource ? p.sourcePath : (hasCache ? p.cachePath : '');
    if (!activeDir) continue;

    const pj = readJsonSafe(path.join(activeDir, '.claude-plugin', 'plugin.json'), {}) || {};
    const agents = [];
    try {
      for (const ae of fs.readdirSync(path.join(activeDir, 'agents'), { withFileTypes: true })) {
        if (ae.isFile() && ae.name.endsWith('.md')) {
          agents.push({
            name: ae.name.replace(/\.md$/i, ''),
            path: path.join(activeDir, 'agents', ae.name),
          });
        }
      }
    } catch {}

    const skills = [];
    const seen = new Set();
    scanSkillFolders(path.join(activeDir, 'skills'), `plugin:${p.name}`, skills, seen, {
      plugin: p.name,
      agents: agents.map((a) => a.path),
    });
    scanFlatMdDir(path.join(activeDir, 'commands'), `plugin:${p.name}`, skills, seen);

    const outdated = !!(hasSource && hasCache && p.sourceVersion && p.cacheVersion && compareSemver(p.sourceVersion, p.cacheVersion) > 0);
    results.push({
      id: p.id,
      name: p.name,
      marketplace: p.marketplace,
      enabled: p.enabled,
      description: p.description || String(pj.description || ''),
      author: p.author || (pj.author && pj.author.name) || '',
      activePath: activeDir,
      sourcePath: hasSource ? p.sourcePath : '',
      sourceVersion: p.sourceVersion || String(pj.version || ''),
      cachePath: hasCache ? p.cachePath : '',
      cacheVersion: p.cacheVersion || '',
      outdated,
      canUpdateCache: !!(hasSource && p.sourceVersion),
      agents,
      skills,
    });
  }

  return results;
}

// Sobe diretórios-pai de `cwd` (até 4 níveis, parando antes do root/home) para herdar `.claude/skills` de Workspaces como `D:\Projetos TRT18`
function ancestorDirs(cwd, home) {
  const dirs = [];
  if (!cwd) return dirs;
  let cur = path.resolve(cwd);
  const normHome = home ? path.resolve(home).toLowerCase() : '';
  for (let i = 0; i < 5; i++) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    if (normHome && parent.toLowerCase() === normHome) break;
    cur = parent;
  }
  return dirs;
}

function collectSkills({ workspaceRoot = '', cwd = '', home = os.homedir(), tool = '' } = {}) {
  const out = [];
  const seen = new Set();

  // 1. Skills/comandos do projeto atual e pastas-pai (ex.: D:\Projetos TRT18\.claude\skills)
  const ancestors = ancestorDirs(cwd, home);
  for (let i = 0; i < ancestors.length; i++) {
    const dir = ancestors[i];
    const srcLabel = i === 0 ? 'projeto' : `workspace:${path.basename(dir)}`;
    scanFlatMdDir(path.join(dir, '.claude', 'commands'), srcLabel, out, seen);
    scanSkillFolders(path.join(dir, '.claude', 'skills'), srcLabel, out, seen);
    scanSkillFolders(path.join(dir, '.agents', 'skills'), srcLabel, out, seen);
    scanSkillFolders(path.join(dir, '.gemini', 'skills'), srcLabel, out, seen);
  }

  // 2. Plugins instalados/locais do Claude Code (ex.: trt18-vulnerabilidades -> /vulnerabilidades-trivy-trt18)
  const plugins = discoverClaudePlugins(home);
  for (const pl of plugins) {
    if (!pl.enabled) continue;
    for (const sk of pl.skills) {
      if (seen.has(sk.cmd)) continue;
      seen.add(sk.cmd);
      out.push(sk);
    }
  }

  // 3. Skills do AI Workspace (global do hub)
  if (workspaceRoot) {
    scanFlatMdDir(path.join(workspaceRoot, 'skills'), 'workspace', out, seen);
    scanSkillFolders(path.join(workspaceRoot, 'skills'), 'workspace', out, seen);
  }

  // 4. Skills/comandos globais das 3 CLIs
  const cliDirs = getCliSkillDirs(home);
  scanFlatMdDir(path.join(home, '.claude', 'commands'), 'claude', out, seen);
  scanSkillFolders(cliDirs.claude, 'claude', out, seen);
  scanSkillFolders(cliDirs.codex, 'codex', out, seen);
  scanSkillFolders(cliDirs.antigravity, 'antigravity', out, seen);
  scanSkillFolders(path.join(home, '.gemini', 'config', 'skills'), 'antigravity', out, seen);

  // 5. Se a sessão for Codex ou Gemini e a skill vier de plugin/Claude não linkado, fornece prompt cross-IA direto
  const normTool = tool === 'Antigravity' ? 'Gemini' : tool;
  const enriched = out.map((sk) => {
    if (sk.prompt) return sk;
    const isNativeToTool =
      (normTool === 'Claude Code' && (sk.source === 'claude' || sk.source === 'projeto' || sk.source.startsWith('plugin:') || sk.source.startsWith('workspace:'))) ||
      (normTool === 'Codex' && sk.source === 'codex') ||
      (normTool === 'Gemini' && sk.source === 'antigravity');
    if (normTool && !isNativeToTool && sk.crossAiPrompt) {
      return { ...sk, prompt: sk.crossAiPrompt, crossAi: true };
    }
    return sk;
  });

  // 6. Comandos úteis padrão
  for (const b of BUILTIN_COMMANDS) {
    if (!seen.has(b.cmd)) {
      seen.add(b.cmd);
      enriched.push(b);
    }
  }

  return enriched.slice(0, 80);
}

// Verifica se uma CLI específica já tem a skill (nativa ou via junction/symlink)
function inspectTargetStatus(cliDir, skillName, canonicalSourceDir) {
  const targetPath = path.join(cliDir, skillName);
  if (!fs.existsSync(targetPath)) {
    // Também checa symlink quebrado via lstat
    try {
      const lst = fs.lstatSync(targetPath);
      if (lst.isSymbolicLink()) return { status: 'broken', linked: false, native: false, path: targetPath };
    } catch {}
    return { status: 'missing', linked: false, native: false, path: targetPath };
  }
  try {
    const lst = fs.lstatSync(targetPath);
    if (lst.isSymbolicLink()) {
      const same = pathsEqual(targetPath, canonicalSourceDir);
      return { status: same ? 'linked' : 'other-link', linked: same, native: false, path: targetPath };
    }
    const same = pathsEqual(targetPath, canonicalSourceDir);
    return { status: same ? 'native' : 'conflict', linked: same, native: same, path: targetPath };
  } catch {
    return { status: 'missing', linked: false, native: false, path: targetPath };
  }
}

// Catálogo completo para a tela de gerenciamento & compartilhamento (Skills & Plugins)
function collectSkillsCatalog({ workspaceRoot = '', home = os.homedir(), machineName = '' } = {}) {
  const cliDirs = getCliSkillDirs(home);
  const plugins = discoverClaudePlugins(home);
  const byKey = new Map();

  function addSkillEntry(sk, originLabel, originKind) {
    if (!sk || !sk.skillDir) return;
    const key = `${sk.name}::${process.platform === 'win32' ? sk.skillDir.toLowerCase() : sk.skillDir}`;
    if (byKey.has(key)) return;
    const targets = {
      claude: inspectTargetStatus(cliDirs.claude, sk.name, sk.skillDir),
      codex: inspectTargetStatus(cliDirs.codex, sk.name, sk.skillDir),
      antigravity: inspectTargetStatus(cliDirs.antigravity, sk.name, sk.skillDir),
    };
    // Plugin do Claude já fica ativo no Claude Code mesmo sem pasta em ~/.claude/skills
    if (originKind === 'plugin' && targets.claude.status === 'missing') {
      targets.claude = { ...targets.claude, status: 'plugin', linked: true, native: true };
    }
    byKey.set(key, {
      id: `${originKind}:${sk.name}`,
      name: sk.name,
      cmd: sk.cmd,
      description: sk.description || '',
      origin: originLabel,
      originKind,
      plugin: sk.plugin || '',
      sourceDir: sk.skillDir,
      skillFile: sk.skillFile,
      targets,
    });
  }

  // 1. Skills de plugins do Claude
  for (const pl of plugins) {
    for (const sk of pl.skills) {
      addSkillEntry(sk, `Plugin ${pl.name}`, 'plugin');
    }
  }

  // 2. Skills de workspaces registrados em workspace.json (ex.: TRT18 -> D:\Projetos TRT18\.claude\skills)
  const workspaceRootsScanned = [];
  if (workspaceRoot) {
    try {
      const ws = readWorkspaceJson(workspaceRoot);
      const gm = (ws && ws.groupMeta) || {};
      for (const [groupName, meta] of Object.entries(gm)) {
        if (!meta || !meta.rootCwd) continue;
        if (meta.machine && machineName && meta.machine !== machineName) continue;
        if (!fs.existsSync(meta.rootCwd)) continue;
        workspaceRootsScanned.push({ group: groupName, rootCwd: meta.rootCwd });
        const found = [];
        const seen = new Set();
        scanSkillFolders(path.join(meta.rootCwd, '.claude', 'skills'), `workspace:${groupName}`, found, seen);
        scanSkillFolders(path.join(meta.rootCwd, '.agents', 'skills'), `workspace:${groupName}`, found, seen);
        for (const sk of found) addSkillEntry(sk, `Workspace ${groupName}`, 'workspace');
      }
    } catch {}
  }

  // 3. Skills globais das 3 CLIs (ignorando symlinks que apontam para origens já catalogadas acima)
  const cliSources = [
    ['claude', cliDirs.claude, 'Claude Global'],
    ['codex', cliDirs.codex, 'Codex Global'],
    ['antigravity', cliDirs.antigravity, 'Antigravity Global'],
  ];
  for (const [cliId, dir, label] of cliSources) {
    const found = [];
    const seen = new Set();
    scanSkillFolders(dir, cliId, found, seen);
    for (const sk of found) {
      // Se já existe uma entrada com o mesmo realpath (junction para plugin/workspace), não duplica
      const dup = [...byKey.values()].some((x) => pathsEqual(x.sourceDir, sk.skillDir));
      if (!dup) addSkillEntry(sk, label, cliId);
    }
  }

  // Enriquecer skills dentro de cada plugin com status de targets
  const pluginsWithTargets = plugins.map((pl) => ({
    ...pl,
    skills: pl.skills.map((sk) => {
      const entry = [...byKey.values()].find((x) => pathsEqual(x.sourceDir, sk.skillDir));
      return {
        name: sk.name,
        cmd: sk.cmd,
        description: sk.description,
        sourceDir: sk.skillDir,
        targets: entry ? entry.targets : null,
      };
    }),
  }));

  return {
    ok: true,
    machine: machineName,
    cliDirs,
    workspaceRoots: workspaceRootsScanned,
    plugins: pluginsWithTargets,
    skills: [...byKey.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name)),
  };
}

module.exports = {
  collectSkills,
  collectSkillsCatalog,
  discoverClaudePlugins,
  getCliSkillDirs,
};
