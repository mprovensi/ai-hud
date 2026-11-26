#!/usr/bin/env node
// Micro-servidor MCP (stdio, JSON-RPC 2.0, zero dependências externas) para busca na memória
// compartilhada e no AI Workspace sob demanda (Claude Code, Codex, Antigravity).
//
// Ferramentas expostas:
// - memory_search(query, project?, limit?): busca textual em MEMORY.md, decisions.md, pitfalls.md,
//   pinned.md, episodic/*.md e docs do AI Workspace.
// - memory_read(project, file?): lê um arquivo específico da memória do projeto.
// - workspace_list(): lista projetos/entidades do Workspace e projetos com memória compartilhada.
// - board_read(cwd, status?): lê visão compacta de <cwd>/.ai-workspace/board.card.json (baixo custo de tokens).
// - board_update_status(cwd, updates, syncDocs?): atualiza status de tarefas no board com backup e sync `- [x]` em docs/.
// - board_add_item(cwd, title, ...): adiciona novo item válido ao board com backup prévio.

const fs = require('fs');
const path = require('path');

function resolveWorkspaceRoot() {
  if (process.env.AI_WORKSPACE_ROOT) return path.resolve(process.env.AI_WORKSPACE_ROOT);
  const repoRoot = path.resolve(__dirname, '..', '..');
  const dataDir = process.env.AI_HUD_DATA_DIR || path.join(repoRoot, 'data');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    if (cfg && cfg.workspaceRoot) return path.resolve(cfg.workspaceRoot);
    if (cfg && cfg.workspaceDir) return path.resolve(cfg.workspaceDir);
  } catch {}
  return path.join(dataDir, 'workspace');
}

function isWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function walkMarkdownFiles(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdownFiles(full, out, depth + 1);
    else if (e.isFile() && /\.(md|txt|json)$/i.test(e.name) && e.name !== 'dream-state.json') out.push(full);
  }
  return out;
}

