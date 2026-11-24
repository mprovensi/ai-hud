// Catálogo somente leitura de comandos `/` e skills locais (Claude, Codex, Antigravity e AI Workspace).
// Camada collect/.
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    prompt: 'Aplique o padrão Elephant-Goldfish (fase Spec-First): NÃO implemente código de produção ainda. Leia apenas os arquivos relevantes do projeto, levante escopo, fora de escopo, arquivos impactados e critérios de aceite objetivos, e salve/atualize uma especificação enxuta em `docs/specs/`.',
    source: 'workspace',
  },
  {
    cmd: '/egm-implement',
    name: 'egm-implement',
    description: 'EGM (Execução): implementar estritamente no escopo da spec e validar com testes',
    prompt: 'Aplique o padrão Elephant-Goldfish (fase Implementação): siga rigorosamente a spec/critérios de aceite sem expandir escopo, implemente as mudanças mínimas necessárias, rode testes/build para validar e entregue um resumo objetivo do que foi alterado.',
    source: 'workspace',
  },
  {
    cmd: '/egm-goldfish',
    name: 'egm-goldfish',
    description: 'EGM (Goldfish): revisão fria de git diff/spec buscando bugs, riscos e regressões',
    prompt: 'Atue como revisor independente Goldfish (revisão a frio): inspecione o `git diff` atual contra a spec/critérios de aceite, aponte apenas bugs concretos, regressões, riscos de segurança ou testes faltantes, corrija pendências críticas e confirme todos os testes passando.',
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

function extractDescription(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').slice(0, 1000);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (fm) {
      const desc = /^\s*description:\s*["']?([^\r\n"']+)/m.exec(fm[1]);
      if (desc) return desc[1].trim().slice(0, 120);
    }
    const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('---') && !l.startsWith('#'));
    return line ? line.slice(0, 120) : '';
  } catch { return ''; }
}

function scanFlatMdDir(dir, source, out, seen) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
      const name = e.name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const cmd = `/${name}`;
      if (!name || seen.has(cmd)) continue;
      seen.add(cmd);
      out.push({ cmd, name, description: extractDescription(path.join(dir, e.name)), source });
    }
  } catch {}
}

function scanSkillFolders(dir, source, out, seen) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const skillFile = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const name = e.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const cmd = `/${name}`;
      if (!name || seen.has(cmd)) continue;
      seen.add(cmd);
      out.push({ cmd, name, description: extractDescription(skillFile), source });
    }
  } catch {}
}

function collectSkills({ workspaceRoot = '', cwd = '', home = os.homedir() } = {}) {
  const out = [];
  const seen = new Set();

  // 1. Skills/comandos do projeto atual
  if (cwd) {
    scanFlatMdDir(path.join(cwd, '.claude', 'commands'), 'projeto', out, seen);
    scanSkillFolders(path.join(cwd, '.claude', 'skills'), 'projeto', out, seen);
    scanSkillFolders(path.join(cwd, '.agents', 'skills'), 'projeto', out, seen);
  }
  // 2. Skills do AI Workspace
  if (workspaceRoot) {
    scanFlatMdDir(path.join(workspaceRoot, 'skills'), 'workspace', out, seen);
    scanSkillFolders(path.join(workspaceRoot, 'skills'), 'workspace', out, seen);
  }
  // 3. Skills/comandos globais das IAs
  scanFlatMdDir(path.join(home, '.claude', 'commands'), 'claude', out, seen);
  scanSkillFolders(path.join(home, '.claude', 'skills'), 'claude', out, seen);
  scanSkillFolders(path.join(home, '.codex', 'skills'), 'codex', out, seen);
  scanSkillFolders(path.join(home, '.gemini', 'config', 'skills'), 'antigravity', out, seen);

  // 4. Comandos úteis padrão
  for (const b of BUILTIN_COMMANDS) {
    if (!seen.has(b.cmd)) {
      seen.add(b.cmd);
      out.push(b);
    }
  }

  return out.slice(0, 60);
}

module.exports = { collectSkills };
