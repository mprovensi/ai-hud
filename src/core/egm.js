// Regras puras do workflow EGM Lite (Elephant-Goldfish Model simplificado e econômico em tokens — camada core: sem I/O).
const { redactSecrets } = require('./redact');
const { slugifyEntity } = require('./workspace-schema');

const SPEC_MAX_CHARS = 12000;
const MEMORY_CONTEXT_MAX_CHARS = 3500;
const STRUCTURE_DOCS_MAX_CHARS = 14000;
const RUN_SNAPSHOT_MAX_CHARS = 9000;

const COMPLEX_SIGNAL_RE = /\b(arquitetura|architecture|migra[cç][aã]o|migration|seguran[cç]a|security|auth|concorr[eê]ncia|concurrency|race|protocolo|federation|banco de dados|schema|refactor|refatora|multi-?m[aá]quina|websocket|pty|performance|cripto)\b/i;

// Classifica a complexidade de uma tarefa EGM para selecionar o tier de modelo adequado:
// - simple: tarefas mecânicas/curtas (triagem, estruturação pequena, checagens simples) → haiku / flash / mini / Ollama
// - standard: implementação padrão ou revisão Goldfish de spec enxuta → sonnet / modelo padrão
// - complex: revisão Goldfish profunda, arquitetura, segurança, multi-módulo ou alta prioridade → opus / pro / Codex completo
function classifyEgmComplexity({ kind = 'goldfish-review', docContent = '', docCount = 1, priority = '', body = '' } = {}) {
  const text = `${docContent || ''}\n${body || ''}`;
  const chars = text.trim().length;
  const prio = String(priority || '').toLowerCase();
  const hasComplexSignal = COMPLEX_SIGNAL_RE.test(text);

  if (kind === 'structure-from-docs') {
    if (docCount <= 3 && chars <= 5000 && !hasComplexSignal) {
      return { tier: 'simple', reason: 'estruturação mecânica de poucos documentos' };
    }
    return { tier: 'standard', reason: 'estruturação de múltiplos documentos/escopo amplo' };
  }

  if (kind === 'run-config') {
    if (chars <= 3500 && !/docker-compose|monorepo|microservice|workspace/i.test(text)) {
      return { tier: 'simple', reason: 'detecção simples de comando de execução' };
    }
    return { tier: 'standard', reason: 'configuração multi-serviço / full-stack de Play' };
  }

  // Revisão Goldfish ou tarefa de board
  if (prio === 'high' || prio === 'alta' || prio === 'urgent' || chars >= 4500 || (hasComplexSignal && chars >= 1200)) {
    return {
      tier: 'complex',
      reason: prio === 'high' || prio === 'alta'
        ? 'alta prioridade — exige raciocínio profundo'
        : hasComplexSignal
          ? 'escopo arquitetural/segurança/crítico detectado'
          : 'especificação extensa — exige revisão profunda',
    };
  }
  if (kind === 'goldfish-review') {
    return { tier: 'standard', reason: 'revisão fria Goldfish — usa modelo equilibrado (nunca modelo mínimo)' };
  }
  if (chars < 400 && !hasComplexSignal) {
    return { tier: 'simple', reason: 'tarefa curta e delimitada' };
  }
  return { tier: 'standard', reason: 'tarefa de complexidade padrão' };
}

// Mapeia tier EGM para o modelo padrão por motor (sem forçar IDs inválidos em CLIs que usam alias próprio).
function defaultModelForEgmTier(engine, tier = 'standard', { ollamaModels = [] } = {}) {
  if (engine === 'Claude Code') {
    if (tier === 'simple') return 'haiku';
    if (tier === 'complex') return 'opus';
    return 'sonnet';
  }
  if (engine === 'Ollama') {
    return Array.isArray(ollamaModels) && ollamaModels.length ? ollamaModels[0] : '';
  }
  // Gemini (agy) e Codex usam o modelo padrão configurado na conta (ou override explícito em config.dream.models)
  return '';
}

