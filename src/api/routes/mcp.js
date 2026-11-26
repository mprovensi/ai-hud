// Rotas REST do Catálogo de MCPs Compartilhados (/api/mcp/*), com suporte multi-máquina (?machine=).
const { createCwdAuthorizer } = require('../cwd-auth');

module.exports = ({ mcp, peers, machineName, dataDir, config, collector, relay, json, text }) => {
  const checkAuthorizedCwd = createCwdAuthorizer({ dataDir, config, collector });

  function findPeer(url, machine) {
    if (url.searchParams.get('local') === '1' || !machine || machine === machineName) return null;
    if (!peers || !Array.isArray(peers.list)) return { missing: true, name: machine };
    return peers.list.find((p) => p.name === machine) || { missing: true, name: machine };
  }

  return [
    { method: 'GET', path: '/api/mcp/status', handler: ({ res, url }) => {
      if (!mcp) return text(res, 501, 'Gerenciador MCP indisponível.');
      const machine = (url.searchParams.get('machine') || '').trim();
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `Máquina "${machine}" não encontrada.`);
      if (peer) return relay(res, peers.forward(peer, 'GET', '/api/mcp/status?local=1'));
      return json(res, mcp.getStatus());
    } },

    { method: 'PUT', path: '/api/mcp/server', json: true, maxBytes: 128 * 1024, handler: ({ res, url, body }) => {
      if (!mcp) return text(res, 501, 'Gerenciador MCP indisponível.');
      const machine = String((body && body.machine) || '').trim();
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `Máquina "${machine}" não encontrada.`);
      if (peer) return relay(res, peers.forward(peer, 'PUT', '/api/mcp/server?local=1', { server: body.server, secrets: body.secrets }));
      const r = mcp.upsertServer({ server: body.server, secrets: body.secrets });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/mcp/delete', json: true, maxBytes: 8 * 1024, handler: ({ res, url, body }) => {
      if (!mcp) return text(res, 501, 'Gerenciador MCP indisponível.');
      const machine = String((body && body.machine) || '').trim();
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `Máquina "${machine}" não encontrada.`);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/mcp/delete?local=1', { id: body.id }));
      const r = mcp.deleteServer({ id: body.id });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/mcp/import', json: true, maxBytes: 8 * 1024, handler: ({ res, url, body }) => {
      if (!mcp) return text(res, 501, 'Gerenciador MCP indisponível.');
      const machine = String((body && body.machine) || '').trim();
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `Máquina "${machine}" não encontrada.`);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/mcp/import?local=1', { targets: body && body.targets }));
      const r = mcp.importFromClis({ targets: body && body.targets });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/mcp/preset/memory', json: true, maxBytes: 4 * 1024, handler: ({ res, url, body }) => {
      if (!mcp) return text(res, 501, 'Gerenciador MCP indisponível.');
      const machine = String((body && body.machine) || '').trim();
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `Máquina "${machine}" não encontrada.`);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/mcp/preset/memory?local=1', { sync: body ? body.sync !== false : true }));
      const r = mcp.installMemoryPreset({ sync: body ? body.sync !== false : true });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/mcp/sync', json: true, maxBytes: 16 * 1024, handler: ({ res, url, body }) => {
      if (!mcp) return text(res, 501, 'Gerenciador MCP indisponível.');
      const machine = String((body && body.machine) || '').trim();
      const projectCwd = String((body && body.projectCwd) || '').trim();
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `Máquina "${machine}" não encontrada.`);
      if (peer) {
        return relay(res, peers.forward(peer, 'POST', '/api/mcp/sync?local=1', {
          targets: body && body.targets,
          projectCwd,
        }));
      }
      if (projectCwd) {
        const chk = checkAuthorizedCwd(projectCwd);
        if (!chk.ok) return text(res, 403, chk.reason);
      }
      const r = mcp.syncToClis({ targets: body && body.targets, projectCwd });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },
  ];
};
