// Armazenamento portátil do projeto em <cwd>/.ai-workspace/ + edição segura de docs e importação 0-token (camada actions/).
const fs = require('fs');
const path = require('path');
const { isSafeRelativePath, isWithinRoot, isSecretPath, resolveContainedPath } = require('../../core/path-guard');
const { validateCard, defaultCard, slugifyEntity } = require('../../core/workspace-schema');
const { extractItemsFromMarkdown, mergeImportedItems, toggleMarkdownCheckbox } = require('../../core/doc-parser');
const { buildSpecTemplate } = require('../../core/egm');
const { hashContent, writeAtomic, writeAtomicWithBackup } = require('../../infra/workspace-paths');
const { PORTABLE_DIR, PORTABLE_BOARD_REL, listProjectDocs, readProjectDoc, readPortableBoard } = require('../../collect/workspace/project-docs');

const DOC_EXTS = new Set(['.md', '.markdown', '.txt']);
const MAX_DOC_BYTES = 1024 * 1024;

// Boas práticas Git:
// 1) `.ai-workspace/.gitignore` ignora backups transitórios caso o usuário decida versionar `.ai-workspace/` em um repo próprio.
// 2) `.git/info/exclude` recebe `.ai-workspace/` automaticamente para não sujar `git status` em repositórios de terceiros/trabalho.
function ensurePortableDir(cwd, { now = () => Date.now() } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const realRoot = fs.realpathSync(cwd);
  const wsDir = path.join(realRoot, PORTABLE_DIR);
  fs.mkdirSync(path.join(wsDir, 'reviews'), { recursive: true });

  const innerGi = path.join(wsDir, '.gitignore');
  if (!fs.existsSync(innerGi)) {
    try { writeAtomic(innerGi, 'backups/\n'); } catch {}
  }

  // Adiciona `.ai-workspace/` ao `.git/info/exclude` (ignorado localmente, sem alterar `.gitignore` do repo)
  const gitInfoDir = path.join(realRoot, '.git', 'info');
  if (fs.existsSync(gitInfoDir)) {
    try {
      const excludeFile = path.join(gitInfoDir, 'exclude');
      const prev = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      if (!/^\s*\.ai-workspace\/?\s*$/m.test(prev)) {
        const suffix = (prev && !prev.endsWith('\n') ? '\n' : '') + '# AI Workspace (portátil local)\n.ai-workspace/\n';
        fs.writeFileSync(excludeFile, prev + suffix, 'utf8');
      }
    } catch {}
  }

  const metaFile = path.join(wsDir, 'project.json');
  if (!fs.existsSync(metaFile)) {
    try {
      writeAtomic(metaFile, JSON.stringify({
        format: 'ai-project',
        version: 1,
        createdAt: new Date(now()).toISOString(),
      }, null, 2) + '\n');
    } catch {}
  }
  return { realRoot, wsDir };
}

function savePortableBoard({ cwd, content, baseHash = '', now = () => Date.now() }) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, body: 'Pasta do projeto não encontrada nesta máquina.' };
  let obj = content;
  if (typeof content === 'string') {
    try { obj = JSON.parse(content); } catch { return { status: 400, body: 'JSON inválido no quadro.' }; }
  }
  try {
    validateCard(obj);
  } catch (e) {
    return { status: e.status || 400, body: e.message };
  }

  const ensured = ensurePortableDir(cwd, { now });
  const target = path.join(ensured.realRoot, PORTABLE_BOARD_REL);
  const serialized = JSON.stringify(obj, null, 2) + '\n';

  if (fs.existsSync(target)) {
    const currentRaw = fs.readFileSync(target, 'utf8');
    const currentHash = hashContent(currentRaw);
    if (baseHash && baseHash !== currentHash) {
      return {
        status: 409,
        body: {
          error: 'O quadro foi alterado em disco enquanto você editava.',
          currentContent: (() => { try { return JSON.parse(currentRaw); } catch { return currentRaw; } })(),
          currentHash,
        },
      };
    }
  }

  writeAtomicWithBackup({
    filePath: target,
    content: serialized,
    backupDir: path.join(ensured.wsDir, 'backups', 'cards'),
    tag: 'board.card.json',
  });

  return { status: 200, body: { ok: true, storage: 'in-project', path: PORTABLE_BOARD_REL, hash: hashContent(serialized) } };
}

