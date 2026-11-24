// Leitura somente leitura dos documentos reais do projeto (docs/, README, specs, revisões) e do quadro portátil em <cwd>/.ai-workspace/ (camada collect/).
const fs = require('fs');
const path = require('path');
const { isSafeRelativePath, isWithinRoot, isSecretPath, resolveContainedPath } = require('../../core/path-guard');
const { classifyProjectDoc, extractDocTitle, extractItemsFromMarkdown } = require('../../core/doc-parser');
const { hashContent } = require('../../infra/workspace-paths');

const PORTABLE_DIR = '.ai-workspace';
const PORTABLE_BOARD_REL = '.ai-workspace/board.card.json';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vite', 'target', 'vendor', '__pycache__', '.venv', 'coverage']);
const DOC_EXTS = new Set(['.md', '.markdown', '.txt']);
const MAX_DOCS = 120;
const MAX_DOC_READ_BYTES = 256 * 1024;

function readTextLimited(filePath, maxBytes = MAX_DOC_READ_BYTES) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch { return ''; }
}

function checkGitExcluded(cwd) {
  try {
    const excludePath = path.join(cwd, '.git', 'info', 'exclude');
    if (fs.existsSync(excludePath)) {
      const raw = fs.readFileSync(excludePath, 'utf8');
      if (/^\s*\.ai-workspace\/?\s*$/m.test(raw)) return 'git-exclude';
    }
    const giPath = path.join(cwd, '.gitignore');
    if (fs.existsSync(giPath)) {
      const raw = fs.readFileSync(giPath, 'utf8');
      if (/^\s*\.ai-workspace\/?\s*$/m.test(raw)) return 'gitignore';
    }
  } catch {}
  return 'tracked';
}

function listProjectDocs(cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { status: 404, error: 'Pasta do projeto não encontrada nesta máquina.' };
  }
  const realRoot = fs.realpathSync(cwd);
  const found = [];
  const seen = new Set();

  const addFile = (absPath, relPath) => {
    if (found.length >= MAX_DOCS) return;
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const key = norm.toLowerCase();
    if (seen.has(key) || isSecretPath(norm)) return;
    const ext = path.extname(norm).toLowerCase();
    if (!DOC_EXTS.has(ext)) return;
    try {
      const real = fs.realpathSync(absPath);
      if (!isWithinRoot(realRoot, real)) return;
      const st = fs.statSync(real);
      if (!st.isFile()) return;
      seen.add(key);
      const text = st.size <= MAX_DOC_READ_BYTES ? fs.readFileSync(real, 'utf8') : '';
      const category = classifyProjectDoc(norm);
      const title = extractDocTitle(text, path.basename(norm));
      const parsed = text && ext !== '.txt' ? extractItemsFromMarkdown(text, { docPath: norm, maxItems: 60 }) : { items: [] };
      const doneCount = parsed.items.filter((i) => i.status === 'done').length;
      found.push({
        path: norm,
        name: path.basename(norm),
        category,
        title,
        size: st.size,
        mtimeMs: st.mtimeMs,
        taskCount: parsed.items.length,
        doneCount,
      });
    } catch {}
  };

  // 1. Documentos Markdown na raiz do projeto (README.md, TODO.md, PLAN*.md, CLAUDE.md, etc.)
  try {
    for (const e of fs.readdirSync(realRoot, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.md' || ext === '.markdown') {
        addFile(path.join(realRoot, e.name), e.name);
      }
    }
  } catch {}

  // 2. Pasta docs/ (e variantes doc/, plans/, specs/) até profundidade 3
  const scanDir = (relBase, depth = 0) => {
    if (depth > 3 || found.length >= MAX_DOCS) return;
    const absDir = path.join(realRoot, relBase);
    if (!fs.existsSync(absDir)) return;
    try {
      for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (found.length >= MAX_DOCS) break;
        if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
        const childRel = `${relBase}/${e.name}`;
        const childAbs = path.join(absDir, e.name);
        if (e.isDirectory()) scanDir(childRel, depth + 1);
        else if (e.isFile()) addFile(childAbs, childRel);
      }
    } catch {}
  };

  for (const dirName of ['docs', 'doc', 'plans', 'specs']) {
    scanDir(dirName, 0);
  }

  // 3. Revisões Goldfish e notas locais em .ai-workspace/
  const reviewsDir = path.join(realRoot, PORTABLE_DIR, 'reviews');
  if (fs.existsSync(reviewsDir)) {
    try {
      for (const e of fs.readdirSync(reviewsDir, { withFileTypes: true })) {
        if (e.isFile() && !e.name.startsWith('.')) {
          addFile(path.join(reviewsDir, e.name), `${PORTABLE_DIR}/reviews/${e.name}`);
        }
      }
    } catch {}
  }
  const portableNotes = path.join(realRoot, PORTABLE_DIR, 'notes.md');
  if (fs.existsSync(portableNotes)) addFile(portableNotes, `${PORTABLE_DIR}/notes.md`);

  const catOrder = { plan: 0, spec: 1, doc: 2, review: 3 };
  found.sort((a, b) => (catOrder[a.category] - catOrder[b.category]) || (b.mtimeMs - a.mtimeMs));

  const boardAbs = path.join(realRoot, PORTABLE_BOARD_REL);
  return {
    status: 200,
    body: {
      ok: true,
      cwd: realRoot,
      hasPortableBoard: fs.existsSync(boardAbs),
      boardPath: PORTABLE_BOARD_REL,
      gitMode: checkGitExcluded(realRoot),
      docs: found,
    },
  };
}

