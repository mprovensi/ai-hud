// Esquema e validação pura de `workspace.json` e cards editáveis `*.card.json` (camada core: sem I/O).
const { isSafeRelativePath } = require('./path-guard');

const WORKSPACE_FORMAT = 'ai-workspace';
const WORKSPACE_VERSION = 1;
const CARD_FORMAT = 'ai-card';
const CARD_VERSION = 1;
const CARD_MAX_BYTES = 1024 * 1024;
const CARD_MAX_ITEMS = 200;
const CARD_TEMPLATES = Object.freeze(['board', 'research', 'gallery']);
const CARD_STATUSES = Object.freeze(['idea', 'in-progress', 'review', 'done']);
const ENTITY_CATEGORIES = Object.freeze(['dev', 'project', 'research', 'ops', 'creative', 'general']);
const ENTITY_STATUSES = Object.freeze(['active', 'paused', 'archived']);
const STEP_VIEWERS = Object.freeze(['card', 'markdown', 'html']);

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertKeys(obj, allowed, label) {
  if (!isPlainObj(obj)) throw fail(`${label} deve ser um objeto JSON.`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw fail(`${label} possui campo não suportado: "${k}".`);
  }
}

function assertText(v, label, max, required = false) {
  if (v === undefined && !required) return;
  if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || /\u0000/.test(v)) {
    throw fail(`${label} deve ser texto${required ? ' não vazio' : ''} de até ${max} caracteres.`);
  }
}

function safeHttpUrl(v) {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 2000) throw fail('URL de referência inválida.');
  try {
    const u = new URL(v);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      throw fail('URL de referência deve usar http:// ou https:// sem credenciais.');
    }
    return u.href;
  } catch (e) {
    if (e.status === 400) throw e;
    throw fail('URL de referência inválida.');
  }
}

function slugifyEntity(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'projeto';
}

function validateCard(value, { draft = false } = {}) {
  assertKeys(value, ['format', 'version', 'template', 'title', 'summary', 'items'], 'O card');
  if (value.format !== CARD_FORMAT || value.version !== CARD_VERSION) {
    throw fail(`Formato de card incompatível (esperado ${CARD_FORMAT} v${CARD_VERSION}).`);
  }
  if (!CARD_TEMPLATES.includes(value.template)) {
    throw fail(`Template inválido. Use: ${CARD_TEMPLATES.join(', ')}.`);
  }
  assertText(value.title, 'Título do card', 200, !draft);
  if (typeof value.title !== 'string') throw fail('Informe o título do card.');
  assertText(value.summary, 'Resumo do card', 20000);
  if (!Array.isArray(value.items) || value.items.length > CARD_MAX_ITEMS) {
    throw fail(`Um card aceita no máximo ${CARD_MAX_ITEMS} itens.`);
  }
  const seen = new Set();
  for (const item of value.items) {
    assertKeys(
      item,
      ['id', 'title', 'body', 'image', 'alt', 'prompt', 'url', 'linkLabel', 'status', 'sessionRef', 'handoffPath'],
      'Um item do card',
    );
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id) || seen.has(item.id)) {
      throw fail('Cada item precisa de um ID único (letras, números, hífen ou underscore).');
    }
    seen.add(item.id);
    assertText(item.title, 'Título do item', 200, !draft);
    assertText(item.body, 'Conteúdo do item', 30000);
    assertText(item.alt, 'Texto alternativo da imagem', 300);
    assertText(item.prompt, 'Prompt salvo', 8000);
    assertText(item.linkLabel, 'Rótulo do link', 120);
    if (item.image !== undefined && item.image !== '' && !isSafeRelativePath(item.image)) {
      throw fail(`Caminho de imagem inválido no item "${item.id}".`);
    }
    if (item.handoffPath !== undefined && item.handoffPath !== '' && !isSafeRelativePath(item.handoffPath)) {
      throw fail(`Caminho de handoff inválido no item "${item.id}".`);
    }
    if (item.url !== undefined && item.url !== '' && !draft) safeHttpUrl(item.url);
    if (item.status !== undefined && item.status !== '' && !CARD_STATUSES.includes(item.status)) {
      throw fail(`Status inválido no item "${item.id}". Use: ${CARD_STATUSES.join(', ')}.`);
    }
    if (item.sessionRef !== undefined && item.sessionRef !== null) {
      assertKeys(item.sessionRef, ['machine', 'id', 'tool'], 'sessionRef');
      assertText(item.sessionRef.id, 'sessionRef.id', 120, true);
      assertText(item.sessionRef.machine, 'sessionRef.machine', 80);
      assertText(item.sessionRef.tool, 'sessionRef.tool', 40);
    }
  }
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > CARD_MAX_BYTES) throw fail('O card excede o limite de 1 MB.');
  return value;
}

