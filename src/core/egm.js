// Regras puras do workflow EGM Lite (Elephant-Goldfish Model simplificado e econômico em tokens — camada core: sem I/O).
const { redactSecrets } = require('./redact');
const { slugifyEntity } = require('./workspace-schema');

const SPEC_MAX_CHARS = 12000;
const MEMORY_CONTEXT_MAX_CHARS = 3500;
const STRUCTURE_DOCS_MAX_CHARS = 14000;

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
    if (typeof obj.result === 'string') chunks.push(obj.result);
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
  const obj = parseJsonPayload(raw);
  if (!obj || !Array.isArray(obj.items)) {
    throw Object.assign(new Error('O modelo não retornou uma lista JSON válida de itens.'), { status: 502 });
  }
  const out = [];
  for (let i = 0; i < Math.min(obj.items.length, 25); i++) {
    const it = obj.items[i];
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

module.exports = {
  SPEC_MAX_CHARS,
  MEMORY_CONTEXT_MAX_CHARS,
  STRUCTURE_DOCS_MAX_CHARS,
  buildSpecTemplate,
  buildGoldfishReviewPrompt,
  parseGoldfishReview,
  buildStructureFromDocsPrompt,
  parseStructuredItems,
  estimateTokens,
};