function searchMemory(wsRoot, { query = '', project = '', limit = 10 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return { error: 'Informe ao menos um termo de busca (mínimo 2 caracteres).' };
  const maxResults = Math.max(1, Math.min(30, Number(limit) || 10));

  const roots = [];
  const memRoot = path.join(wsRoot, 'memory');
  if (project) {
    const slug = String(project).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    const projDir = path.join(memRoot, slug);
    if (isWithin(memRoot, projDir) && fs.existsSync(projDir)) roots.push(projDir);
  } else {
    if (fs.existsSync(memRoot)) roots.push(memRoot);
    for (const sub of ['context', 'knowledge', 'entities']) {
      const p = path.join(wsRoot, sub);
      if (fs.existsSync(p)) roots.push(p);
    }
  }

  const hits = [];
  for (const dir of roots) {
    for (const file of walkMarkdownFiles(dir)) {
      let text = '';
      try {
        const st = fs.statSync(file);
        if (st.size > 512 * 1024) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      const lines = text.split(/\r?\n/);
      const lower = text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lower.includes(term)) score += 2;
        if (path.basename(file).toLowerCase().includes(term)) score += 3;
      }
      if (!score) continue;

      const snippets = [];
      for (let i = 0; i < lines.length && snippets.length < 3; i++) {
        const ll = lines[i].toLowerCase();
        if (terms.some((t) => ll.includes(t))) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          snippets.push(`L${i + 1}: ${lines.slice(start, end).join(' ').replace(/\s+/g, ' ').slice(0, 260)}`);
        }
      }
      hits.push({
        file: path.relative(wsRoot, file).replace(/\\/g, '/'),
        score: score + snippets.length,
        snippets,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return { workspaceRoot: wsRoot, query, total: hits.length, results: hits.slice(0, maxResults) };
}

function readMemoryFile(wsRoot, { project = '', file = 'MEMORY.md' } = {}) {
  const slug = String(project || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return { error: 'Informe o slug do projeto.' };
  const rel = String(file || 'MEMORY.md').replace(/\\/g, '/').replace(/^\/+/, '');
  const projDir = path.join(wsRoot, 'memory', slug);
  const target = path.resolve(projDir, rel);
  if (!isWithin(projDir, target)) return { error: 'Caminho fora da pasta de memória do projeto.' };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return { error: `Arquivo não encontrado: memory/${slug}/${rel}` };
  }
  const content = fs.readFileSync(target, 'utf8');
  return { project: slug, file: rel, content: content.slice(0, 40000), truncated: content.length > 40000 };
}

function listWorkspace(wsRoot) {
  let entities = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(wsRoot, 'workspace.json'), 'utf8'));
    entities = (idx.entities || []).map((e) => ({ id: e.id, title: e.title, pinned: !!e.pinned, bindings: e.projectBindings || [] }));
  } catch {}
  let memoryProjects = [];
  try {
    memoryProjects = fs.readdirSync(path.join(wsRoot, 'memory'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {}
  return { workspaceRoot: wsRoot, entities, memoryProjects };
}

const VALID_BOARD_STATUSES = new Set(['idea', 'spec', 'in-progress', 'review', 'done']);

function resolveBoardFile(cwd) {
  const clean = String(cwd || '').trim();
  if (!clean) return { error: 'Informe o caminho da pasta do projeto (cwd).' };
  const abs = path.resolve(clean);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { error: `Pasta do projeto não encontrada: ${abs}` };
  }
  return { root: abs, boardFile: path.join(abs, '.ai-workspace', 'board.card.json') };
}

function backupAndWriteBoard(projectRoot, boardFile, obj) {
  const backupDir = path.join(projectRoot, '.ai-workspace', 'backups', 'cards');
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(boardFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(boardFile, path.join(backupDir, `${stamp}_board.card.json.bak`)); } catch {}
  }
  const tmp = `${boardFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, boardFile);
}

function syncMarkdownCheckboxStandalone(projectRoot, docRef, title, done) {
  try {
    const parts = String(docRef || '').split('#');
    const rel = (parts[0] || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) return false;
    const target = path.resolve(projectRoot, rel);
    if (!isWithin(projectRoot, target) || !fs.existsSync(target)) return false;
    const raw = fs.readFileSync(target, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const lineMatch = /^L(\d+)$/i.exec((parts[1] || '').trim());
    const lineNo = lineMatch ? Number(lineMatch[1]) : 0;
    const cbRe = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;
    const normTitle = String(title || '').trim().toLowerCase();

    let hit = -1;
    if (lineNo >= 1 && lineNo <= lines.length && cbRe.test(lines[lineNo - 1])) {
      hit = lineNo - 1;
    } else if (normTitle) {
      hit = lines.findIndex((l) => {
        const m = cbRe.exec(l);
        return m && m[4].toLowerCase().includes(normTitle.slice(0, 40));
      });
    }
    if (hit < 0) return false;
    const m = cbRe.exec(lines[hit]);
    const mark = done ? 'x' : ' ';
    if (m[2].toLowerCase() === mark) return false;
    lines[hit] = `${m[1]}${mark}${m[3]}${m[4]}`;
    fs.writeFileSync(target, lines.join(eol), 'utf8');
    return true;
  } catch { return false; }
}

function readBoardCompact({ cwd = '', status = '', includeArchived = false } = {}) {
  const r = resolveBoardFile(cwd);
  if (r.error) return r;
  if (!fs.existsSync(r.boardFile)) {
    return { error: `Quadro não encontrado em ${r.boardFile}. Abra o projeto no AI Workspace primeiro.` };
  }
  let board;
  try { board = JSON.parse(fs.readFileSync(r.boardFile, 'utf8')); } catch {
    return { error: 'board.card.json contém JSON inválido.' };
  }
  const counts = { idea: 0, spec: 0, 'in-progress': 0, review: 0, done: 0 };
  const all = Array.isArray(board.items) ? board.items : [];
  let archivedCount = 0;
  for (const it of all) {
    if (it.archived) {
      archivedCount++;
      continue;
    }
    const st = VALID_BOARD_STATUSES.has(it.status) ? it.status : 'idea';
    counts[st]++;
  }
  const visible = includeArchived ? all : all.filter((it) => !it.archived);
  const filterSt = VALID_BOARD_STATUSES.has(status) ? status : '';
  const items = visible
    .filter((it) => !filterSt || (it.status || 'idea') === filterSt)
    .map((it) => ({
      id: it.id,
      status: it.status || 'idea',
      title: it.title,
      ...(it.archived ? { archived: true } : {}),
      ...(it.phase ? { phase: it.phase } : {}),
      ...(it.docRef ? { docRef: it.docRef } : {}),
      ...(it.review && it.review.status ? { review: it.review.status } : {}),
    }));
  return { cwd: r.root, title: board.title || path.basename(r.root), counts, total: visible.length, archivedCount, items };
}

function validateMcpDocRef(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 400 || /[\x00-\x1f]/.test(s)) return { ok: false, error: 'docRef inválido.' };
  const [rawPath, anchor = ''] = s.split('#');
  const cleanPath = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanPath || /^[a-zA-Z]:/.test(cleanPath)) return { ok: false, error: 'docRef deve ser caminho relativo ao projeto.' };
  const parts = cleanPath.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..') return { ok: false, error: 'docRef contém segmento inválido.' };
  }
  if (anchor && !/^L\d+$/i.test(anchor.trim())) {
    return { ok: false, error: 'Âncora de docRef inválida (use #L<linha>).' };
  }
  return { ok: true, value: anchor ? `${cleanPath}#${anchor.trim()}` : cleanPath };
}

function updateBoardStatus({ cwd = '', updates = [], syncDocs = true } = {}) {
  const r = resolveBoardFile(cwd);
  if (r.error) return r;
  if (!fs.existsSync(r.boardFile)) return { error: `Quadro não encontrado em ${r.boardFile}.` };
  if (!Array.isArray(updates) || !updates.length) return { error: 'Informe ao menos um item em updates: [{ id, status, note?, docRef? }].' };

  let board;
  try { board = JSON.parse(fs.readFileSync(r.boardFile, 'utf8')); } catch {
    return { error: 'board.card.json contém JSON inválido.' };
  }
  const items = Array.isArray(board.items) ? board.items.slice() : [];
  const applied = [];
  const notFound = [];

  for (const u of updates) {
    if (!u || !u.id || !VALID_BOARD_STATUSES.has(u.status)) continue;
    const idx = items.findIndex((it) => it.id === u.id);
    if (idx < 0) { notFound.push(u.id); continue; }
    const cur = items[idx];
    const prevStatus = cur.status || 'idea';
    let nextDocRef = cur.docRef;
    if (u.docRef !== undefined && u.docRef !== null && String(u.docRef).trim() !== '') {
      const checked = validateMcpDocRef(u.docRef);
      if (!checked.ok) return { error: `Item "${u.id}": ${checked.error}` };
      nextDocRef = checked.value;
    }
    const nextBody = u.note
      ? `${String(cur.body || '').trimEnd()}${cur.body ? '\n\n' : ''}- ${String(u.note).trim()}`
      : cur.body;
    items[idx] = {
      ...cur,
      status: u.status,
      updatedAt: Date.now(),
      ...(nextBody !== undefined ? { body: nextBody } : {}),
      ...(nextDocRef ? { docRef: nextDocRef } : {}),
    };
    let docSynced = false;
    if (syncDocs !== false && nextDocRef && (prevStatus === 'done') !== (u.status === 'done')) {
      docSynced = syncMarkdownCheckboxStandalone(r.root, nextDocRef, cur.title, u.status === 'done');
    }
    applied.push({
      id: cur.id,
      title: cur.title,
      from: prevStatus,
      to: u.status,
      ...(nextDocRef ? { docRef: nextDocRef } : {}),
      docSynced,
    });
  }

  if (applied.length) {
    backupAndWriteBoard(r.root, r.boardFile, { ...board, items });
  }
  return { ok: true, updated: applied.length, applied, notFound };
}

function addBoardItem({ cwd = '', title = '', body = '', status = 'idea', phase = '', docRef = '' } = {}) {
  const r = resolveBoardFile(cwd);
  if (r.error) return r;
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { error: 'Informe o título da tarefa.' };
  const cleanStatus = VALID_BOARD_STATUSES.has(status) ? status : 'idea';

  let board;
  if (fs.existsSync(r.boardFile)) {
    try { board = JSON.parse(fs.readFileSync(r.boardFile, 'utf8')); } catch {
      return { error: 'board.card.json contém JSON inválido.' };
    }
  } else {
    board = { format: 'ai-card', version: 1, template: 'board', title: path.basename(r.root), summary: '', items: [] };
  }
  const items = Array.isArray(board.items) ? board.items.slice() : [];
  const used = new Set(items.map((i) => i.id));
  const slug = cleanTitle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'item';
  let id = `ai-${slug}`;
  let n = 2;
  while (used.has(id)) id = `ai-${slug}-${n++}`;

  const item = {
    id,
    title: cleanTitle.slice(0, 200),
    body: String(body || '').slice(0, 10000),
    status: cleanStatus,
    updatedAt: Date.now(),
    ...(phase ? { phase: String(phase).slice(0, 120) } : {}),
    ...(docRef ? { docRef: String(docRef).replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 400) } : {}),
  };
  items.push(item);
  backupAndWriteBoard(r.root, r.boardFile, { ...board, items });
  return { ok: true, item };
}

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Busca na memória compartilhada cross-IA (MEMORY.md, pinned.md, decisions.md, pitfalls.md, episodic/) e nos documentos do AI Workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Termos de busca (palavras-chave)' },
        project: { type: 'string', description: 'Slug opcional do projeto para restringir a busca' },
        limit: { type: 'integer', description: 'Máximo de arquivos retornados (padrão 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_read',
    description: 'Lê um arquivo de memória de um projeto (ex.: MEMORY.md, pinned.md, decisions.md, pitfalls.md, current-state.md ou episodic/<arquivo>.md).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Slug do projeto (ex.: ai-hud)' },
        file: { type: 'string', description: 'Nome do arquivo relativo à pasta de memória (padrão MEMORY.md)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'workspace_list',
    description: 'Lista projetos/entidades registrados no AI Workspace e projetos que possuem memória compartilhada.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_read',
    description: 'Lê de forma compacta (econômica em tokens) o Quadro do projeto em <cwd>/.ai-workspace/board.card.json com contagem por coluna e itens.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Caminho absoluto da pasta do projeto' },
        status: { type: 'string', description: 'Filtro opcional de coluna: idea, spec, in-progress, review ou done' },
        includeArchived: { type: 'boolean', description: 'Se true, inclui tarefas concluídas arquivadas (padrão false)' },
      },
      required: ['cwd'],
    },
  },
  {
    name: 'board_update_status',
    description: 'Atualiza o status de uma ou mais tarefas em <cwd>/.ai-workspace/board.card.json com backup automático (reversível no botão Desfazer) e sincronização `- [x]` em docs/.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Caminho absoluto da pasta do projeto' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['idea', 'spec', 'in-progress', 'review', 'done'] },
              note: { type: 'string', description: 'Observação curta opcional adicionada ao corpo do card' },
              docRef: { type: 'string', description: 'Caminho relativo opcional de spec/plano/doc (ex.: docs/specs/minha-spec.md ou docs/plano.md#L12)' },
            },
            required: ['id', 'status'],
          },
        },
        syncDocs: { type: 'boolean', description: 'Se true (padrão), marca/desmarca `- [x]` no Markdown vinculado em docRef' },
      },
      required: ['cwd', 'updates'],
    },
  },
  {
    name: 'board_add_item',
    description: 'Adiciona uma nova tarefa ao Quadro do projeto em <cwd>/.ai-workspace/board.card.json com backup prévio.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: ['idea', 'spec', 'in-progress', 'review', 'done'] },
        phase: { type: 'string' },
        docRef: { type: 'string' },
      },
      required: ['cwd', 'title'],
    },
  },
];

