// Ações file-first do Workspace: criar entidade, salvar cards/Markdown com proteção 409 + backup e upload de mídia (camada actions/).
const fs = require('fs');
const path = require('path');
const { isSafeRelativePath, isWithinRoot, isSecretPath, resolveContainedPath } = require('../../core/path-guard');
const { slugifyEntity, validateCard, validateWorkspaceIndex, defaultCard } = require('../../core/workspace-schema');
const { resolveWorkspaceRoot, hashContent, writeAtomicWithBackup } = require('../../infra/workspace-paths');
const { readWorkspaceJson, findEntity, resolveEntityRoot } = require('../../collect/workspace');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 1024 * 1024;

function createWorkspaceActions({ dataDir, config, now = () => Date.now() }) {
  const root = () => resolveWorkspaceRoot(dataDir, config);
  const backupsDir = (sub) => path.join(root(), '.ai-workspace', 'backups', sub);

  function saveIndex(index) {
    const valid = validateWorkspaceIndex(index);
    writeAtomicWithBackup({
      filePath: path.join(root(), 'workspace.json'),
      content: JSON.stringify(valid, null, 2) + '\n',
      backupDir: backupsDir('index'),
      tag: 'workspace.json',
    });
    return valid;
  }

  function createEntity({ title, description = '', group = '', category = 'dev', template = 'board', projectBindings = [], defaultAgent = 'claude' } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return { status: 400, body: 'Informe um título para o projeto/entidade.' };

    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);
    const baseId = slugifyEntity(cleanTitle);
    let id = baseId;
    let n = 2;
    while (index.entities.some((e) => e.id === id)) { id = `${baseId}-${n++}`; }

    const cleanGroup = String(group || '').trim().slice(0, 80);
    const day = new Date(now()).toISOString().slice(0, 10);
    const folder = `entities/${day}_${id}`;
    const cardPath = 'overview.card.json';
    const notesPath = 'notes.md';
    const entity = {
      id,
      title: cleanTitle.slice(0, 200),
      description: String(description || '').trim().slice(0, 1000),
      ...(cleanGroup ? { group: cleanGroup } : {}),
      category,
      status: 'active',
      pinned: false,
      folder,
      projectBindings: Array.isArray(projectBindings) ? projectBindings : [],
      defaultAgent: String(defaultAgent || 'claude').slice(0, 40),
      steps: [
        { name: 'Quadro', path: cardPath, viewer: 'card' },
        { name: 'Notas', path: notesPath, viewer: 'markdown' },
      ],
      created: day,
      updated: day,
    };

    const groups = Array.isArray(index.groups) ? [...index.groups] : [];
    if (cleanGroup && !groups.includes(cleanGroup)) groups.push(cleanGroup);
    const nextIndex = { ...index, ...(groups.length ? { groups } : {}), entities: [entity, ...index.entities] };
    try {
      validateWorkspaceIndex(nextIndex);
    } catch (e) {
      return { status: e.status || 400, body: e.message };
    }

    const card = defaultCard({ title: cleanTitle, template, summary: entity.description });
    const entityDir = path.join(wsRoot, folder);
    fs.mkdirSync(path.join(entityDir, 'media'), { recursive: true });
    writeAtomicWithBackup({
      filePath: path.join(entityDir, cardPath),
      content: JSON.stringify(card, null, 2) + '\n',
      backupDir: backupsDir('cards'),
      tag: `${id}_${cardPath}`,
    });
    writeAtomicWithBackup({
      filePath: path.join(entityDir, notesPath),
      content: `# ${cleanTitle}\n\n${entity.description ? entity.description + '\n' : ''}`,
      backupDir: backupsDir('notes'),
      tag: `${id}_${notesPath}`,
    });
    saveIndex(nextIndex);
    return { status: 200, body: { ok: true, entity } };
  }

  function saveEntityFile({ entityId, relPath, content, baseHash = '' }) {
    const wsRoot = root();
    const entity = findEntity(wsRoot, entityId);
    if (!entity) return { status: 404, body: 'Entidade não encontrada.' };
    const entityRoot = resolveEntityRoot(wsRoot, entity);
    if (!entityRoot) return { status: 400, body: 'Pasta da entidade inválida.' };
    if (!isSafeRelativePath(relPath) || isSecretPath(relPath)) return { status: 400, body: 'Caminho de arquivo inválido.' };
    const target = resolveContainedPath(entityRoot, relPath);
    if (!target || !isWithinRoot(entityRoot, target)) return { status: 403, body: 'Caminho fora da entidade.' };

    const isCard = relPath.toLowerCase().endsWith('.card.json');
    let serialized = '';
    if (isCard) {
      let obj = content;
      if (typeof content === 'string') {
        try { obj = JSON.parse(content); } catch { return { status: 400, body: 'JSON inválido no card.' }; }
      }
      try {
        validateCard(obj);
      } catch (e) {
        return { status: e.status || 400, body: e.message };
      }
      serialized = JSON.stringify(obj, null, 2) + '\n';
    } else {
      serialized = String(content == null ? '' : content);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_DOC_BYTES) {
        return { status: 413, body: 'Documento excede o limite de 1 MB.' };
      }
    }

    if (fs.existsSync(target)) {
      const currentRaw = fs.readFileSync(target, 'utf8');
      const currentHash = hashContent(currentRaw);
      if (baseHash && baseHash !== currentHash) {
        return {
          status: 409,
          body: {
            error: 'Arquivo foi alterado em disco (possivelmente por um agente) enquanto você editava.',
            currentContent: isCard ? (() => { try { return JSON.parse(currentRaw); } catch { return currentRaw; } })() : currentRaw,
            currentHash,
          },
        };
      }
    }

    writeAtomicWithBackup({
      filePath: target,
      content: serialized,
      backupDir: backupsDir(isCard ? 'cards' : 'notes'),
      tag: `${entityId}_${relPath}`,
    });

    // Atualiza data `updated` no índice
    const index = readWorkspaceJson(wsRoot);
    const day = new Date(now()).toISOString().slice(0, 10);
    const updatedEntities = index.entities.map((e) => (e.id === entityId ? { ...e, updated: day } : e));
    saveIndex({ ...index, entities: updatedEntities });

    return { status: 200, body: { ok: true, hash: hashContent(serialized) } };
  }

  function saveGlobalDoc({ area, name, content, baseHash = '' }) {
    if (!['context', 'knowledge', 'skills'].includes(area)) {
      return { status: 400, body: 'Área inválida (use context, knowledge ou skills).' };
    }
    const cleanName = String(name || '').trim();
    if (!isSafeRelativePath(cleanName) || cleanName.includes('/') || isSecretPath(cleanName)) {
      return { status: 400, body: 'Nome de arquivo inválido.' };
    }
    const wsRoot = root();
    const baseDir = path.join(wsRoot, area);
    const target = resolveContainedPath(baseDir, cleanName);
    if (!target || !isWithinRoot(baseDir, target)) return { status: 403, body: 'Caminho fora da área permitida.' };
    const serialized = String(content == null ? '' : content);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOC_BYTES) {
      return { status: 413, body: 'Documento excede o limite de 1 MB.' };
    }

    if (fs.existsSync(target)) {
      const currentRaw = fs.readFileSync(target, 'utf8');
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
      backupDir: backupsDir(area),
      tag: `${area}_${cleanName}`,
    });
    return { status: 200, body: { ok: true, hash: hashContent(serialized) } };
  }

  function uploadEntityMedia({ entityId, fileName, base64Data }) {
    const wsRoot = root();
    const entity = findEntity(wsRoot, entityId);
    if (!entity) return { status: 404, body: 'Entidade não encontrada.' };
    const entityRoot = resolveEntityRoot(wsRoot, entity);
    if (!entityRoot) return { status: 400, body: 'Pasta da entidade inválida.' };

    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      return { status: 400, body: 'Apenas imagens PNG, JPG, WEBP ou GIF são permitidas.' };
    }
    const cleanB64 = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
    if (!cleanB64) return { status: 400, body: 'Dados da imagem ausentes.' };
    const buf = Buffer.from(cleanB64, 'base64');
    if (!buf.length || buf.length > MAX_MEDIA_BYTES) {
      return { status: 413, body: 'Imagem inválida ou excede 10 MB.' };
    }

    const base = slugifyEntity(path.basename(fileName, ext)).slice(0, 40);
    const stamp = Date.now().toString(36).slice(-5);
    const safeFile = `${base}-${stamp}${ext}`;
    const rel = `media/${safeFile}`;
    const target = resolveContainedPath(entityRoot, rel);
    if (!target || !isWithinRoot(entityRoot, target)) return { status: 403, body: 'Caminho de mídia inválido.' };

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return { status: 200, body: { ok: true, path: rel, size: buf.length } };
  }

  function updateEntity({ id, title, description, group, pinned, projectBindings } = {}) {
    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);
    const idx = index.entities.findIndex((e) => e.id === id);
    if (idx < 0) return { status: 404, body: 'Entidade não encontrada.' };
    const cur = { ...index.entities[idx] };
    if (typeof title === 'string' && title.trim()) cur.title = title.trim().slice(0, 200);
    if (typeof description === 'string') cur.description = description.trim().slice(0, 1000);
    if (typeof pinned === 'boolean') cur.pinned = pinned;
    if (Array.isArray(projectBindings)) cur.projectBindings = projectBindings;
    const groups = Array.isArray(index.groups) ? [...index.groups] : [];
    if (typeof group === 'string') {
      const cleanGroup = group.trim().slice(0, 80);
      if (cleanGroup) {
        cur.group = cleanGroup;
        if (!groups.includes(cleanGroup)) groups.push(cleanGroup);
      } else {
        delete cur.group;
      }
    }
    cur.updated = new Date(now()).toISOString().slice(0, 10);
    const entities = index.entities.slice();
    entities[idx] = cur;
    const nextIndex = { ...index, ...(groups.length ? { groups } : {}), entities };
    try {
      saveIndex(nextIndex);
    } catch (e) {
      return { status: e.status || 400, body: e.message };
    }
    return { status: 200, body: { ok: true, entity: cur, groups } };
  }

  function saveGroup({ name = '', renameFrom = '', remove = false } = {}) {
    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);
    let groups = Array.isArray(index.groups) ? [...index.groups] : [];
    for (const e of index.entities) if (e.group && !groups.includes(e.group)) groups.push(e.group);

    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanFrom = String(renameFrom || '').trim().slice(0, 80);

    let entities = index.entities;
    if (remove && cleanName) {
      groups = groups.filter((g) => g !== cleanName);
      entities = entities.map((e) => {
        if (e.group !== cleanName) return e;
        const copy = { ...e };
        delete copy.group;
        return copy;
      });
    } else if (cleanFrom && cleanName) {
      groups = groups.map((g) => (g === cleanFrom ? cleanName : g));
      if (!groups.includes(cleanName)) groups.push(cleanName);
      groups = [...new Set(groups)];
      entities = entities.map((e) => (e.group === cleanFrom ? { ...e, group: cleanName } : e));
    } else {
      if (!cleanName) return { status: 400, body: 'Informe o nome do englobador (workspace).' };
      if (!groups.includes(cleanName)) groups.push(cleanName);
    }

    const nextIndex = { format: index.format, version: index.version, ...(groups.length ? { groups } : {}), entities };
    try {
      saveIndex(nextIndex);
    } catch (e) {
      return { status: e.status || 400, body: e.message };
    }
    return { status: 200, body: { ok: true, groups } };
  }

  return { createEntity, updateEntity, saveGroup, saveEntityFile, saveGlobalDoc, uploadEntityMedia };
}

module.exports = { createWorkspaceActions };