function buildRunConfigPrompt({ project = '', cwd = '', snapshotText = '', detected = null }) {
  const safeSnap = redactSecrets(clip(snapshotText, RUN_SNAPSHOT_MAX_CHARS)).text;
  const detJson = detected ? JSON.stringify(detected, null, 2).slice(0, 2000) : '{}';
  return [
    `Você está configurando o arquivo \`.ai-workspace/run.json\` (botão Play) do projeto "${project}" (${cwd}).`,
    'Analise os arquivos de configuração abaixo e gere o perfil de execução mais adequado para subir o projeto inteiro de forma confiável.',
    '',
    'REGRAS:',
    '1. Responda APENAS com um objeto JSON válido (sem texto fora do JSON) no schema `ai-run` v1.',
    '2. Se o projeto for Full-Stack (Backend + Frontend em pastas separadas ou scripts separados), crie um perfil `"kind": "compound"` com ambos os processos em `"processes"` (Backend primeiro, Frontend depois com `"openUrl": "auto"` ou URL exata se conhecida).',
    '3. Se for um servidor web único (Node, Vite, Next, Python/Flask/Django, Go, etc.), use `"kind": "web"` com `"openUrl": "auto"` ou URL local.',
    '4. Se for um jogo/app gráfico (Godot, Electron, binário desktop), use `"kind": "gui"` e `"gui": true` no processo.',
    '5. Use comandos reais compatíveis com os scripts encontrados nos manifestos (nunca invente scripts inexistentes).',
    '6. Em `"cwd"` de cada processo, use caminho relativo à raiz do projeto (ex.: `"backend"`, `"frontend"`) ou omita para usar a raiz.',
    '',
    'Esquema JSON exato:',
    '{"format":"ai-run","version":1,"defaultProfile":"id-perfil","profiles":[{"id":"id-perfil","name":"Nome amigável","kind":"compound|web|gui|service|script","processes":[{"id":"proc1","name":"Backend","cmd":"npm run dev","cwd":"backend","gui":false,"openUrl":"auto"}]}]}',
    '',
    '--- DETECÇÃO AUTOMÁTICA INICIAL (0-token) ---',
    detJson,
    '',
    '--- ESTRUTURA E MANIFESTOS DO PROJETO ---',
    safeSnap,
  ].join('\n');
}

function parseRunConfigFromAi(raw) {
  const obj = parseJsonPayload(raw);
  if (!obj || !Array.isArray(obj.profiles) || !obj.profiles.length) {
    throw Object.assign(new Error('A IA não retornou um JSON de configuração Play válido.'), { status: 502 });
  }
  return obj;
}

function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function buildSpecTemplate({ title = 'Nova Especificação', summary = '', day = new Date().toISOString().slice(0, 10) } = {}) {
  const cleanTitle = String(title || 'Nova Especificação').trim();
  const cleanSummary = String(summary || '').trim();
  return [
    `# ${cleanTitle}`,
    '',
    `> **Criado em:** ${day}  `,
    '> **Status:** Rascunho (aguardando revisão Goldfish)',
    '',
    '## 1. Objetivo',
    cleanSummary || 'Descreva em 2–3 frases o problema a resolver e o resultado esperado.',
    '',
    '## 2. Escopo (o que entra)',
    '- [ ] Tarefa principal 1',
    '- [ ] Tarefa principal 2',
    '',
    '## 3. Fora de escopo (o que NÃO fazer agora)',
    '- ',
    '',
    '## 4. Arquivos e impactos previstos',
    '- ',
    '',
    '## 5. Critérios de aceite',
    '- [ ] Comportamento validado por teste automatizado ou verificação objetiva',
    '',
  ].join('\n');
}

