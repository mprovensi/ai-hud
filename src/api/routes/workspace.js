// Rotas REST do AI Workspace file-first (/api/workspace/*).
const fs = require('fs');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { readWorkspaceIndex, readEntityFile, readGlobalDoc, resolveEntityAsset } = require('../../collect/workspace');

const REPORT_CSP = "default-src 'self' data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

module.exports = ({ dataDir, config, workspace, workspaceSync, send, json, text }) => {
  const wsRoot = () => resolveWorkspaceRoot(dataDir, config);

  return [
    { method: 'GET', path: '/api/workspace/index', handler: ({ res }) => {
      json(res, readWorkspaceIndex(wsRoot()));
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
  ];
};
