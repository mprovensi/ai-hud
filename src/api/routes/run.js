// Rotas de execução de projetos multi-stack (/api/run/*), com proxy multi-máquina (local=1).
const path = require('path');
const { createCwdAuthorizer } = require('../cwd-auth');
const { collectProjectBootSnapshot } = require('../../collect/workspace/project-run');

module.exports = ({ projectRunner, workspaceWorkflow, peers, collector, dataDir, config, machineName, relay, json, text }) => {
  const checkAuthorizedCwd = createCwdAuthorizer({ dataDir, config, collector });

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
      const r = typeof projectRunner.statusAsync === 'function'
        ? await projectRunner.statusAsync({ cwd })
        : projectRunner.status({ cwd });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/run/auto-configure', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!projectRunner) return text(res, 501, 'Runner indisponível.');
      const cwd = String((body && body.cwd) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      const project = String((body && body.project) || path.basename(cwd) || 'projeto').trim();
      const force = !!(body && body.force);
      const skipValidate = !!(body && body.skipValidate);
      if (!cwd) return text(res, 400, 'informe cwd do projeto');

      const peer = findPeer(url, machine);
      if (peer && peer.missing) return text(res, 404, `máquina "${machine}" não encontrada`);
      if (peer) {
        return relay(res, peers.forward(peer, 'POST', '/api/run/auto-configure?local=1', { cwd, project, force, skipValidate }, 140000));
      }

      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);

      const cur = projectRunner.getConfig(cwd);
      if (cur.status !== 200) return text(res, cur.status, cur.error || 'erro ao ler configuração');
      if (cur.body.source === 'saved' && !force) {
        return json(res, {
          ok: true,
          alreadyConfigured: true,
          configured: false,
          bootOk: true,
          bootState: 'ready',
          config: cur.body.config,
        });
      }

      let candidateConfig = null;
      let engine = '';
      let model = '';
      let aiError = '';

      if (workspaceWorkflow && typeof workspaceWorkflow.configureRunWithAi === 'function') {
        const snapshotText = collectProjectBootSnapshot(cwd);
        const aiRes = await workspaceWorkflow.configureRunWithAi({
          project,
          cwd,
          snapshotText,
          detected: cur.body.detected,
        });
        if (aiRes.status === 200 && aiRes.body && aiRes.body.config) {
          candidateConfig = aiRes.body.config;
          engine = aiRes.body.engine || '';
          model = aiRes.body.model || '';
        } else {
          aiError = typeof aiRes.body === 'string' ? aiRes.body : 'IA indisponível para configurar Play.';
        }
      }

      // Fallback para detecção automática 0-token caso nenhum motor de IA esteja disponível
      if (!candidateConfig && cur.body.detected && Array.isArray(cur.body.detected.profiles) && cur.body.detected.profiles.length) {
        candidateConfig = cur.body.detected;
      }
      if (!candidateConfig) {
        return text(res, 422, aiError || 'Não foi possível determinar automaticamente como executar este projeto.');
      }

      const saved = projectRunner.saveConfig({ cwd, runConfig: candidateConfig });
      if (saved.status !== 200) {
        return typeof saved.body === 'string' ? text(res, saved.status, saved.body) : json(res, saved.body, saved.status);
      }

      let boot = { bootOk: true, bootState: 'stopped', bootError: '', openUrl: '', processes: [] };
      if (!skipValidate && typeof projectRunner.validateBoot === 'function') {
        const v = await projectRunner.validateBoot({ cwd, profileId: saved.body.config.defaultProfile });
        if (v && v.body && typeof v.body === 'object') boot = v.body;
      }

      return json(res, {
        ok: true,
        alreadyConfigured: false,
        configured: true,
        engine,
        model,
        aiFallbackNote: !engine && aiError ? aiError : '',
        config: saved.body.config,
        bootOk: !!boot.bootOk,
        bootState: boot.bootState || '',
        bootError: boot.bootError || '',
        openUrl: boot.openUrl || '',
        processes: boot.processes || [],
      });
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