// Prompt Goldfish único (contexto zero, saída JSON concisa — baixo gasto de tokens).
function buildGoldfishReviewPrompt({ project = '', docPath = '', docContent = '', pinnedMd = '', memoryMd = '' }) {
  const safeDoc = redactSecrets(clip(docContent, SPEC_MAX_CHARS)).text;
  const safeMem = redactSecrets(clip([pinnedMd, memoryMd].filter(Boolean).join('\n\n'), MEMORY_CONTEXT_MAX_CHARS)).text;

  return [
    `Você é um revisor independente "Goldfish" (sem histórico de conversa prévio) avaliando a especificação "${docPath}" do projeto "${project}".`,
    'Seu papel é ler o documento a frio e encontrar APENAS falhas concretas antes da implementação.',
    '',
    'REGRAS:',
    '1. Responda APENAS com um objeto JSON válido (sem texto fora do JSON).',
    '2. Seja extremamente objetivo e econômico: no máximo 4 itens em cada lista, frases curtas (1 linha).',
    '3. "verdict": use "approved" se a spec está clara e pronta para implementar, ou "changes" se houver lacunas/riscos relevantes.',
    '4. "summary": resumo em 1 frase (máx. 160 chars).',
    '5. "gaps": ambiguidades, premissas ocultas ou requisitos faltando para codar sem adivinhar.',
    '6. "risks": riscos técnicos, segurança, regressão ou edge-cases.',
    '7. "cuts": sugestões de simplificação / escopo excessivo para manter a entrega enxuta.',
    '',
    'Esquema JSON exato:',
    '{"verdict":"approved|changes","summary":"...","gaps":["..."],"risks":["..."],"cuts":["..."]}',
    '',
    ...(safeMem ? ['--- REGRAS / MEMÓRIA DO PROJETO (referência curta) ---', safeMem, ''] : []),
    `--- ESPECIFICAÇÃO (${docPath}) ---`,
    safeDoc,
  ].join('\n');
}

function tryJson(str) {
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}

function unwrapCliText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const whole = tryJson(s);
  if (whole) {
    if (whole.verdict || whole.items) return s;
    if (typeof whole.response === 'string') return whole.response;
    if (typeof whole.result === 'string') return whole.result;
  }
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const chunks = [];
  let jsonLines = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    const obj = tryJson(line);
    if (!obj) continue;
    jsonLines++;
    if (obj.verdict || obj.items) return line;
    if (typeof obj.response === 'string') chunks.push(obj.response);
    else if (typeof obj.result === 'string') chunks.push(obj.result);
    else if (typeof obj.text === 'string') chunks.push(obj.text);
    else if (obj.item && typeof obj.item.text === 'string') chunks.push(obj.item.text);
    else if (obj.message && typeof obj.message.content === 'string') chunks.push(obj.message.content);
  }
  return jsonLines > 0 && chunks.length ? chunks.join('\n') : s;
}

function parseJsonPayload(raw) {
  const text = unwrapCliText(raw);
  let obj = tryJson(text);
  if (!obj) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced) obj = tryJson(fenced[1].trim());
  }
  if (!obj) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) obj = tryJson(text.slice(start, end + 1));
  }
  return obj;
}

function cleanList(arr, max = 6) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => redactSecrets(String(x || '').trim()).text)
    .filter(Boolean)
    .slice(0, max);
}