function readProjectDoc(cwd, relPath) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, error: 'Pasta do projeto não encontrada nesta máquina.' };
  const cleanRel = String(relPath || '').split('#')[0].trim();
  if (!isSafeRelativePath(cleanRel) || isSecretPath(cleanRel)) return { status: 400, error: 'Caminho de documento inválido.' };
  const ext = path.extname(cleanRel).toLowerCase();
  if (!DOC_EXTS.has(ext)) return { status: 400, error: 'Apenas documentos .md ou .txt podem ser abertos aqui.' };

  const realRoot = fs.realpathSync(cwd);
  const target = resolveContainedPath(realRoot, cleanRel);
  if (!target || !isWithinRoot(realRoot, target)) return { status: 403, error: 'Caminho fora do projeto.' };
  if (!fs.existsSync(target)) return { status: 404, error: 'Documento não encontrado.' };

  const realFile = fs.realpathSync(target);
  if (!isWithinRoot(realRoot, realFile)) return { status: 403, error: 'Symlink fora do projeto.' };
  const st = fs.statSync(realFile);
  if (!st.isFile()) return { status: 400, error: 'O caminho não é um arquivo.' };
  if (st.size > 1024 * 1024) return { status: 413, error: 'Documento excede 1 MB.' };

  const content = fs.readFileSync(realFile, 'utf8');
  return {
    status: 200,
    body: {
      ok: true,
      path: cleanRel.replace(/\\/g, '/'),
      category: classifyProjectDoc(cleanRel),
      title: extractDocTitle(content, path.basename(cleanRel)),
      content,
      hash: hashContent(content),
      mtimeMs: st.mtimeMs,
      size: st.size,
    },
  };
}

function readPortableBoard(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, error: 'Pasta do projeto não encontrada nesta máquina.' };
  const realRoot = fs.realpathSync(cwd);
  const target = resolveContainedPath(realRoot, PORTABLE_BOARD_REL);
  if (!target || !isWithinRoot(realRoot, target)) return { status: 403, error: 'Caminho inválido.' };
  if (!fs.existsSync(target)) {
    return { status: 200, body: { ok: true, exists: false, storage: 'in-project', path: PORTABLE_BOARD_REL, content: null, hash: '' } };
  }
  const raw = fs.readFileSync(target, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    return { status: 422, error: 'board.card.json em .ai-workspace/ está corrompido.' };
  }
  return {
    status: 200,
    body: {
      ok: true,
      exists: true,
      storage: 'in-project',
      path: PORTABLE_BOARD_REL,
      content: parsed,
      hash: hashContent(raw),
    },
  };
}

function readWorkflowUsageLog(workspaceRoot, { limit = 50 } = {}) {
  const file = path.join(workspaceRoot, 'workflow-usage.jsonl');
  const raw = readTextLimited(file, 2 * 1024 * 1024);
  const rows = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (!e || typeof e !== 'object') continue;
      inputTokens += Number(e.inputTokens) || 0;
      outputTokens += Number(e.outputTokens) || 0;
      cacheReadTokens += Number(e.cacheReadTokens) || 0;
      totalTokens += Number(e.totalTokens) || 0;
      if (typeof e.costUsd === 'number') costUsd += e.costUsd;
      rows.push(e);
    } catch {}
  }
  return {
    runs: rows.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    recent: rows.slice(-Math.max(1, limit)).reverse(),
  };
}

module.exports = {
  PORTABLE_DIR,
  PORTABLE_BOARD_REL,
  listProjectDocs,
  readProjectDoc,
  readPortableBoard,
  readWorkflowUsageLog,
};
