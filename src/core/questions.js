// Perguntas de múltipla escolha: normaliza perguntas estruturadas de ferramentas (AskUserQuestion,
// request_user_input, ask_question) e detecta listas de opções no fim da última resposta em texto.
// Regras puras: sem arquivo, rede ou processo.

const CLEAN_INLINE = /\*\*|__|`/g;
const stripMd = (s) => String(s || '').replace(CLEAN_INLINE, '').replace(/\s+/g, ' ').trim();

function splitLabelDesc(raw) {
  const s = String(raw || '').trim();
  // "**Rótulo** — descrição" ou "**Rótulo**: descrição"
  const bold = /^\*\*([^*]+)\*\*\s*(?:[—–:]|\s+-\s+)\s*(.+)$/.exec(s);
  if (bold) return { label: stripMd(bold[1]), description: stripMd(bold[2]) };
  // "Rótulo — descrição" ou "Rótulo - descrição"
  const dash = /^([^—–\n]{2,80}?)\s+(?:[—–]|-)\s+(.+)$/.exec(s);
  if (dash) return { label: stripMd(dash[1]), description: stripMd(dash[2]) };
  // "Rótulo: descrição" (evita quebrar URLs tipo http://)
  const colon = /^([^:\n]{2,70}?):\s+(.+)$/.exec(s);
  if (colon && !/^https?$/i.test(colon[1].trim())) return { label: stripMd(colon[1]), description: stripMd(colon[2]) };
  return { label: stripMd(s), description: '' };
}

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item === 'string') {
      const { label, description } = splitLabelDesc(item);
      if (label) out.push({ key: String(i + 1), label, description });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rawLabel = String(item.label || item.title || item.text || item.value || '').trim();
    const rawDesc = String(item.description || (item.label && item.text ? item.text : '') || '').trim();
    if (!rawLabel && !rawDesc) continue;
    // Codex request_user_input às vezes usa label="A", text="Descrição completa"
    if (/^[A-Za-z0-9]{1,2}$/.test(rawLabel) && rawDesc) {
      const split = splitLabelDesc(rawDesc);
      out.push({ key: rawLabel.toUpperCase(), label: split.label, description: split.description });
    } else {
      const split = rawDesc ? { label: stripMd(rawLabel), description: stripMd(rawDesc) } : splitLabelDesc(rawLabel);
      out.push({ key: String(i + 1), label: split.label, description: split.description });
    }
  }
  return out;
}

// Normaliza entrada de AskUserQuestion (Claude), request_user_input (Codex) e ask_question (Antigravity)
function normalizeQuestions(input) {
  if (!input || typeof input !== 'object') return [];
  const rawList = Array.isArray(input.questions)
    ? input.questions
    : Array.isArray(input.options)
      ? [{ question: input.question || input.prompt || '', header: input.header || '', multiSelect: !!(input.multiSelect || input.multi_select || input.is_multi_select), options: input.options }]
      : [];
  const out = [];
  for (let i = 0; i < rawList.length; i++) {
    const q = rawList[i];
    if (!q || typeof q !== 'object') continue;
    const options = normalizeOptions(q.options);
    if (options.length < 2) continue;
    out.push({
      id: `q${i}`,
      header: String(q.header || '').trim(),
      question: stripMd(q.question || q.prompt || 'Escolha uma opção'),
      multiSelect: !!(q.multiSelect || q.multi_select || q.is_multi_select),
      options,
    });
  }
  return out;
}

const DECISION_CUE = /\?|qual\b|quais\b|prefere|preferir|escolha|escolher|opç|deseja|quer que|como prefere|como quer|vamos de|seguir com|which\b|choose\b|prefer\b|option|select\b|would you like/i;
const AFTER_OPTION_CUE = /\b(qual|quais|opç(?:ão|ões)|escolha|escolher|prefere|preferir|acima|del[ea]s|alguma|which|choose|prefer|option|options|above|select)\b/i;
const SUMMARY_HEADING_CUE = /\b(o que foi feito|o que mudou|o que entrou|resumo|altera[çc][õo]es|mudan[çc]as|implementad[oa]s?|conclu[ií]d[oa]s?|corrigid[oa]s?|como funciona|como funcionaria|por que|causa|passos|verifica[çc][ãa]o|entreg[au]s?|what was done|what changed|summary|changes|done|implemented|fixed|how it works)\b/i;
const MULTI_CUE = /múltipl|vári[ao]s|mais de uma|uma ou mais|select all|multiple|all that apply/i;

function matchOptionLine(line) {
  const s = line.trim();
  // Remove ênfase apenas em volta do marcador: "**1.** texto" ou "**A)** texto"
  const clean = s.replace(/^\*\*(\d+|[A-Fa-f])([.)])\*\*\s+/, '$1$2 ');
  const num = /^(\d{1,2})[.)]\s+(.+)$/.exec(clean);
  if (num) return { kind: 'num', index: Number(num[1]), key: num[1], body: num[2].trim() };
  const alpha = /^([A-Fa-f])[.)]\s+(.+)$/.exec(clean);
  if (alpha) return { kind: 'alpha', index: alpha[1].toUpperCase().charCodeAt(0) - 64, key: alpha[1].toUpperCase(), body: alpha[2].trim() };
  const optWord = /^(?:Op[çc][ãa]o|Option)\s+(\d+|[A-Fa-f])\s*[:—–-]\s*(.+)$/i.exec(clean);
  if (optWord) {
    const rawKey = optWord[1].toUpperCase();
    const isNum = /^\d+$/.test(rawKey);
    return { kind: isNum ? 'num' : 'alpha', index: isNum ? Number(rawKey) : rawKey.charCodeAt(0) - 64, key: rawKey, body: optWord[2].trim() };
  }
  return null;
}

// Detecta uma pergunta de múltipla escolha escrita em texto/Markdown no final da resposta da IA.
// Exige pista de decisão (? ou palavras-chave) e sequência contígua (1..N ou A..F) de 2 a 6 opções.
function extractTextQuestions(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // Ignora blocos de código para não confundir listas dentro de snippets com opções reais
  const stripped = raw.replace(/```[\s\S]*?```/g, '\n');
  const lines = stripped.split(/\r?\n/);
  const tailStart = Math.max(0, lines.length - 30);

  // Encontra o último bloco sequencial de opções no trecho final
  let best = null;
  let cur = null;
  for (let i = tailStart; i < lines.length; i++) {
    const line = lines[i];
    const m = matchOptionLine(line);
    if (m) {
      if (cur && cur.kind === m.kind && m.index === cur.lastIndex + 1) {
        cur.items.push(m);
        cur.lastIndex = m.index;
        cur.endLine = i;
      } else if (m.index === 1) {
        cur = { kind: m.kind, lastIndex: 1, startLine: i, endLine: i, items: [m] };
      } else {
        cur = null;
      }
      if (cur && cur.items.length >= 2 && cur.items.length <= 6) best = { ...cur, items: cur.items.slice() };
    } else if (line.trim() && cur) {
      // Sublinha indentada (descrição continuação da opção) não quebra o bloco,
      // mas sub-bullets (`- ...`) marcam lista hierárquica de relatório/changelog
      if (/^\s{2,}/.test(line) && cur.items.length) {
        if (/^\s{2,}[-*•]\s+/.test(line)) {
          cur.hasSubBullets = true;
          if (best && best.startLine === cur.startLine) best.hasSubBullets = true;
        }
        const last = cur.items[cur.items.length - 1];
        last.body += ' — ' + line.trim();
        cur.endLine = i;
        if (best && best.startLine === cur.startLine) best.endLine = i;
      } else {
        cur = null;
      }
    }
  }
  if (!best || best.items.length < 2 || best.items.length > 6) return [];

  // Procura pergunta/enunciado imediatamente antes ou depois do bloco de opções
  const before = lines.slice(Math.max(0, best.startLine - 4), best.startLine).map((l) => l.trim()).filter(Boolean);
  // Para de olhar depois do bloco ao encontrar separador estrutural (citação, divisor ou novo título)
  const after = [];
  for (let i = best.endLine + 1; i < Math.min(lines.length, best.endLine + 5); i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^(>|#{1,6}\s|([-*_])\1{2,}$)/.test(t)) break;
    after.push(t);
  }
  const beforeLead = before[before.length - 1] || '';
  const beforeHasCue = DECISION_CUE.test(before.join(' '));
  // Ignora listas de resumo/changelog (ex.: "### O que foi feito\n1. ...\n2. ...")
  if (SUMMARY_HEADING_CUE.test(beforeLead) && !beforeHasCue) return [];
  // Listas com sub-bullets aninhados são quase sempre relatórios/resumos, salvo se precedidas por pergunta explícita
  if (best.hasSubBullets && !beforeHasCue) return [];

  const afterText = after.join(' ');
  const afterHasOptionCue = after.length > 0 && /\?/.test(afterText) && AFTER_OPTION_CUE.test(afterText);
  const optionsText = best.items.map((x) => x.body).join(' ');
  if (!beforeHasCue && !afterHasOptionCue && !/\?/.test(optionsText)) return [];

  // Evita disparar em listas de passos já concluídos sem pergunta real perto
  if (after.length > 3) return [];

  const contextText = [...before, ...after].join(' ');
  const promptLine = after.find((l) => /\?/.test(l)) || before.slice().reverse().find((l) => /\?|:$/.test(l)) || before[before.length - 1] || 'Escolha uma opção';
  const multiSelect = MULTI_CUE.test(contextText);
  const options = best.items.map((x) => {
    const { label, description } = splitLabelDesc(x.body);
    return { key: x.key, label, description };
  }).filter((o) => o.label);
  if (options.length < 2) return [];

  return [{
    id: 'q0',
    header: '',
    question: stripMd(promptLine.replace(/^#+\s*/, '')),
    multiSelect,
    options,
  }];
}

// Sugere 3–4 atalhos contextuais de resposta rápida com base no estado e na última resposta da IA.
// Retorna lista vazia quando já há cartão de múltipla escolha aberto (para não duplicar controles).
function suggestReplies({ lastReply = '', state = '', testFailed = false, hasQuestion = false } = {}) {
  if (hasQuestion) return [];
  if (testFailed) return ['Corrija os testes', 'Explique o erro', 'Rode os testes de novo'];
  if (state === 'working') return ['Resuma ao terminar', 'Rode os testes depois', 'Pare após este passo'];

  const raw = String(lastReply || '').trim();
  if (!raw) return ['Continue', 'Rode os testes', 'Resuma', 'Faça o commit'];
  const tail = raw.replace(/```[\s\S]*?```/g, ' ').slice(-900);

  const asksConfirm = /\b(quer que|posso|deseja que|vamos|aprova|confirma|gostaria que|devo|posso seguir|should i|want me to|shall i|go ahead|proceed)\b/i.test(tail);
  const hasQuestionMark = /\?/.test(tail);
  const mentionsGit = /\b(commit|commitar|push|github|branch|pull request|\bpr\b|subir)\b/i.test(tail);
  const mentionsPlan = /\b(proposta|plano|implementar|implemente|aplicar|alterar|refatorar|abordagem)\b/i.test(tail);
  const mentionsTests = /\b(testes?|npm test|pytest|mvn test|vitest|jest)\b/i.test(tail);
  const testsPassing = /\b(testes?\s+passando|todos os testes|passou|passing|all tests pass|fail 0)\b/i.test(tail);
  const mentionsDone = /\b(pronto|implementad[oa]|conclu[ií]d[oa]|altera[çc][õo]es|corrigid[oa]|criad[oa]|atualizad[oa]|aplicad[oa]|done|implemented|fixed|updated)\b/i.test(tail);
  const mentionsError = /\b(erro|falha|falhou|n[ãa]o encontr|expirou|expirada|bloquead[oa]|exception|failed|error)\b/i.test(tail);

  if ((asksConfirm || hasQuestionMark) && mentionsGit) return ['Faça o commit', 'Commit e push', 'Mostre o diff antes', 'Ainda não'];
  if ((asksConfirm || hasQuestionMark) && mentionsPlan) return ['Sim, implemente', 'Ajuste a proposta', 'Explique melhor', 'Não faça ainda'];
  if ((asksConfirm || hasQuestionMark) && mentionsTests && !testsPassing) return ['Sim, rode os testes', 'Continue', 'Não precisa agora'];
  if (asksConfirm && hasQuestionMark) return ['Sim, pode fazer', 'Não, espere', 'Explique melhor'];
  if (mentionsDone && testsPassing) return ['Faça o commit', 'Commit e push', 'Resuma as mudanças', 'Próximo passo'];
  if (mentionsError) return ['Tente outra abordagem', 'Explique a causa', 'Corrija isso'];
  if (mentionsDone) return ['Rode os testes', 'Mostre o diff', 'Faça o commit', 'Resuma'];
  if (hasQuestionMark) return ['Sim', 'Não', 'Você decide (recomendado)', 'Explique as opções'];
  return ['Continue', 'Rode os testes', 'Resuma', 'Faça o commit'];
}

module.exports = { normalizeQuestions, extractTextQuestions, splitLabelDesc, suggestReplies };
