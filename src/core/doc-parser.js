// Parser puro (sem I/O, 0 tokens) para classificar documentos Markdown de um projeto e extrair itens de Quadro (camada core/).
const { slugifyEntity } = require('./workspace-schema');

const DOC_CATEGORIES = Object.freeze(['plan', 'spec', 'review', 'doc']);

function normalizeRel(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function classifyProjectDoc(relPath) {
  const norm = normalizeRel(relPath).toLowerCase();
  const base = norm.split('/').pop() || norm;
  if (norm.startsWith('.ai-workspace/reviews/')) return 'review';
  if (
    norm.startsWith('docs/specs/')
    || norm.startsWith('docs/designs/')
    || /(?:^|[-_/])(spec|especifica|design|arquitetura|architecture|rfc|adr)(?:[-_./]|$)/.test(norm)
  ) {
    return 'spec';
  }
  if (
    /(?:^|[-_/])(plano|plan|roadmap|melhoria|melhorias|todo|backlog|sprint|fase|tasks?|tarefas?)(?:[-_./]|$)/.test(norm)
  ) {
    return 'plan';
  }
  if (base === 'readme.md') return 'doc';
  return 'doc';
}

function extractDocTitle(markdown, fallbackName = '') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines.slice(0, 25)) {
    const m = /^#\s+(.+?)\s*$/.exec(line.trim());
    if (m) return m[1].replace(/[*`#]/g, '').trim().slice(0, 140);
  }
  return String(fallbackName || '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'Documento';
}

function cleanTaskTitle(raw) {
  let s = String(raw || '').trim();
  // Remove marcações simples mantendo legibilidade
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= 140) return { title: s, extraBody: '' };
  // Divide título curto + detalhes no corpo se a linha for muito longa
  const cut = s.indexOf(':');
  if (cut > 12 && cut <= 110) {
    return { title: s.slice(0, cut).trim(), extraBody: s.slice(cut + 1).trim() };
  }
  return { title: s.slice(0, 136).trimEnd() + '…', extraBody: s };
}

function extractItemsFromMarkdown(markdown, { docPath = '', maxItems = 60 } = {}) {
  const rel = normalizeRel(docPath);
  const category = classifyProjectDoc(rel);
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const docTitle = extractDocTitle(markdown, rel.split('/').pop());

  let inFence = false;
  let currentPhase = '';
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const hMatch = /^(#{2,3})\s+(.+?)\s*$/.exec(line.trim());
    if (hMatch) {
      currentPhase = hMatch[2].replace(/[*`#]/g, '').trim().slice(0, 100);
      continue;
    }

    const cbMatch = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (cbMatch) {
      const done = cbMatch[1].toLowerCase() === 'x';
      const { title, extraBody } = cleanTaskTitle(cbMatch[2]);
      if (!title) continue;
      const lineNo = i + 1;
      const docRef = rel ? `${rel}#L${lineNo}` : '';
      const baseSlug = slugifyEntity(title).slice(0, 36);
      const id = `doc-${baseSlug}-${lineNo}`.slice(0, 78);
      items.push({
        id,
        title,
        body: extraBody || (currentPhase ? `Importado de \`${rel}\` (${currentPhase}).` : `Importado de \`${rel}\`.`),
        status: done ? 'done' : (category === 'spec' ? 'spec' : 'idea'),
        ...(docRef ? { docRef } : {}),
        ...(currentPhase ? { phase: currentPhase } : {}),
      });
      if (items.length >= maxItems) break;
    }
  }

  // Fallback: se o documento é um plano ou spec sem checkboxes, gera 1 item por seção de plano/spec ou 1 card para o doc inteiro
  if (!items.length && (category === 'plan' || category === 'spec')) {
    const sections = [];
    inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = /^##\s+(.+?)\s*$/.exec(line.trim());
      if (m) {
        const sec = m[1].replace(/[*`#]/g, '').trim();
        if (/^(fase|etapa|sprint|melhoria|passo|objetivo|feature|módulo|modulo|entrega|item|\d+\.)/i.test(sec)) {
          sections.push({ title: sec.slice(0, 140), lineNo: i + 1 });
        }
      }
    }
    if (sections.length >= 2 && sections.length <= 20) {
      for (const s of sections) {
        const docRef = rel ? `${rel}#L${s.lineNo}` : '';
        items.push({
          id: `sec-${slugifyEntity(s.title).slice(0, 36)}-${s.lineNo}`.slice(0, 78),
          title: s.title,
          body: `Seção de \`${rel}\` (${docTitle}).`,
          status: category === 'spec' ? 'spec' : 'idea',
          ...(docRef ? { docRef } : {}),
          phase: docTitle.slice(0, 100),
        });
      }
    } else if (rel) {
      items.push({
        id: `doc-${slugifyEntity(docTitle).slice(0, 44)}`.slice(0, 78),
        title: docTitle,
        body: `Documento vinculado: \`${rel}\`.`,
        status: category === 'spec' ? 'spec' : 'idea',
        docRef: rel,
      });
    }
  }

  return {
    docPath: rel,
    title: docTitle,
    category,
    items,
  };
}

function mergeImportedItems(existingItems, candidates, { maxTotal = 200 } = {}) {
  const out = Array.isArray(existingItems) ? existingItems.slice() : [];
  const usedIds = new Set(out.map((i) => i.id));
  const seenKey = new Set(out.map((i) => `${(i.docRef || '').toLowerCase()}|${(i.title || '').trim().toLowerCase()}`));
  const seenTitles = new Set(out.map((i) => (i.title || '').trim().toLowerCase()));

  const added = [];
  for (const c of candidates || []) {
    if (out.length >= maxTotal) break;
    const normTitle = String(c.title || '').trim().toLowerCase();
    if (!normTitle) continue;
    const key = `${String(c.docRef || '').toLowerCase()}|${normTitle}`;
    if (seenKey.has(key) || seenTitles.has(normTitle)) continue;

    let id = String(c.id || `imp-${slugifyEntity(c.title)}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70) || 'imp-item';
    if (!/^[a-zA-Z0-9]/.test(id)) id = `i-${id}`;
    let n = 2;
    const base = id;
    while (usedIds.has(id)) { id = `${base.slice(0, 72)}-${n++}`; }

    const item = {
      id,
      title: String(c.title).trim().slice(0, 200),
      body: String(c.body || '').slice(0, 30000),
      status: ['idea', 'spec', 'in-progress', 'review', 'done'].includes(c.status) ? c.status : 'idea',
      ...(c.docRef ? { docRef: String(c.docRef).slice(0, 400) } : {}),
      ...(c.phase ? { phase: String(c.phase).slice(0, 120) } : {}),
    };
    usedIds.add(id);
    seenKey.add(key);
    seenTitles.add(normTitle);
    out.push(item);
    added.push(item);
  }
  return { items: out, added };
}

// Atualiza `- [ ]` <-> `- [x]` em um documento Markdown preservando todo o restante do arquivo.
// Tenta primeiro na linha `lineNo` (± 3 linhas de tolerância) e, se o arquivo mudou de tamanho, busca pelo título da tarefa.
function toggleMarkdownCheckbox(markdown, { lineNo = 0, title = '', done = true } = {}) {
  const raw = String(markdown || '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const cbRe = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;
  const targetTitle = cleanTaskTitle(title).title.toLowerCase();

  let hitIdx = -1;
  if (Number.isInteger(lineNo) && lineNo >= 1 && lineNo <= lines.length) {
    const offsets = [0, -1, 1, -2, 2, -3, 3];
    for (const off of offsets) {
      const idx = lineNo - 1 + off;
      if (idx < 0 || idx >= lines.length) continue;
      const m = cbRe.exec(lines[idx]);
      if (!m) continue;
      const cleaned = cleanTaskTitle(m[4]).title.toLowerCase();
      if (!targetTitle || cleaned === targetTitle || cleaned.includes(targetTitle) || targetTitle.includes(cleaned)) {
        hitIdx = idx;
        break;
      }
    }
    // Se lineNo exata é um checkbox mesmo com texto levemente editado
    if (hitIdx < 0 && cbRe.test(lines[lineNo - 1])) hitIdx = lineNo - 1;
  }

  if (hitIdx < 0 && targetTitle) {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = cbRe.exec(lines[i]);
      if (!m) continue;
      const cleaned = cleanTaskTitle(m[4]).title.toLowerCase();
      if (cleaned === targetTitle || cleaned.includes(targetTitle) || targetTitle.includes(cleaned)) {
        hitIdx = i;
        break;
      }
    }
  }

  if (hitIdx < 0) {
    return { matched: false, changed: false, lineNo: 0, content: raw };
  }

  const m = cbRe.exec(lines[hitIdx]);
  const currentDone = m[2].toLowerCase() === 'x';
  const nextMark = done ? 'x' : ' ';
  if (currentDone === !!done) {
    return { matched: true, changed: false, lineNo: hitIdx + 1, content: raw };
  }
  lines[hitIdx] = `${m[1]}${nextMark}${m[3]}${m[4]}`;
  return {
    matched: true,
    changed: true,
    lineNo: hitIdx + 1,
    content: lines.join(eol),
  };
}

module.exports = {
  DOC_CATEGORIES,
  classifyProjectDoc,
  extractDocTitle,
  extractItemsFromMarkdown,
  mergeImportedItems,
  toggleMarkdownCheckbox,
};