function saveProjectDoc({ cwd, relPath, content, baseHash = '', now = () => Date.now() }) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, body: 'Pasta do projeto não encontrada nesta máquina.' };
  const cleanRel = String(relPath || '').split('#')[0].trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!isSafeRelativePath(cleanRel) || isSecretPath(cleanRel)) return { status: 400, body: 'Caminho de documento inválido.' };
  const ext = path.extname(cleanRel).toLowerCase();
  if (!DOC_EXTS.has(ext)) return { status: 400, body: 'Apenas documentos .md ou .txt podem ser salvos aqui.' };

  const serialized = String(content == null ? '' : content);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOC_BYTES) {
    return { status: 413, body: 'Documento excede o limite de 1 MB.' };
  }

  const ensured = ensurePortableDir(cwd, { now });
  const target = resolveContainedPath(ensured.realRoot, cleanRel);
  if (!target || !isWithinRoot(ensured.realRoot, target)) return { status: 403, body: 'Caminho fora do projeto.' };

  if (fs.existsSync(target)) {
    const realFile = fs.realpathSync(target);
    if (!isWithinRoot(ensured.realRoot, realFile)) return { status: 403, body: 'Symlink fora do projeto.' };
    const currentRaw = fs.readFileSync(realFile, 'utf8');
    const currentHash = hashContent(currentRaw);
    if (baseHash && baseHash !== currentHash) {
      return {
        status: 409,
        body: {
          error: 'Documento foi alterado em disco enquanto você editava.',
          currentContent: currentRaw,
          currentHash,
        },
      };
    }
  }

  writeAtomicWithBackup({
    filePath: target,
    content: serialized,
    backupDir: path.join(ensured.wsDir, 'backups', 'docs'),
    tag: cleanRel.replace(/\//g, '_'),
  });

  return { status: 200, body: { ok: true, path: cleanRel, hash: hashContent(serialized) } };
}

function createSpecDoc({ cwd, title = '', summary = '', folder = 'docs/specs', now = () => Date.now() }) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, body: 'Pasta do projeto não encontrada nesta máquina.' };
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return { status: 400, body: 'Informe um título para a especificação.' };

  const safeFolder = String(folder || 'docs/specs').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!isSafeRelativePath(safeFolder)) return { status: 400, body: 'Pasta de destino inválida.' };

  const ensured = ensurePortableDir(cwd, { now });
  const baseSlug = slugifyEntity(cleanTitle).slice(0, 50);
  let relPath = `${safeFolder}/${baseSlug}.md`;
  let n = 2;
  while (fs.existsSync(path.join(ensured.realRoot, relPath))) {
    relPath = `${safeFolder}/${baseSlug}-${n++}.md`;
  }

  const day = new Date(now()).toISOString().slice(0, 10);
  const content = buildSpecTemplate({ title: cleanTitle, summary, day });
  const saved = saveProjectDoc({ cwd: ensured.realRoot, relPath, content, now });
  if (saved.status !== 200) return saved;
  return { status: 200, body: { ok: true, path: relPath, title: cleanTitle, content, hash: saved.body.hash } };
}

function saveReviewReport({ cwd, docPath, markdown, now = () => Date.now() }) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, body: 'Pasta do projeto não encontrada nesta máquina.' };
  const ensured = ensurePortableDir(cwd, { now });
  const slug = slugifyEntity(path.basename(String(docPath || 'spec'), path.extname(String(docPath || '')))).slice(0, 48);
  const relPath = `${PORTABLE_DIR}/reviews/${slug}.md`;
  const target = resolveContainedPath(ensured.realRoot, relPath);
  if (!target || !isWithinRoot(ensured.realRoot, target)) return { status: 403, body: 'Caminho de revisão inválido.' };
  writeAtomic(target, String(markdown || '').trimEnd() + '\n');
  return { status: 200, body: { ok: true, reportPath: relPath } };
}

