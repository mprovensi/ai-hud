// Rotas de execução de projetos multi-stack (/api/run/*), com proxy multi-máquina (local=1).
const os = require('os');
const { isCwdAllowed } = require('../../core/path-guard');
const { recentCwds } = require('../../collect/capabilities');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { readWorkspaceJson } = require('../../collect/workspace');

module.exports = ({ projectRunner, peers, collector, dataDir, config, machineName, relay, json, text }) => {
  function checkAuthorizedCwd(cwd) {
    const knownCwds = recentCwds((collector && collector.current().sessions) || [], (config && config.pinnedProjects) || []);
    const wsRoots = [];
    if (dataDir) {
      try {
        const ws = readWorkspaceJson(resolveWorkspaceRoot(dataDir, config));
        for (const m of Object.values(ws.groupMeta || {})) if (m && m.rootCwd) wsRoots.push(m.rootCwd);
        for (const e of (ws.entities || [])) {
          for (const b of (e.projectBindings || [])) if (b && b.cwd) wsRoots.push(b.cwd);
        }
      } catch {}
    }
    return isCwdAllowed(cwd, {
      allowedRoots: [...((config && config.allowedRoots) || []), ...wsRoots],
      knownCwds,
      home: os.homedir(),
      strict: true,
    });
  }

  function findPeer(url, machine) {
    if (url.searchParams.get('local') === '1' || !machine || machine === machineName) return null;
    return peers.list.find((p) => p.name === machine) || { missing: true, name: machine };
  }

  return [
    { method: 'GET', path: '/api/run/config', handler: async ({ res, url }) => {
      if (!projectRunner) return text(res, 501, 'Runner indisponível.');
      const cwd = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `máquina "${machine}" não encontrada`);
      if (peer) return relay(res, peers.forward(peer, 'GET', `/api/run/config?local=1&cwd=${encodeURIComponent(cwd)}`));
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = projectRunner.getConfig(cwd);
      return r.status !== 200 ? text(res, r.status, r.error || 'erro ao ler configuração') : json(res, r.body);
    } },

    { method: 'PUT', path: '/api/run/config', json: true, maxBytes: 64 * 1024, handler: async ({ res, url, body }) => {
      if (!projectRunner) return text(res, 501, 'Runner indisponível.');
      const cwd = String((body && body.cwd) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `máquina "${machine}" não encontrada`);
      if (peer) return relay(res, peers.forward(peer, 'PUT', '/api/run/config?local=1', { cwd, config: body.config }));
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = projectRunner.saveConfig({ cwd, runConfig: body.config });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/run/status', handler: async ({ res, url }) => {
      if (!projectRunner) return text(res, 501, 'Runner indisponível.');
      const cwd = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `máquina "${machine}" não encontrada`);
      if (peer) return relay(res, peers.forward(peer, 'GET', `/api/run/status?local=1&cwd=${encodeURIComponent(cwd)}`));
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = projectRunner.status({ cwd });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/run/start', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!projectRunner) return text(res, 501, 'Runner indisponível.');
      const cwd = String((body && body.cwd) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      const profileId = String((body && body.profileId) || '').trim();
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `máquina "${machine}" não encontrada`);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/run/start?local=1', { cwd, profileId }, 15000));
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = projectRunner.start({ cwd, profileId });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/run/stop', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!projectRunner) return text(res, 501, 'Runner indisponível.');
      const cwd = String((body && body.cwd) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      const processId = String((body && body.processId) || '').trim();
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `máquina "${machine}" não encontrada`);
      if (peer) return relay(res, peers.forward(peer, 'POST', '/api/run/stop?local=1', { cwd, processId }, 15000));
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = projectRunner.stop({ cwd, processId });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },
  ];
};