function parseGoldfishReview(raw, { docPath = '', engine = '', usageCompact = '', at = Date.now() } = {}) {
  const obj = parseJsonPayload(raw);
  if (!obj || typeof obj.summary !== 'string') {
    throw Object.assign(new Error('O revisor Goldfish não retornou um JSON válido.'), { status: 502 });
  }
  const verdict = obj.verdict === 'approved' ? 'approved' : 'changes';
  const summary = clip(redactSecrets(obj.summary).text, 240);
  const gaps = cleanList(obj.gaps, 6);
  const risks = cleanList(obj.risks, 6);
  const cuts = cleanList(obj.cuts, 6);

  const stamp = new Date(at).toISOString();
  const badge = verdict === 'approved' ? '✅ APROVADO' : '⚠️ AJUSTES SUGERIDOS';
  const mdLines = [
    `# Revisão Goldfish — \`${docPath}\``,
    '',
    `- **Veredito:** ${badge}`,
    `- **Data:** ${stamp}`,
    ...(engine ? [`- **Motor:** \`${engine}\`${usageCompact ? ` · ${usageCompact}` : ''}`] : []),
    `- **Resumo:** ${summary}`,
    '',
  ];
  if (gaps.length) {
    mdLines.push('## Lacunas / Ambiguidades', ...gaps.map((g) => `- ${g}`), '');
  }
  if (risks.length) {
    mdLines.push('## Riscos / Edge-cases', ...risks.map((r) => `- ${r}`), '');
  }
  if (cuts.length) {
    mdLines.push('## Simplificações sugeridas', ...cuts.map((c) => `- ${c}`), '');
  }
  if (!gaps.length && !risks.length && !cuts.length) {
    mdLines.push('Nenhum bloqueio encontrado. Spec pronta para implementação.', '');
  }

  return {
    verdict,
    summary,
    gaps,
    risks,
    cuts,
    markdown: mdLines.join('\n'),
  };
}

function buildStructureFromDocsPrompt({ project = '', docs = [] }) {
  const perDocMax = Math.max(1200, Math.floor(STRUCTURE_DOCS_MAX_CHARS / Math.max(1, docs.length)));
  const blocks = docs.map((d) => `### Arquivo: ${d.path}\n${redactSecrets(clip(d.content, perDocMax)).text}`);
  return [
    `Você está estruturando o Quadro inicial do projeto "${project}" a partir dos documentos abaixo.`,
    'Crie uma lista enxuta e acionável de tarefas (máx. 15 itens), evitando duplicações e agrupando por fase.',
    '',
    'REGRAS:',
    '1. Responda APENAS com JSON válido no formato exato: {"items":[{"title":"...","body":"...","status":"idea|spec|in-progress|done","phase":"...","docRef":"caminho/arquivo.md"}]}',
    '2. Títulos curtos (≤ 80 chars), corpo objetivo (1–2 linhas).',
    '3. Sempre preencha "docRef" com o caminho exato do arquivo de origem.',
    '',
    '--- DOCUMENTOS DO PROJETO ---',
    blocks.join('\n\n'),
  ].join('\n');
}

function parseStructuredItems(raw) {
  let obj = parseJsonPayload(raw);
  let list = obj && Array.isArray(obj.items) ? obj.items : null;
  if (!list) {
    const text = unwrapCliText(raw);
    const s = text.indexOf('[');
    const e = text.lastIndexOf(']');
    if (s >= 0 && e > s) {
      try {
        const arr = JSON.parse(text.slice(s, e + 1));
        if (Array.isArray(arr)) list = arr;
      } catch {}
    }
  }
  if (!list) {
    throw Object.assign(new Error('O modelo não retornou uma lista JSON válida de itens.'), { status: 502 });
  }
  const out = [];
  for (let i = 0; i < Math.min(list.length, 25); i++) {
    const it = list[i];
    if (!it || typeof it.title !== 'string' || !it.title.trim()) continue;
    const title = clip(redactSecrets(it.title).text, 180);
    out.push({
      id: `ai-${slugifyEntity(title).slice(0, 36)}-${i + 1}`,
      title,
      body: clip(redactSecrets(String(it.body || '')).text, 1000),
      status: ['idea', 'spec', 'in-progress', 'review', 'done'].includes(it.status) ? it.status : 'idea',
      ...(it.phase ? { phase: clip(String(it.phase), 100) } : {}),
      ...(it.docRef ? { docRef: String(it.docRef).replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 300) } : {}),
    });
  }
  return out;
}

function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 4);
}

const QUESTION_OR_BLOCKER_RE = /\b(bloquead[oa]|impedid[oa]|n[ãa]o foi poss[íi]vel|preciso de confirma[çc][ãa]o|aguardando confirma[çc][ãa]o|aguardando decis[ãa]o|qual op[çc][ãa]o|voc[êe] prefere|pode confirmar|erro cr[íi]tico|falhou ao|blocked|need clarification|please confirm)\b/i;
const REVIEW_REJECTION_RE = /\b(reprovad[oa]|n[ãa]o aprovad[oa]|ajustes necess[áa]rios|bloqueio de aceite|mudan[çc]as obrigat[óo]rias|changes requested|rejected)\b/i;

