// Ações file-first do Workspace: criar entidade, salvar cards/Markdown com proteção 409 + backup e upload de mídia (camada actions/).
const fs = require('fs');
const path = require('path');
const { isSafeRelativePath, isWithinRoot, samePath, detectPathPlatform, isSecretPath, resolveContainedPath } = require('../../core/path-guard');
const { slugifyEntity, validateCard, validateWorkspaceIndex, defaultCard } = require('../../core/workspace-schema');
const { resolveWorkspaceRoot, hashContent, writeAtomicWithBackup, resolveSafeContainedTarget } = require('../../infra/workspace-paths');
const { readWorkspaceJson, findEntity, resolveEntityRoot } = require('../../collect/workspace');
const { readPortableBoard } = require('../../collect/workspace/project-docs');
const { savePortableBoard } = require('./project-storage');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 1024 * 1024;

// Valida se `candidateCwd` é uma subpasta estrita de `rootCwd`, respeitando a plataforma do caminho
// (ex.: VPS Linux validando pastas Windows "D:\Projetos TRT18\vulnerabilidades" do peer e vice-versa).
function checkGroupSubfolder(rootCwd, candidateCwd) {
  const plat = detectPathPlatform(rootCwd);
  if (!isWithinRoot(rootCwd, candidateCwd, plat)) return 'outside';
  if (samePath(rootCwd, candidateCwd, plat)) return 'same';
  return 'ok';
}

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
    const bindings = Array.isArray(projectBindings) ? projectBindings : [];
    const gMeta = cleanGroup && index.groupMeta ? index.groupMeta[cleanGroup] : null;
    if (gMeta && gMeta.rootCwd && bindings.length) {
      for (const b of bindings) {
        const bCwd = String(b.cwd || '').trim();
        if (!bCwd) continue;
        const chk = checkGroupSubfolder(gMeta.rootCwd, bCwd);
        if (chk === 'outside') {
          return { status: 400, body: `A pasta do projeto deve ser uma subpasta de "${gMeta.rootCwd}".` };
        }
        if (chk === 'same') {
          return { status: 400, body: `Selecione uma subpasta dentro de "${gMeta.rootCwd}", não a pasta raiz do workspace.` };
        }
      }
    }

    const day = new Date(now()).toISOString().slice(0, 10);
    const folder = `entities/${day}_${id}`;
    const cardPath = 'overview.card.json';
    const notesPath = 'notes.md';
    const hasBinding = bindings.some((b) => b && b.cwd);
    const entity = {
      id,
      title: cleanTitle.slice(0, 200),
      description: String(description || '').trim().slice(0, 1000),
      ...(cleanGroup ? { group: cleanGroup } : {}),
      category,
      status: 'active',
      pinned: false,
      folder,
      storageMode: hasBinding ? 'in-project' : 'hub',
      projectBindings: bindings,
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

    let card = defaultCard({ title: cleanTitle, template, summary: entity.description });
    let restoredPortable = false;
    const localCwd = bindings[0] && bindings[0].cwd;
    if (localCwd && fs.existsSync(localCwd)) {
      const existing = readPortableBoard(localCwd);
      if (existing.status === 200 && existing.body.exists && existing.body.content) {
        card = existing.body.content;
        restoredPortable = true;
      } else {
        savePortableBoard({ cwd: localCwd, content: card, now });
      }
    }

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
    return { status: 200, body: { ok: true, entity, restoredPortable } };
  }

  function saveEntityFile({ entityId, relPath, content, baseHash = '' }) {
    const wsRoot = root();
    const entity = findEntity(wsRoot, entityId);
    if (!entity) return { status: 404, body: 'Entidade não encontrada.' };
    const entityRoot = resolveEntityRoot(wsRoot, entity);
    if (!entityRoot) return { status: 400, body: 'Pasta da entidade inválida.' };
    if (!isSafeRelativePath(relPath) || isSecretPath(relPath)) return { status: 400, body: 'Caminho de arquivo inválido.' };
    const targetLex = resolveContainedPath(entityRoot, relPath);
    if (!targetLex || !isWithinRoot(entityRoot, targetLex)) return { status: 403, body: 'Caminho fora da entidade.' };
    const targetCheck = resolveSafeContainedTarget(entityRoot, relPath);
    if (!targetCheck.ok) return { status: 403, body: targetCheck.error || 'Caminho fora da entidade.' };
    const target = targetCheck.target;

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

    try {
      writeAtomicWithBackup({
        filePath: target,
        content: serialized,
        backupDir: backupsDir(isCard ? 'cards' : 'notes'),
        tag: `${entityId}_${relPath}`,
        rootDir: entityRoot,
      });
    } catch (e) {
      return { status: e.status || 500, body: e.message || 'Erro ao gravar arquivo da entidade.' };
    }

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
    fs.mkdirSync(wsRoot, { recursive: true });
    const baseDir = path.join(wsRoot, area);
    const targetLex = resolveContainedPath(baseDir, cleanName);
    if (!targetLex || !isWithinRoot(baseDir, targetLex)) return { status: 403, body: 'Caminho fora da área permitida.' };
    const targetCheck = resolveSafeContainedTarget(wsRoot, path.join(area, cleanName));
    if (!targetCheck.ok) return { status: 403, body: targetCheck.error || 'Caminho fora da área permitida.' };
    const target = targetCheck.target;
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
    try {
      writeAtomicWithBackup({
        filePath: target,
        content: serialized,
        backupDir: backupsDir(area),
        tag: `${area}_${cleanName}`,
        rootDir: wsRoot,
      });
    } catch (e) {
      return { status: e.status || 500, body: e.message || 'Erro ao gravar documento.' };
    }
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
    const targetLex = resolveContainedPath(entityRoot, rel);
    if (!targetLex || !isWithinRoot(entityRoot, targetLex)) return { status: 403, body: 'Caminho de mídia inválido.' };
    const targetCheck = resolveSafeContainedTarget(entityRoot, rel);
    if (!targetCheck.ok) return { status: 403, body: targetCheck.error || 'Caminho de mídia inválido.' };

    fs.mkdirSync(path.dirname(targetCheck.target), { recursive: true });
    fs.writeFileSync(targetCheck.target, buf);
    return { status: 200, body: { ok: true, path: rel, size: buf.length } };
  }

  function updateEntity({ id, title, description, group, pinned, hidden, projectBindings } = {}) {
    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);
    const idx = index.entities.findIndex((e) => e.id === id);
    if (idx < 0) return { status: 404, body: 'Entidade não encontrada.' };
    const cur = { ...index.entities[idx] };
    if (typeof title === 'string' && title.trim()) cur.title = title.trim().slice(0, 200);
    if (typeof description === 'string') cur.description = description.trim().slice(0, 1000);
    if (typeof pinned === 'boolean') cur.pinned = pinned;
    if (typeof hidden === 'boolean') {
      if (hidden) cur.hidden = true;
      else delete cur.hidden;
    }
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
    const gMeta = cur.group && index.groupMeta ? index.groupMeta[cur.group] : null;
    if (gMeta && gMeta.rootCwd && Array.isArray(cur.projectBindings) && cur.projectBindings.length) {
      for (const b of cur.projectBindings) {
        const bCwd = String(b.cwd || '').trim();
        if (!bCwd) continue;
        const chk = checkGroupSubfolder(gMeta.rootCwd, bCwd);
        if (chk === 'outside') {
          return { status: 400, body: `A pasta do projeto deve ser uma subpasta de "${gMeta.rootCwd}".` };
        }
        if (chk === 'same') {
          return { status: 400, body: `Selecione uma subpasta dentro de "${gMeta.rootCwd}", não a pasta raiz do workspace.` };
        }
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

  function saveGroup({ name = '', renameFrom = '', remove = false, machine, rootCwd, hidden } = {}) {
    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);
    let groups = Array.isArray(index.groups) ? [...index.groups] : [];
    for (const e of index.entities) if (e.group && !groups.includes(e.group)) groups.push(e.group);
    const groupMeta = { ...(index.groupMeta || {}) };

    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanFrom = String(renameFrom || '').trim().slice(0, 80);

    let entities = index.entities;
    if (remove && cleanName) {
      groups = groups.filter((g) => g !== cleanName);
      delete groupMeta[cleanName];
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
      if (cleanFrom !== cleanName && groupMeta[cleanFrom]) {
        groupMeta[cleanName] = groupMeta[cleanFrom];
        delete groupMeta[cleanFrom];
      }
      entities = entities.map((e) => (e.group === cleanFrom ? { ...e, group: cleanName } : e));
    } else {
      if (!cleanName) return { status: 400, body: 'Informe o nome do workspace.' };
      if (!groups.includes(cleanName)) groups.push(cleanName);
    }

    if (!remove && cleanName && (rootCwd !== undefined || machine !== undefined || typeof hidden === 'boolean')) {
      const prev = { ...(groupMeta[cleanName] || {}) };
      if (rootCwd !== undefined || machine !== undefined) {
        const cleanRoot = String(rootCwd || '').trim().slice(0, 500);
        const cleanMach = String(machine || '').trim().slice(0, 80);
        if (cleanRoot) {
          prev.rootCwd = cleanRoot;
          if (cleanMach) prev.machine = cleanMach;
          else delete prev.machine;
        } else {
          delete prev.rootCwd;
          delete prev.machine;
        }
      }
      if (typeof hidden === 'boolean') {
        if (hidden) prev.hidden = true;
        else delete prev.hidden;
      }
      if (Object.keys(prev).length > 0) groupMeta[cleanName] = prev;
      else delete groupMeta[cleanName];
    }

    const nextIndex = {
      format: index.format,
      version: index.version,
      ...(groups.length ? { groups } : {}),
      ...(Object.keys(groupMeta).length ? { groupMeta } : {}),
      entities,
    };
    try {
      saveIndex(nextIndex);
    } catch (e) {
      return { status: e.status || 400, body: e.message };
    }
    return { status: 200, body: { ok: true, groups, groupMeta } };
  }

  function deleteEntity({ id } = {}) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return { status: 400, body: 'Informe o id do projeto para apagar.' };
    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);
    const entity = index.entities.find((e) => e.id === cleanId);
    if (!entity) return { status: 404, body: 'Projeto não encontrado.' };

    const entities = index.entities.filter((e) => e.id !== cleanId);
    const nextIndex = { ...index, entities };
    try {
      saveIndex(nextIndex);
    } catch (e) {
      return { status: e.status || 400, body: e.message };
    }

    // Move apenas a pasta interna do card/notas (entities/...) para backups/deleted;
    // NUNCA apaga a pasta de código vinculada em projectBindings[].cwd.
    const entityRoot = resolveEntityRoot(wsRoot, entity);
    if (entityRoot && fs.existsSync(entityRoot)) {
      const trashDir = backupsDir('deleted');
      fs.mkdirSync(trashDir, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const dest = path.join(trashDir, `${stamp}_${cleanId}`);
      try { fs.renameSync(entityRoot, dest); } catch {}
    }
    return { status: 200, body: { ok: true, id: cleanId } };
  }

  function reorder({ groups, entityIds, moveEntity } = {}) {
    const wsRoot = root();
    const index = readWorkspaceJson(wsRoot);

    // 1. Reordenar workspaces (groups)
    let nextGroups = Array.isArray(index.groups) ? [...index.groups] : [];
    for (const e of index.entities) if (e.group && !nextGroups.includes(e.group)) nextGroups.push(e.group);
    if (Array.isArray(groups)) {
      const validSet = new Set(nextGroups);
      const ordered = [];
      for (const g of groups) {
        const clean = String(g || '').trim();
        if (clean && validSet.has(clean) && !ordered.includes(clean)) ordered.push(clean);
      }
      for (const g of nextGroups) if (!ordered.includes(g)) ordered.push(g);
      nextGroups = ordered;
    }

    // 2. Reordenar projetos (entities) e opcionalmente mover um projeto para outro workspace
    let nextEntities = index.entities.slice();
    if (moveEntity && moveEntity.id) {
      const targetIdx = nextEntities.findIndex((e) => e.id === moveEntity.id);
      if (targetIdx >= 0) {
        const cur = { ...nextEntities[targetIdx] };
        if (typeof moveEntity.group === 'string') {
          const destGroup = moveEntity.group.trim().slice(0, 80);
          const gMeta = destGroup && index.groupMeta ? index.groupMeta[destGroup] : null;
          if (gMeta && gMeta.rootCwd && Array.isArray(cur.projectBindings) && cur.projectBindings.length) {
            for (const b of cur.projectBindings) {
              const bCwd = String(b.cwd || '').trim();
              if (bCwd && checkGroupSubfolder(gMeta.rootCwd, bCwd) !== 'ok') {
                return { status: 400, body: `O projeto "${cur.title}" está fora da pasta raiz do workspace "${destGroup}".` };
              }
            }
          }
          if (destGroup) {
            cur.group = destGroup;
            if (!nextGroups.includes(destGroup)) nextGroups.push(destGroup);
          } else {
            delete cur.group;
          }
        }
        nextEntities[targetIdx] = cur;
      }
    }

    if (Array.isArray(entityIds)) {
      const byId = new Map(nextEntities.map((e) => [e.id, e]));
      const ordered = [];
      for (const id of entityIds) {
        const item = byId.get(id);
        if (item) {
          ordered.push(item);
          byId.delete(id);
        }
      }
      for (const rest of byId.values()) ordered.push(rest);
      nextEntities = ordered;
    }

    const nextIndex = {
      ...index,
      ...(nextGroups.length ? { groups: nextGroups } : {}),
      entities: nextEntities,
    };
    try {
      saveIndex(nextIndex);
    } catch (e) {
      return { status: e.status || 400, body: e.message };
    }
    return { status: 200, body: { ok: true, groups: nextGroups, entities: nextEntities } };
  }

  return { createEntity, updateEntity, deleteEntity, saveGroup, reorder, saveEntityFile, saveGlobalDoc, uploadEntityMedia };
}

module.exports = { createWorkspaceActions };
