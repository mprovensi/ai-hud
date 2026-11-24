// Rotas REST do AI Workspace file-first (/api/workspace/*), incluindo armazenamento portátil em <cwd>/.ai-workspace/,
// Docs & Specs reais do projeto, importação 0-token e workflow EGM Lite (Goldfish review + estruturação opcional).
const fs = require('fs');
const os = require('os');
const { isCwdAllowed } = require('../../core/path-guard');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { recentCwds } = require('../../collect/capabilities');
const { readWorkspaceJson, readWorkspaceIndex, findEntity, readEntityFile, readGlobalDoc, resolveEntityAsset } = require('../../collect/workspace');
const { listProjectDocs, readProjectDoc, readPortableBoard, readWorkflowUsageLog } = require('../../collect/workspace/project-docs');
const { readProjectMemory } = require('../../collect/memory');
const {
  savePortableBoard,
  saveProjectDoc,
  createSpecDoc,
  saveReviewReport,
  importDocsToBoard,
  undoPortableBoard,
  syncDocCheckbox,
} = require('../../actions/workspace/project-storage');

const REPORT_CSP = "default-src 'self' data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

module.exports = ({ dataDir, config, collector, peers, machineName, workspace, workspaceSync, workspaceWorkflow, relay, send, json, text }) => {
  const wsRoot = () => resolveWorkspaceRoot(dataDir, config);

  function checkAuthorizedCwd(cwd, isPeerLocal = false) {
    if (isPeerLocal && !(config && config.strictRemoteCwd)) return { ok: true };
    const knownCwds = recentCwds((collector && collector.current().sessions) || [], (config && config.pinnedProjects) || []);
    const wsRoots = [];
    try {
      const ws = readWorkspaceJson(wsRoot());
      for (const m of Object.values(ws.groupMeta || {})) if (m && m.rootCwd) wsRoots.push(m.rootCwd);
      for (const e of (ws.entities || [])) {
        for (const b of (e.projectBindings || [])) if (b && b.cwd) wsRoots.push(b.cwd);
      }
    } catch {}
    return isCwdAllowed(cwd, {
      allowedRoots: [...((config && config.allowedRoots) || []), ...wsRoots],
      knownCwds,
      home: os.homedir(),
      strict: true,
    });
  }

  // Resolve `{ entity, cwd, machine, peer }` a partir de entityId ou (cwd, machine)
  function resolveTarget({ entityId = '', cwd = '', machine = '', isLocalCall = false }) {
    const entity = entityId ? findEntity(wsRoot(), entityId) : null;
    const binding = entity && Array.isArray(entity.projectBindings) && entity.projectBindings[0];
    const targetCwd = String(cwd || (binding && binding.cwd) || '').trim();
    const targetMachine = String(machine || (binding && binding.machine) || '').trim();
    const peer = !isLocalCall && targetMachine && targetMachine !== machineName && peers
      ? peers.list.find((p) => p.name === targetMachine) || null
      : null;
    return { entity, cwd: targetCwd, machine: targetMachine, peer };
  }

  async function forwardJson(peer, method, routePath, body) {
    const r = await peers.forward(peer, method, routePath, body);
    return { status: r.status, json: r.json, text: r.text };
  }

  return [
    { method: 'GET', path: '/api/workspace/index', handler: ({ res }) => {
      json(res, readWorkspaceIndex(wsRoot()));
    } },

    { method: 'GET', path: '/api/workspace/usage', handler: ({ res }) => {
      json(res, readWorkflowUsageLog(wsRoot()));
    } },

    { method: 'GET', path: '/api/workspace/sync', handler: async ({ res }) => {
      if (!workspaceSync) return text(res, 501, 'Sincronização indisponível.');
      json(res, await workspaceSync.status());
    } },

    { method: 'POST', path: '/api/workspace/sync', json: true, maxBytes: 16 * 1024, handler: async ({ res, body }) => {
      if (!workspaceSync) return text(res, 501, 'Sincronização indisponível.');
      const r = await workspaceSync.sync({
        init: !!body.init,
        remote: body.remote || '',
        message: body.message || '',
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/entity', json: true, maxBytes: 128 * 1024, handler: ({ res, body }) => {
      const r = workspace.createEntity(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'PUT', path: '/api/workspace/entity', json: true, maxBytes: 128 * 1024, handler: ({ res, body }) => {
      const r = workspace.updateEntity(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/entity/delete', json: true, maxBytes: 4096, handler: ({ res, body }) => {
      const r = workspace.deleteEntity(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/group', json: true, maxBytes: 16 * 1024, handler: ({ res, body }) => {
      const r = workspace.saveGroup(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/workspace/entity/file', handler: ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const rel = url.searchParams.get('path') || '';
      const r = readEntityFile(wsRoot(), id, rel);
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'PUT', path: '/api/workspace/entity/file', json: true, maxBytes: 2 * 1024 * 1024, handler: ({ res, body }) => {
      const r = workspace.saveEntityFile({
        entityId: body.id,
        relPath: body.path,
        content: body.content,
        baseHash: body.baseHash || '',
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/workspace/entity/asset', handler: ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const rel = url.searchParams.get('path') || '';
      const r = resolveEntityAsset(wsRoot(), id, rel);
      if (r.status !== 200) return text(res, r.status, r.error);
      try {
        const buf = fs.readFileSync(r.filePath);
        const headers = r.isHtml
          ? { 'Content-Security-Policy': REPORT_CSP, 'X-Content-Type-Options': 'nosniff' }
          : { 'X-Content-Type-Options': 'nosniff' };
        return send(res, 200, r.contentType, buf, headers);
      } catch {
        return text(res, 500, 'Não foi possível ler o asset.');
      }
    } },

    { method: 'POST', path: '/api/workspace/entity/media', json: true, maxBytes: 15 * 1024 * 1024, handler: ({ res, body }) => {
      const r = workspace.uploadEntityMedia({
        entityId: body.id,
        fileName: body.fileName,
        base64Data: body.base64Data,
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/workspace/doc', handler: ({ res, url }) => {
      const area = url.searchParams.get('area') || '';
      const name = url.searchParams.get('name') || '';
      const r = readGlobalDoc(wsRoot(), area, name);
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'PUT', path: '/api/workspace/doc', json: true, maxBytes: 2 * 1024 * 1024, handler: ({ res, body }) => {
      const r = workspace.saveGlobalDoc({
        area: body.area,
        name: body.name,
        content: body.content,
        baseHash: body.baseHash || '',
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    // ---- Docs & Specs reais do projeto + Quadro portátil em <cwd>/.ai-workspace/ ----

    { method: 'GET', path: '/api/workspace/project/docs', handler: async ({ res, url }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const target = resolveTarget({
        entityId: url.searchParams.get('entityId') || '',
        cwd: url.searchParams.get('cwd') || '',
        machine: url.searchParams.get('machine') || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd) return text(res, 400, 'Projeto sem pasta vinculada.');
      if (target.peer) {
        const q = `/api/workspace/project/docs?local=1&cwd=${encodeURIComponent(target.cwd)}`;
        return relay(res, peers.forward(target.peer, 'GET', q));
      }
      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = listProjectDocs(target.cwd);
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'GET', path: '/api/workspace/project/doc', handler: async ({ res, url }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const relPath = url.searchParams.get('path') || '';
      const target = resolveTarget({
        entityId: url.searchParams.get('entityId') || '',
        cwd: url.searchParams.get('cwd') || '',
        machine: url.searchParams.get('machine') || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd || !relPath) return text(res, 400, 'Informe pasta do projeto e caminho do documento.');
      if (target.peer) {
        const q = `/api/workspace/project/doc?local=1&cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(relPath)}`;
        return relay(res, peers.forward(target.peer, 'GET', q));
      }
      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = readProjectDoc(target.cwd, relPath);
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'PUT', path: '/api/workspace/project/doc', json: true, maxBytes: 2 * 1024 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const target = resolveTarget({
        entityId: body.entityId || '',
        cwd: body.cwd || '',
        machine: body.machine || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd || !body.path) return text(res, 400, 'Informe pasta do projeto e caminho do documento.');
      if (target.peer) {
        return relay(res, peers.forward(target.peer, 'PUT', '/api/workspace/project/doc?local=1', {
          cwd: target.cwd,
          path: body.path,
          content: body.content,
          baseHash: body.baseHash || '',
        }));
      }
      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = saveProjectDoc({ cwd: target.cwd, relPath: body.path, content: body.content, baseHash: body.baseHash || '' });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/project/spec', json: true, maxBytes: 128 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const target = resolveTarget({
        entityId: body.entityId || '',
        cwd: body.cwd || '',
        machine: body.machine || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd) return text(res, 400, 'Projeto sem pasta vinculada.');
      if (target.peer) {
        return relay(res, peers.forward(target.peer, 'POST', '/api/workspace/project/spec?local=1', {
          cwd: target.cwd,
          title: body.title,
          summary: body.summary || '',
          folder: body.folder || 'docs/specs',
        }));
      }
      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = createSpecDoc({ cwd: target.cwd, title: body.title, summary: body.summary || '', folder: body.folder || 'docs/specs' });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/project/review-save', json: true, maxBytes: 256 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const target = resolveTarget({ cwd: body.cwd || '', machine: body.machine || '', isLocalCall: isLocal });
      if (!target.cwd) return text(res, 400, 'Informe cwd.');
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = saveReviewReport({ cwd: target.cwd, docPath: body.docPath, markdown: body.markdown });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/workspace/project/board', handler: async ({ res, url }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const entityId = url.searchParams.get('entityId') || '';
      const target = resolveTarget({
        entityId,
        cwd: url.searchParams.get('cwd') || '',
        machine: url.searchParams.get('machine') || '',
        isLocalCall: isLocal,
      });

      // Chamada direta em peer (?local=1)
      if (isLocal) {
        if (!target.cwd) return text(res, 400, 'Informe cwd.');
        const chk = checkAuthorizedCwd(target.cwd, true);
        if (!chk.ok) return text(res, 403, chk.reason);
        const r = readPortableBoard(target.cwd);
        return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
      }

      // Entidade sem cwd → usa arquivo no Hub (compatível com projetos/pesquisas sem pasta)
      if (!target.cwd) {
        if (!entityId) return text(res, 400, 'Informe entityId ou cwd.');
        const hub = readEntityFile(wsRoot(), entityId, 'overview.card.json');
        return hub.status !== 200 ? text(res, hub.status, hub.error) : json(res, { ...hub.body, storage: 'hub', exists: true });
      }

      const loadHubMirror = () => (entityId ? readEntityFile(wsRoot(), entityId, 'overview.card.json') : null);

      // Tenta ler <cwd>/.ai-workspace/board.card.json (local ou via peer)
      try {
        let portable = null;
        if (target.peer) {
          const pr = await forwardJson(target.peer, 'GET', `/api/workspace/project/board?local=1&cwd=${encodeURIComponent(target.cwd)}`);
          if (pr.status === 200 && pr.json) portable = pr.json;
        } else if (!target.machine || target.machine === machineName) {
          const chk = checkAuthorizedCwd(target.cwd, false);
          if (!chk.ok) return text(res, 403, chk.reason);
          const lr = readPortableBoard(target.cwd);
          if (lr.status === 200) portable = lr.body;
        }

        if (portable && portable.exists && portable.content) {
          // Espelha cópia de leitura no Hub para resiliência caso a máquina fique offline
          if (entityId) {
            try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: portable.content }); } catch {}
          }
          return json(res, portable);
        }

        // Ainda não existe .ai-workspace/board.card.json no projeto → migra automaticamente do espelho do Hub se existir!
        const hub = loadHubMirror();
        if (hub && hub.status === 200 && hub.body.content) {
          if (target.peer) {
            const seeded = await forwardJson(target.peer, 'PUT', '/api/workspace/project/board?local=1', {
              cwd: target.cwd,
              content: hub.body.content,
            }).catch(() => null);
            if (seeded && seeded.status === 200 && seeded.json) {
              return json(res, {
                ok: true,
                exists: true,
                migrated: true,
                storage: 'in-project',
                path: seeded.json.path,
                content: hub.body.content,
                hash: seeded.json.hash,
              });
            }
          } else if (!target.machine || target.machine === machineName) {
            const seeded = savePortableBoard({ cwd: target.cwd, content: hub.body.content });
            if (seeded.status === 200) {
              return json(res, {
                ok: true,
                exists: true,
                migrated: true,
                storage: 'in-project',
                path: seeded.body.path,
                content: hub.body.content,
                hash: seeded.body.hash,
              });
            }
          }
          return json(res, { ...hub.body, storage: 'hub-cache', offlineFallback: !!target.peer });
        }
        return json(res, portable || { ok: true, exists: false, storage: 'in-project', content: null, hash: '' });
      } catch {
        // Peer offline: devolve espelho em cache do Hub com flag offlineFallback
        const hub = loadHubMirror();
        if (hub && hub.status === 200) {
          return json(res, { ...hub.body, storage: 'hub-cache', offlineFallback: true });
        }
        return text(res, 502, `Máquina "${target.machine || 'remota'}" não respondeu ao ler o quadro.`);
      }
    } },

    { method: 'PUT', path: '/api/workspace/project/board', json: true, maxBytes: 2 * 1024 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const entityId = body.entityId || '';
      const target = resolveTarget({
        entityId,
        cwd: body.cwd || '',
        machine: body.machine || '',
        isLocalCall: isLocal,
      });

      if (isLocal) {
        if (!target.cwd) return text(res, 400, 'Informe cwd.');
        const chk = checkAuthorizedCwd(target.cwd, true);
        if (!chk.ok) return text(res, 403, chk.reason);
        const r = savePortableBoard({ cwd: target.cwd, content: body.content, baseHash: body.baseHash || '' });
        return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
      }

      if (!target.cwd) {
        if (!entityId) return text(res, 400, 'Informe entityId ou cwd.');
        const r = workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: body.content, baseHash: body.baseHash || '' });
        return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, { ...r.body, storage: 'hub' }, r.status);
      }

      if (target.peer) {
        try {
          const pr = await forwardJson(target.peer, 'PUT', '/api/workspace/project/board?local=1', {
            cwd: target.cwd,
            content: body.content,
            baseHash: body.baseHash || '',
          });
          if (pr.status === 200 && entityId) {
            try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: body.content }); } catch {}
          }
          return send(res, pr.status, pr.status === 200 || pr.status === 409 ? 'application/json' : 'text/plain; charset=utf-8', pr.text);
        } catch {
          return text(res, 502, `Máquina "${target.machine}" está offline — não foi possível gravar em .ai-workspace/.`);
        }
      }

      if (target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, false);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = savePortableBoard({ cwd: target.cwd, content: body.content, baseHash: body.baseHash || '' });
      if (r.status === 200 && entityId) {
        try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: body.content }); } catch {}
      }
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/project/import-docs', json: true, maxBytes: 128 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const entityId = body.entityId || '';
      const target = resolveTarget({
        entityId,
        cwd: body.cwd || '',
        machine: body.machine || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd) return text(res, 400, 'Projeto sem pasta vinculada para importar documentos.');

      if (target.peer) {
        try {
          const pr = await forwardJson(target.peer, 'POST', '/api/workspace/project/import-docs?local=1', {
            cwd: target.cwd,
            paths: body.paths || null,
            dryRun: !!body.dryRun,
            title: (target.entity && target.entity.title) || body.title || '',
          });
          if (pr.status === 200 && !body.dryRun && pr.json && pr.json.board && entityId) {
            try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: pr.json.board }); } catch {}
          }
          return send(res, pr.status, pr.status === 200 ? 'application/json' : 'text/plain; charset=utf-8', pr.text);
        } catch {
          return text(res, 502, `Máquina "${target.machine}" não respondeu ao importar docs.`);
        }
      }

      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = importDocsToBoard({
        cwd: target.cwd,
        paths: body.paths || null,
        dryRun: !!body.dryRun,
        title: (target.entity && target.entity.title) || body.title || '',
      });
      if (r.status === 200 && !body.dryRun && r.body && r.body.board && entityId) {
        try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: r.body.board }); } catch {}
      }
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/project/board-undo', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const entityId = body.entityId || '';
      const target = resolveTarget({
        entityId,
        cwd: body.cwd || '',
        machine: body.machine || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd) return text(res, 400, 'Desfazer quadro requer projeto com pasta vinculada (.ai-workspace).');
      if (target.peer) {
        try {
          const pr = await forwardJson(target.peer, 'POST', '/api/workspace/project/board-undo?local=1', { cwd: target.cwd });
          if (pr.status === 200 && pr.json && pr.json.board && entityId) {
            try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: pr.json.board }); } catch {}
          }
          return send(res, pr.status, pr.status === 200 ? 'application/json' : 'text/plain; charset=utf-8', pr.text);
        } catch {
          return text(res, 502, `Máquina "${target.machine}" não respondeu ao desfazer o quadro.`);
        }
      }
      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = undoPortableBoard({ cwd: target.cwd });
      if (r.status === 200 && r.body && r.body.board && entityId) {
        try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: r.body.board }); } catch {}
      }
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/workspace/project/sync-checkbox', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const target = resolveTarget({
        entityId: body.entityId || '',
        cwd: body.cwd || '',
        machine: body.machine || '',
        isLocalCall: isLocal,
      });
      if (!target.cwd || !body.docRef) return text(res, 400, 'Informe projeto e docRef.');
      if (target.peer) {
        return relay(res, peers.forward(target.peer, 'POST', '/api/workspace/project/sync-checkbox?local=1', {
          cwd: target.cwd,
          docRef: body.docRef,
          title: body.title || '',
          done: !!body.done,
        }));
      }
      if (!isLocal && target.machine && target.machine !== machineName) {
        return text(res, 404, `Máquina "${target.machine}" não encontrada.`);
      }
      const chk = checkAuthorizedCwd(target.cwd, isLocal);
      if (!chk.ok) return text(res, 403, chk.reason);
      const r = syncDocCheckbox({ cwd: target.cwd, docRef: body.docRef, title: body.title || '', done: !!body.done });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    // ---- EGM Lite: Revisão Goldfish (1 chamada isolada) + Estruturação opcional por IA ----

    { method: 'POST', path: '/api/workspace/project/review', json: true, maxBytes: 256 * 1024, handler: async ({ res, body }) => {
      if (!workspaceWorkflow) return text(res, 501, 'Motor EGM Lite indisponível.');
      const entityId = body.entityId || '';
      const docPath = String(body.docPath || '').split('#')[0].trim();
      const target = resolveTarget({ entityId, cwd: body.cwd || '', machine: body.machine || '' });
      if (!target.cwd || !docPath) return text(res, 400, 'Informe o projeto e o caminho do documento para revisão.');

      // 1. Lê o conteúdo do doc (local ou via peer)
      let docContent = '';
      if (target.peer) {
        const pr = await forwardJson(target.peer, 'GET', `/api/workspace/project/doc?local=1&cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(docPath)}`).catch(() => null);
        if (!pr || pr.status !== 200 || !pr.json) return text(res, (pr && pr.status) || 502, (pr && pr.text) || 'Não foi possível ler o documento no peer.');
        docContent = pr.json.content || '';
      } else {
        const chk = checkAuthorizedCwd(target.cwd, false);
        if (!chk.ok) return text(res, 403, chk.reason);
        const lr = readProjectDoc(target.cwd, docPath);
        if (lr.status !== 200) return text(res, lr.status, lr.error);
        docContent = lr.body.content || '';
      }

      const projectLabel = (target.entity && target.entity.title) || body.project || target.cwd;
      const mem = readProjectMemory({ workspaceRoot: wsRoot(), project: projectLabel, cwd: target.peer ? '' : target.cwd });

      const rev = await workspaceWorkflow.reviewSpec({
        project: projectLabel,
        docPath,
        docContent,
        pinnedMd: (mem && mem.files && mem.files['pinned.md']) || '',
        memoryMd: (mem && mem.files && mem.files['MEMORY.md']) || '',
        engine: body.engine || '',
        model: body.model || '',
        dryRun: !!body.dryRun,
        ignoreQuota: body.ignoreQuota !== false,
      });
      if (rev.status !== 200 || body.dryRun) {
        return typeof rev.body === 'string' ? text(res, rev.status, rev.body) : json(res, rev.body, rev.status);
      }

      // 2. Salva parecer em <cwd>/.ai-workspace/reviews/<slug>.md
      let reportPath = '';
      if (target.peer) {
        const sv = await forwardJson(target.peer, 'POST', '/api/workspace/project/review-save?local=1', {
          cwd: target.cwd,
          docPath,
          markdown: rev.body.markdown,
        }).catch(() => null);
        if (sv && sv.status === 200 && sv.json) reportPath = sv.json.reportPath || '';
      } else {
        const sv = saveReviewReport({ cwd: target.cwd, docPath, markdown: rev.body.markdown });
        if (sv.status === 200) reportPath = sv.body.reportPath || '';
      }

      // 3. Atualiza selo `review` no item correspondente do quadro portátil (se itemId ou docRef coincidir)
      const reviewBadge = {
        status: rev.body.verdict === 'approved' ? 'approved' : 'changes',
        at: Date.now(),
        summary: rev.body.summary,
        ...(reportPath ? { reportPath } : {}),
      };
      try {
        let boardObj = null;
        if (target.peer) {
          const br = await forwardJson(target.peer, 'GET', `/api/workspace/project/board?local=1&cwd=${encodeURIComponent(target.cwd)}`);
          if (br.status === 200 && br.json && br.json.content) boardObj = br.json.content;
        } else {
          const br = readPortableBoard(target.cwd);
          if (br.status === 200 && br.body.content) boardObj = br.body.content;
        }
        if (boardObj && Array.isArray(boardObj.items)) {
          let changed = false;
          const normDoc = docPath.toLowerCase();
          const nextItems = boardObj.items.map((it) => {
            const matchId = body.itemId && it.id === body.itemId;
            const matchDoc = it.docRef && it.docRef.split('#')[0].toLowerCase() === normDoc;
            if (!matchId && !matchDoc) return it;
            changed = true;
            return { ...it, review: reviewBadge };
          });
          if (changed) {
            const nextBoard = { ...boardObj, items: nextItems };
            if (target.peer) {
              await forwardJson(target.peer, 'PUT', '/api/workspace/project/board?local=1', { cwd: target.cwd, content: nextBoard });
            } else {
              savePortableBoard({ cwd: target.cwd, content: nextBoard });
            }
            if (entityId) {
              try { workspace.saveEntityFile({ entityId, relPath: 'overview.card.json', content: nextBoard }); } catch {}
            }
          }
        }
      } catch {}

      return json(res, { ...rev.body, reportPath, review: reviewBadge });
    } },

    { method: 'POST', path: '/api/workspace/project/structure-ai', json: true, maxBytes: 256 * 1024, handler: async ({ res, body }) => {
      if (!workspaceWorkflow) return text(res, 501, 'Motor EGM Lite indisponível.');
      const entityId = body.entityId || '';
      const docPaths = Array.isArray(body.docPaths) ? body.docPaths.slice(0, 8) : [];
      const target = resolveTarget({ entityId, cwd: body.cwd || '', machine: body.machine || '' });
      if (!target.cwd || !docPaths.length) return text(res, 400, 'Informe o projeto e ao menos um documento.');

      const docs = [];
      for (const p of docPaths) {
        if (target.peer) {
          const pr = await forwardJson(target.peer, 'GET', `/api/workspace/project/doc?local=1&cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(p)}`).catch(() => null);
          if (pr && pr.status === 200 && pr.json) docs.push({ path: pr.json.path, content: pr.json.content || '' });
        } else {
          const chk = checkAuthorizedCwd(target.cwd, false);
          if (!chk.ok) return text(res, 403, chk.reason);
          const lr = readProjectDoc(target.cwd, p);
          if (lr.status === 200) docs.push({ path: lr.body.path, content: lr.body.content || '' });
        }
      }
      if (!docs.length) return text(res, 404, 'Nenhum dos documentos selecionados pôde ser lido.');

      const projectLabel = (target.entity && target.entity.title) || body.project || target.cwd;
      const r = await workspaceWorkflow.structureDocsWithAi({
        project: projectLabel,
        docs,
        engine: body.engine || '',
        model: body.model || '',
        dryRun: !!body.dryRun,
        ignoreQuota: body.ignoreQuota !== false,
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },
  ];
};