// Portão de evidência para avanço automático de etapa no Board (R18):
// fim de turno isolado (`waiting`/`idle`) não comprova entrega.
function evaluateStageAdvance({ currentStatus = 'idea', nextStatus = '', detail = null, target = null } = {}) {
  if (!nextStatus) return { ok: false, reason: 'Próxima etapa não definida.' };
  if (!detail || typeof detail !== 'object') {
    return { ok: false, reason: 'Detalhes da sessão indisponíveis para validar a entrega.' };
  }
  if (detail.permission) {
    return { ok: false, reason: 'Sessão aguardando decisão de permissão.' };
  }
  if (detail.testRun && detail.testRun.ok === false) {
    return { ok: false, reason: 'Última execução de testes falhou.' };
  }

  const reply = String(detail.lastReply || '').trim();
  if (!reply) {
    return { ok: false, reason: 'Sessão encerrou turno sem resposta final.' };
  }
  if (/^\s*⚠/.test(reply)) {
    return { ok: false, reason: 'Resposta indica aviso ou erro.' };
  }

  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tailLines = lines.slice(-3).join('\n');
  if (lines.length && /\?\s*$/.test(lines[lines.length - 1])) {
    return { ok: false, reason: 'Resposta terminou com pergunta aguardando o usuário.' };
  }
  if (QUESTION_OR_BLOCKER_RE.test(tailLines)) {
    return { ok: false, reason: 'Resposta indica bloqueio ou pedido de confirmação.' };
  }

  const filesObj = detail.files && typeof detail.files === 'object' ? detail.files : {};
  const modifiedFiles = Array.isArray(filesObj) ? filesObj : Object.keys(filesObj);
  const hasMdFile = modifiedFiles.some((f) => /\.md$/i.test(String(f || '')));
  const mentionsMd = /(?:^|[\s`(["'])(?:docs\/[^\s`)"']+\.md|[^\s`)"']*spec[^\s`)"']*\.md)/i.test(reply);
  const hasDocRef = !!(target && target.docRef && String(target.docRef).trim());

  if (currentStatus === 'idea' && nextStatus === 'spec') {
    if (!hasDocRef && !hasMdFile && !mentionsMd) {
      return { ok: false, reason: 'Nenhuma spec/documento .md identificado como evidência.' };
    }
  }

  if (nextStatus === 'review') {
    const hasWorkEvidence = modifiedFiles.length > 0 || !!(detail.testRun && detail.testRun.ok === true) || hasDocRef;
    if (!hasWorkEvidence) {
      return { ok: false, reason: 'Sem evidência de alterações, testes ou documento atualizado para ir para Revisão.' };
    }
  }

  if (nextStatus === 'done') {
    if (target && target.review && target.review.status === 'changes') {
      return { ok: false, reason: 'Revisão ainda indica ajustes pendentes.' };
    }
    if (REVIEW_REJECTION_RE.test(reply)) {
      return { ok: false, reason: 'Resposta relata pendências ou reprovação na revisão.' };
    }
  }

  return { ok: true, reason: '' };
}

module.exports = {
  SPEC_MAX_CHARS,
  MEMORY_CONTEXT_MAX_CHARS,
  STRUCTURE_DOCS_MAX_CHARS,
  RUN_SNAPSHOT_MAX_CHARS,
  classifyEgmComplexity,
  defaultModelForEgmTier,
  buildSpecTemplate,
  buildGoldfishReviewPrompt,
  parseGoldfishReview,
  buildStructureFromDocsPrompt,
  parseStructuredItems,
  buildRunConfigPrompt,
  parseRunConfigFromAi,
  estimateTokens,
  evaluateStageAdvance,
};
