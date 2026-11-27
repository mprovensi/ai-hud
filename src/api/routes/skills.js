// Rotas de Skills e Plugins compartilhados (/api/skills, /api/skills/catalog, /share, /batch-share, /plugin-update).
// Suporta encaminhamento multi-máquina (?machine=) para consultar/linkar skills na máquina dona dos projetos.
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { collectSkills } = require('../../collect/skills');

module.exports = ({ dataDir, config, skills, peers, machineName, relay, json, text }) => {
  function targetPeer(machine, isLocal) {
    if (isLocal || !machine || machine === machineName || !peers) return null;
    return peers.list.find((p) => p.name === machine) || null;
  }

  return [
    { method: 'GET', path: '/api/skills', handler: async ({ res, url }) => {
      const isLocal = url.searchParams.get('local') === '1';
      const cwd = (url.searchParams.get('cwd') || '').trim();
      const machine = (url.searchParams.get('machine') || '').trim();
      const tool = (url.searchParams.get('tool') || '').trim();
      const peer = targetPeer(machine, isLocal);
      if (peer) {
        const q = `/api/skills?local=1&cwd=${encodeURIComponent(cwd)}&tool=${encodeURIComponent(tool)}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const list = collectSkills({ workspaceRoot: resolveWorkspaceRoot(dataDir, config), cwd, tool });
      json(res, { skills: list });
    } },

    { method: 'GET', path: '/api/skills/catalog', handler: async ({ res, url }) => {
      if (!skills) return text(res, 501, 'Catálogo de skills indisponível.');
      const isLocal = url.searchParams.get('local') === '1';
      const machine = (url.searchParams.get('machine') || '').trim();
      const peer = targetPeer(machine, isLocal);
      if (peer) return relay(res, peers.forward(peer, 'GET', '/api/skills/catalog?local=1'));
      if (!isLocal && machine && machine !== machineName) {
        return text(res, 404, `Máquina "${machine}" não encontrada.`);
      }
      json(res, skills.getCatalog());
    } },

    { method: 'POST', path: '/api/skills/share', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!skills) return text(res, 501, 'Catálogo de skills indisponível.');
      const isLocal = url.searchParams.get('local') === '1';
      const machine = String((body && body.machine) || '').trim();
      const peer = targetPeer(machine, isLocal);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/skills/share?local=1', { ...body, machine: '' }));
      if (!isLocal && machine && machine !== machineName) {
        return text(res, 404, `Máquina "${machine}" não encontrada.`);
      }
      const r = skills.shareSkill(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/skills/batch-share', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!skills) return text(res, 501, 'Catálogo de skills indisponível.');
      const isLocal = url.searchParams.get('local') === '1';
      const machine = String((body && body.machine) || '').trim();
      const peer = targetPeer(machine, isLocal);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/skills/batch-share?local=1', { ...body, machine: '' }));
      if (!isLocal && machine && machine !== machineName) {
        return text(res, 404, `Máquina "${machine}" não encontrada.`);
      }
      const r = skills.batchShare(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/skills/plugin-update', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!skills) return text(res, 501, 'Catálogo de skills indisponível.');
      const isLocal = url.searchParams.get('local') === '1';
      const machine = String((body && body.machine) || '').trim();
      const peer = targetPeer(machine, isLocal);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/skills/plugin-update?local=1', { ...body, machine: '' }));
      if (!isLocal && machine && machine !== machineName) {
        return text(res, 404, `Máquina "${machine}" não encontrada.`);
      }
      const r = skills.updateClaudePluginCache(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },
  ];
};