function validateWorkspaceIndex(value) {
  assertKeys(value, ['format', 'version', 'groups', 'entities'], 'workspace.json');
  if (value.format !== WORKSPACE_FORMAT || value.version !== WORKSPACE_VERSION) {
    throw fail(`Formato de workspace.json incompatível (esperado ${WORKSPACE_FORMAT} v${WORKSPACE_VERSION}).`);
  }
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > 100) {
      throw fail('workspace.json precisa de um array "groups" válido.');
    }
    for (const g of value.groups) assertText(g, 'Nome do workspace/grupo', 80, true);
  }
  if (!Array.isArray(value.entities) || value.entities.length > 500) {
    throw fail('workspace.json precisa de um array "entities" válido.');
  }
  const seen = new Set();
  for (const e of value.entities) {
    assertKeys(
      e,
      ['id', 'title', 'description', 'group', 'category', 'status', 'pinned', 'folder', 'projectBindings', 'defaultAgent', 'steps', 'created', 'updated'],
      'Entidade do workspace',
    );
    if (typeof e.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(e.id) || seen.has(e.id)) {
      throw fail('Cada entidade precisa de um ID único.');
    }
    seen.add(e.id);
    assertText(e.title, 'Título da entidade', 200, true);
    assertText(e.description, 'Descrição da entidade', 1000);
    assertText(e.group, 'Grupo/Workspace da entidade', 80);
    if (e.category && !ENTITY_CATEGORIES.includes(e.category)) throw fail(`Categoria inválida: "${e.category}".`);
    if (e.status && !ENTITY_STATUSES.includes(e.status)) throw fail(`Status inválido: "${e.status}".`);
    if (!isSafeRelativePath(e.folder)) throw fail(`Pasta inválida na entidade "${e.id}".`);
    if (e.projectBindings !== undefined) {
      if (!Array.isArray(e.projectBindings)) throw fail('projectBindings deve ser uma lista.');
      for (const b of e.projectBindings) {
        assertKeys(b, ['machine', 'cwd'], 'projectBinding');
        assertText(b.machine, 'projectBinding.machine', 80, true);
        assertText(b.cwd, 'projectBinding.cwd', 500, true);
      }
    }
    if (!Array.isArray(e.steps)) throw fail(`steps inválido na entidade "${e.id}".`);
    for (const st of e.steps) {
      assertKeys(st, ['name', 'path', 'viewer'], 'Step da entidade');
      assertText(st.name, 'Nome da aba', 120, true);
      if (!isSafeRelativePath(st.path)) throw fail(`Caminho inválido na aba "${st.name}".`);
      if (st.viewer && !STEP_VIEWERS.includes(st.viewer)) throw fail(`Viewer inválido: "${st.viewer}".`);
    }
  }
  return value;
}

function defaultWorkspaceIndex() {
  return { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, entities: [] };
}

function defaultCard({ title, template = 'board', summary = '' }) {
  return {
    format: CARD_FORMAT,
    version: CARD_VERSION,
    template: CARD_TEMPLATES.includes(template) ? template : 'board',
    title: String(title || 'Novo card').trim().slice(0, 200),
    summary: String(summary || '').slice(0, 20000),
    items: [],
  };
}

module.exports = {
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  CARD_FORMAT,
  CARD_VERSION,
  CARD_MAX_BYTES,
  CARD_MAX_ITEMS,
  CARD_TEMPLATES,
  CARD_STATUSES,
  ENTITY_CATEGORIES,
  ENTITY_STATUSES,
  slugifyEntity,
  validateCard,
  validateWorkspaceIndex,
  defaultWorkspaceIndex,
  defaultCard,
};