function handleRpc(msg, wsRoot) {
  const { id, method, params = {} } = msg || {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-hud-memory', version: '0.1.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    let out;
    if (name === 'memory_search') out = searchMemory(wsRoot, args);
    else if (name === 'memory_read') out = readMemoryFile(wsRoot, args);
    else if (name === 'workspace_list') out = listWorkspace(wsRoot);
    else if (name === 'board_read') out = readBoardCompact(args);
    else if (name === 'board_update_status') out = updateBoardStatus(args);
    else if (name === 'board_add_item') out = addBoardItem(args);
    else return { jsonrpc: '2.0', id, error: { code: -32601, message: `Ferramenta desconhecida: ${name}` } };

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: !!out.error,
      },
    };
  }
  if (id === undefined) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Método não suportado: ${method}` } };
}

function startStdio(wsRoot = resolveWorkspaceRoot()) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  const writeMsg = (obj) => {
    if (!obj) return;
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  process.stdin.on('data', (chunk) => {
    buf += chunk;
    while (buf.length) {
      // Suporta framing Content-Length (LSP/MCP) e NDJSON (uma mensagem por linha)
      if (/^Content-Length:/i.test(buf)) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) break;
        const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, sep));
        const len = m ? Number(m[1]) : 0;
        const bodyStart = sep + 4;
        if (Buffer.byteLength(buf.slice(bodyStart), 'utf8') < len) break;
        const body = buf.slice(bodyStart, bodyStart + len);
        buf = buf.slice(bodyStart + len);
        try { writeMsg(handleRpc(JSON.parse(body), wsRoot)); } catch {}
      } else {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { writeMsg(handleRpc(JSON.parse(line), wsRoot)); } catch {}
      }
    }
  });
}

if (require.main === module) startStdio();

module.exports = { searchMemory, readMemoryFile, listWorkspace, readBoardCompact, updateBoardStatus, addBoardItem, handleRpc, resolveWorkspaceRoot };
