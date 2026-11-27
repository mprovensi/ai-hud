// POST /api/new: inicia uma nova sessão de IA nesta máquina ou repassa à máquina escolhida (peer)
const os = require('os');
const { isLoopback } = require('../auth');
const { isCwdAllowed } = require('../../core/path-guard');
const { recentCwds } = require('../../collect/capabilities');

module.exports = ({ launch, peers, collector, machineName, config, json, text }) => [
  { method: 'POST', path: '/api/new', json: true, handler: async ({ req, res, url, body }) => {
    const isRemote = !isLoopback(req.socket && req.socket.remoteAddress) || body.remote === true;
    const target = String(body.machine || '').trim();
    if (url.searchParams.get('local') !== '1' && target && target !== machineName) {
      const peer = peers.list.find((p) => p.name === target);
      if (!peer) return text(res, 404, `máquina "${target}" não encontrada`);
      try {
        const r = await peers.forward(peer, 'POST', '/api/new?local=1', {
          tool: body.tool, model: body.model, cwd: body.cwd, prompt: body.prompt, remote: isRemote,
        });
        if (r.status !== 200 || !r.json) return text(res, r.status || 502, r.text || `${peer.name} não respondeu`);
        collector.poke();
        if (typeof peers.poll === 'function') peers.poll(peer).then((changed) => { if (changed) collector.poke(); }).catch(() => {});
        const prefixed = r.json.id ? `m${peer.i}:${r.json.id}` : null;
        return json(res, { ...r.json, id: prefixed, machine: peer.name });
      } catch {
        return text(res, 502, `${peer.name} não respondeu`);
      }
    }
    if (body.tool !== 'Ollama' && config && config.strictRemoteCwd && isRemote) {
      const knownCwds = recentCwds(collector.current().sessions, config.pinnedProjects || []);
      const check = isCwdAllowed(body.cwd, {
        allowedRoots: config.allowedRoots || [],
        knownCwds,
        home: os.homedir(),
        strict: true,
      });
      if (!check.ok) return text(res, 403, check.reason);
    }
    const r = await launch({ tool: body.tool, model: body.model, cwd: body.cwd, prompt: body.prompt });
    if (r.status === 200) collector.poke();
    return typeof r.body === 'string'
      ? text(res, r.status, r.body)
      : json(res, { ...r.body, machine: machineName }, r.status);
  } },
];