// Importação 100% determinística (0 tokens) a partir dos documentos Markdown do projeto.
function importDocsToBoard({ cwd, paths = null, dryRun = false, title = '', now = () => Date.now() }) {
  const listed = listProjectDocs(cwd);
  if (listed.status !== 200) return { status: listed.status, body: listed.error };

  const docs = listed.body.docs || [];
  const wanted = Array.isArray(paths) && paths.length
    ? docs.filter((d) => paths.includes(d.path))
    : docs.filter((d) => d.category === 'plan' || d.category === 'spec' || d.taskCount > 0);

  const candidates = [];
  const docsScanned = [];
  for (const d of wanted) {
    const r = readProjectDoc(cwd, d.path);
    if (r.status !== 200) continue;
    const parsed = extractItemsFromMarkdown(r.body.content, { docPath: d.path, maxItems: 60 });
    docsScanned.push({ path: d.path, title: parsed.title, category: parsed.category, count: parsed.items.length });
    candidates.push(...parsed.items);
  }

  const cur = readPortableBoard(cwd);
  const baseCard = (cur.status === 200 && cur.body.exists && cur.body.content)
    ? cur.body.content
    : defaultCard({ title: title || path.basename(listed.body.cwd), template: 'board' });

  const merged = mergeImportedItems(baseCard.items, candidates);

  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        tokensUsed: 0,
        docsScanned,
        totalDetected: candidates.length,
        toAdd: merged.added,
        alreadyPresent: Math.max(0, candidates.length - merged.added.length),
      },
    };
  }

  // Se ainda não existia board.card.json no projeto, grava o estado inicial vazio antes de importar
  // para que "Desfazer importação" sempre consiga restaurar o quadro anterior.
  if (!(cur.status === 200 && cur.body.exists)) {
    savePortableBoard({ cwd, content: baseCard, now });
  }

  const nextCard = { ...baseCard, items: merged.items };
  const saved = savePortableBoard({ cwd, content: nextCard, now });
  if (saved.status !== 200) return saved;

  return {
    status: 200,
    body: {
      ok: true,
      tokensUsed: 0,
      docsScanned,
      addedCount: merged.added.length,
      totalItems: merged.items.length,
      board: nextCard,
      hash: saved.body.hash,
    },
  };
}

function undoPortableBoard({ cwd }) {
  if (!cwd || !fs.existsSync(cwd)) return { status: 404, body: 'Pasta do projeto não encontrada nesta máquina.' };
  const realRoot = fs.realpathSync(cwd);
  const backupDir = path.join(realRoot, PORTABLE_DIR, 'backups', 'cards');
  let files = [];
  try {
    files = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.bak'))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {}
  if (!files.length) {
    return { status: 404, body: 'Nenhuma versão anterior do quadro disponível para desfazer.' };
  }
  const latestName = files[0];
  const latestPath = path.join(backupDir, latestName);
  const raw = fs.readFileSync(latestPath, 'utf8');
  let parsed = null;
  try {
    parsed = validateCard(JSON.parse(raw));
  } catch {
    return { status: 422, body: 'O backup anterior do quadro está corrompido.' };
  }
  const serialized = JSON.stringify(parsed, null, 2) + '\n';
  const target = path.join(realRoot, PORTABLE_BOARD_REL);
  writeAtomic(target, serialized);
  try { fs.unlinkSync(latestPath); } catch {}
  return {
    status: 200,
    body: {
      ok: true,
      restoredBackup: latestName,
      remainingBackups: files.length - 1,
      board: parsed,
      hash: hashContent(serialized),
    },
  };
}

function syncDocCheckbox({ cwd, docRef = '', title = '', done = true, now = () => Date.now() }) {
  const parts = String(docRef || '').split('#');
  const relPath = (parts[0] || '').trim();
  const lineMatch = /^L(\d+)$/i.exec((parts[1] || '').trim());
  const lineNo = lineMatch ? Number(lineMatch[1]) : 0;
  if (!relPath) return { status: 400, body: 'docRef ausente.' };

  const read = readProjectDoc(cwd, relPath);
  if (read.status !== 200) return { status: read.status, body: read.error };

  const toggled = toggleMarkdownCheckbox(read.body.content, { lineNo, title, done: !!done });
  if (!toggled.matched) {
    return { status: 200, body: { ok: true, matched: false, changed: false, path: read.body.path } };
  }
  if (!toggled.changed) {
    return { status: 200, body: { ok: true, matched: true, changed: false, path: read.body.path, lineNo: toggled.lineNo } };
  }

  const saved = saveProjectDoc({ cwd, relPath: read.body.path, content: toggled.content, baseHash: read.body.hash, now });
  if (saved.status !== 200) return saved;
  return {
    status: 200,
    body: {
      ok: true,
      matched: true,
      changed: true,
      path: read.body.path,
      lineNo: toggled.lineNo,
      done: !!done,
      hash: saved.body.hash,
    },
  };
}

module.exports = {
  ensurePortableDir,
  savePortableBoard,
  saveProjectDoc,
  createSpecDoc,
  saveReviewReport,
  importDocsToBoard,
  undoPortableBoard,
  syncDocCheckbox,
};
