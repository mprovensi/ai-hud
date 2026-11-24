#!/usr/bin/env node
// Micro-servidor MCP (stdio, JSON-RPC 2.0, zero dependências externas) para busca na memória
// compartilhada e no AI Workspace sob demanda (Claude Code, Codex, Antigravity).
//
// Ferramentas expostas:
// - memory_search(query, project?, limit?): busca textual em MEMORY.md, decisions.md, pitfalls.md,
//   pinned.md, episodic/*.md e docs do AI Workspace.
// - memory_read(project, file?): lê um arquivo específico da memória do projeto.
// - workspace_list(): lista projetos/entidades do Workspace e projetos com memória compartilhada.

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

module.exports = { searchMemory, readMemoryFile, listWorkspace, handleRpc, resolveWorkspaceRoot };
