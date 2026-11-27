// Sessão compartilhada entre IAs (camada core: regras puras, sem I/O).
// A sessão é um registro próprio do AI HUD, independente da IA; a IA é só o "motorista" atual.
// Todo texto que entra é mascarado por redactSecrets e limitado em tamanho (orçamento de tokens).
const { redactSecrets } = require('./redact');

const SESSION_FORMAT = 'ai-hud-session';
const SESSION_ID_RE = /^s-[a-z0-9-]{4,60}$/;
const LIMITS = Object.freeze({
  goal: 600,
  summary: 4000,
  item: 500,
  listItems: 50,
  files: 100,
  links: 30,
  natives: 30,
  timeline: 200,
});
const PUBLISH_KINDS = Object.freeze(['decision', 'pitfall', 'episodic']);

function clean(text, max) {
  const s = redactSecrets(String(text == null ? '' : text)).text.replace(/\r\n/g, '\n').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function cleanTool(tool) {
  return clean(tool, 40) || 'desconhecida';
}

function isValidSessionId(id) {
  return SESSION_ID_RE.test(String(id || ''));
}

function newSessionId(now, randomHex) {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  return `s-${day}-${String(randomHex).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
}

// Mantém os N mais recentes sem duplicar (comparação exata após limpeza).
function appendCapped(list, additions, max, itemMax) {
  const out = Array.isArray(list) ? list.slice() : [];
  for (const raw of [].concat(additions || [])) {
    const v = clean(raw, itemMax);
    if (!v) continue;
    const i = out.indexOf(v);
    if (i >= 0) out.splice(i, 1);
    out.push(v);
  }
  return out.slice(-max);
}

function pushEvent(record, event) {
  const timeline = (record.timeline || []).concat([event]);
  return timeline.slice(-LIMITS.timeline);
}

function createSessionRecord({ id, cwd, project, goal = '', tool, model = '', nativeSessionId = '', now }) {
  const driver = { tool: cleanTool(tool), model: clean(model, 80), since: now };
  return {
    format: SESSION_FORMAT,
    version: 1,
    id,
    rev: 1,
    cwd,
    project,
    goal: clean(goal, LIMITS.goal),
    status: 'active',
    driver,
    natives: nativeSessionId ? [clean(nativeSessionId, 120)] : [],
    summary: '',
    files: [],
    decisions: [],
    pending: [],
    links: [],
    timeline: [{ at: now, tool: driver.tool, type: 'create', text: clean(goal, 200) }],
    createdAt: now,
    updatedAt: now,
  };
}

// Aplica uma atualização incremental. Retorna { record } ou { error }.
function applySessionUpdate(record, patch = {}, now) {
  const tool = cleanTool(patch.tool || (record.driver && record.driver.tool));
  const next = { ...record };
  const notes = [];

  if (patch.summary !== undefined) { next.summary = clean(patch.summary, LIMITS.summary); notes.push('resumo'); }
  if (patch.goal !== undefined) { next.goal = clean(patch.goal, LIMITS.goal); notes.push('objetivo'); }
  if (patch.addFiles) { next.files = appendCapped(record.files, patch.addFiles, LIMITS.files, 300); notes.push('arquivos'); }
  if (patch.addDecisions) { next.decisions = appendCapped(record.decisions, patch.addDecisions, LIMITS.listItems, LIMITS.item); notes.push('decisões'); }
  if (patch.addPending) { next.pending = appendCapped(next.pending, patch.addPending, LIMITS.listItems, LIMITS.item); notes.push('pendências'); }
  if (patch.resolvePending) {
    const done = new Set([].concat(patch.resolvePending).map((p) => clean(p, LIMITS.item)));
    next.pending = (next.pending || []).filter((p) => !done.has(p));
    notes.push('pendências resolvidas');
  }
  if (patch.addNative) next.natives = appendCapped(record.natives, patch.addNative, LIMITS.natives, 120);
  if (patch.status !== undefined) {
    if (!['active', 'closed'].includes(patch.status)) return { error: 'status deve ser "active" ou "closed".' };
    next.status = patch.status;
    notes.push(`status=${patch.status}`);
  }

  const text = clean(patch.note, LIMITS.item) || (notes.length ? `atualizou ${notes.join(', ')}` : '');
  if (text) next.timeline = pushEvent(record, { at: now, tool, type: 'update', text });
  next.rev = (record.rev || 0) + 1;
  next.updatedAt = now;
  return { record: next };
}

function applyHandoff(record, { fromTool = '', toTool, toModel = '', note = '' }, now) {
  if (!String(toTool || '').trim()) return { error: 'Informe a IA de destino (toTool).' };
  const from = cleanTool(fromTool || (record.driver && record.driver.tool));
  const to = cleanTool(toTool);
  const text = `handoff ${from} → ${to}${note ? `: ${clean(note, 300)}` : ''}`;
  return {
    record: {
      ...record,
      status: 'active',
      driver: { tool: to, model: clean(toModel, 80), since: now },
      timeline: pushEvent(record, { at: now, tool: from, type: 'handoff', text }),
      rev: (record.rev || 0) + 1,
      updatedAt: now,
    },
  };
}

function applyLink(record, { otherId, note = '', tool = '' }, now) {
  if (!isValidSessionId(otherId) || otherId === record.id) return { error: 'otherId inválido.' };
  const links = (record.links || []).filter((l) => l.id !== otherId).concat([{ id: otherId, note: clean(note, 200) }]).slice(-LIMITS.links);
  return {
    record: {
      ...record,
      links,
      timeline: pushEvent(record, { at: now, tool: cleanTool(tool || (record.driver && record.driver.tool)), type: 'link', text: `vinculou ${otherId}` }),
      rev: (record.rev || 0) + 1,
      updatedAt: now,
    },
  };
}

// Visão compacta para listagem.
function sessionBrief(record) {
  return {
    id: record.id,
    status: record.status,
    goal: record.goal,
    driver: record.driver && record.driver.tool,
    rev: record.rev,
    pending: (record.pending || []).length,
    updatedAt: record.updatedAt,
  };
}

// Pacote de handoff: formato único em Markdown (qualquer IA lê), compacto e sanitizado.
function buildSessionPackage(record, { maxEvents = 12 } = {}) {
  const L = [];
  L.push(`# Sessão compartilhada AI HUD — ${record.project || record.id}`);
  L.push('');
  L.push(`- **Id:** \`${record.id}\` (rev ${record.rev}) · **Status:** ${record.status}`);
  L.push(`- **Pasta:** \`${record.cwd}\``);
  if (record.driver) L.push(`- **IA atual:** ${record.driver.tool}${record.driver.model ? ` (${record.driver.model})` : ''}`);
  L.push('');
  L.push('## Objetivo');
  L.push(record.goal || '(não informado)');
  if (record.summary) { L.push(''); L.push('## Estado atual'); L.push(record.summary); }
  const section = (title, items, fmt = (x) => `- ${x}`) => {
    if (!items || !items.length) return;
    L.push('');
    L.push(`## ${title}`);
    for (const it of items) L.push(fmt(it));
  };
  section('Próximos passos / pendências', record.pending, (x) => `- [ ] ${x}`);
  section('Decisões', (record.decisions || []).slice(-15));
  section('Arquivos tocados', (record.files || []).slice(-25), (x) => `- \`${x}\``);
  section('Sessões vinculadas', record.links, (l) => `- \`${l.id}\`${l.note ? ` — ${l.note}` : ''}`);
  section('Linha do tempo (recente)', (record.timeline || []).slice(-maxEvents),
    (e) => `- ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} · ${e.tool} · ${e.type}${e.text ? `: ${e.text}` : ''}`);
  L.push('');
  L.push(`> Atualize esta sessão com \`session_update\` (cwd + id + expectedRev=${record.rev}) e publique fatos duráveis com \`session_publish\`.`);
  return redactSecrets(L.join('\n')).text + '\n';
}

function formatPublishLine({ text, tool, sessionId, now }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const origin = [cleanTool(tool), sessionId].filter(Boolean).join(' · ');
  return `- [${day}] (${origin}) ${clean(text, 1000).replace(/\n+/g, ' ')}`;
}

module.exports = {
  SESSION_FORMAT,
  PUBLISH_KINDS,
  LIMITS,
  isValidSessionId,
  newSessionId,
  createSessionRecord,
  applySessionUpdate,
  applyHandoff,
  applyLink,
  sessionBrief,
  buildSessionPackage,
  formatPublishLine,
};
