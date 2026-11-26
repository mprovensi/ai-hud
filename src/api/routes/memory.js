// Rotas REST da Base de Memória Compartilhada por Projeto e Dreaming (/api/memory/*).
const { createCwdAuthorizer } = require('../cwd-auth');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { readWorkspaceJson } = require('../../collect/workspace');
const { readProjectMemory, listAllProjectMemories, collectMemorySessions, readDreamUsageLog } = require('../../collect/memory');

module.exports = ({ dataDir, config, collector, memory, json, text }) => {
  const wsRoot = () => resolveWorkspaceRoot(dataDir, config);
  const checkAuthorizedCwd = createCwdAuthorizer({ dataDir, config, collector });

  function authorizeMemoryRequest(cwd, mode) {
    const cleanCwd = String(cwd || '').trim();
    const cleanMode = String(mode || '').trim();
    if (cleanMode === 'in-repo' && !cleanCwd) {
      return { ok: false, status: 400, reason: 'Informe cwd autorizado para o modo in-repo.' };
    }
    if (!cleanCwd) return { ok: true };
    const chk = checkAuthorizedCwd(cleanCwd);
    return chk.ok ? { ok: true } : { ok: false, status: 403, reason: chk.reason };
  }

  return [
    { method: 'GET', path: '/api/memory', handler: ({ res, url }) => {
      const project = (url.searchParams.get('project') || '').trim();
      const cwd = (url.searchParams.get('cwd') || '').trim();
      const mode = (url.searchParams.get('mode') || '').trim();
      const sessions = collectMemorySessions(collector);
      if (!project && !cwd) {
        const ws = readWorkspaceJson(wsRoot());
        return json(res, {
          projects: listAllProjectMemories({ workspaceRoot: wsRoot(), sessions, workspaceEntities: ws.entities }),
          schedule: (config && config.dream && config.dream.schedule) || { enabled: false, hour: 3, workspaceOnly: true },
          usage: readDreamUsageLog(wsRoot()),
        });
      }
      const auth = authorizeMemoryRequest(cwd, mode);
      if (!auth.ok) return text(res, auth.status, auth.reason);
      return json(res, readProjectMemory({ workspaceRoot: wsRoot(), project, cwd, mode, sessions }));
    } },

    { method: 'PUT', path: '/api/memory/file', json: true, maxBytes: 512 * 1024, handler: ({ res, body }) => {
      const auth = authorizeMemoryRequest(body.cwd, body.mode);
      if (!auth.ok) return text(res, auth.status, auth.reason);
      const r = memory.saveMemoryFile({
        project: body.project,
        cwd: body.cwd,
        mode: body.mode,
        file: body.file,
        content: body.content,
        baseHash: body.baseHash || '',
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/memory/dream', json: true, maxBytes: 64 * 1024, handler: async ({ res, body }) => {
      const auth = authorizeMemoryRequest(body.cwd, body.mode);
      if (!auth.ok) return text(res, auth.status, auth.reason);
      const r = await memory.dream({
        project: body.project,
        cwd: body.cwd,
        mode: body.mode,
        engine: body.engine,
        model: body.model,
        dryRun: !!body.dryRun,
        force: !!body.force,
        ignoreQuota: body.ignoreQuota === true,
      });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/memory/undo', json: true, handler: ({ res, body }) => {
      const auth = authorizeMemoryRequest(body.cwd, body.mode);
      if (!auth.ok) return text(res, auth.status, auth.reason);
      const r = memory.undoDream({ project: body.project, cwd: body.cwd, mode: body.mode });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/memory/bridges', json: true, handler: ({ res, body }) => {
      const auth = authorizeMemoryRequest(body.cwd, body.mode || 'in-repo');
      if (!auth.ok) return text(res, auth.status, auth.reason);
      const r = memory.installBridges({ project: body.project, cwd: body.cwd, mode: body.mode });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },
  ];
};
