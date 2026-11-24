// Rotas de sistema de arquivos somente leitura por projeto (/api/fs/preview, /api/fs/list, /api/fs/git).
// Sempre restritas ao `cwd` da sessão ou a pastas conhecidas/autorizadas (path-guard).
const os = require('os');
const { isCwdAllowed } = require('../../core/path-guard');
const { recentCwds } = require('../../collect/capabilities');

module.exports = ({ filePreview, fileList, projectGit, terminal, ptyManager, peers, collector, config, machineName, relay, json, text }) => {
  function checkAuthorizedCwd(cwd) {
    const knownCwds = recentCwds(collector.current().sessions, (config && config.pinnedProjects) || []);
    return isCwdAllowed(cwd, {
      allowedRoots: (config && config.allowedRoots) || [],
      knownCwds,
      home: os.homedir(),
      strict: true,
    });
  }

  return [
    { method: 'GET', path: '/api/fs/preview', handler: async ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const cwdParam = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      const relPath = url.searchParams.get('path') || '';
      const mode = url.searchParams.get('mode') === 'content' ? 'content' : 'diff';
      if (!relPath) return text(res, 400, 'informe o caminho do arquivo');

      if (id) {
        const remote = peers.byId(id);
        if (remote) {
          const q = `/api/fs/preview?id=${encodeURIComponent(remote.rid)}&path=${encodeURIComponent(relPath)}&mode=${mode}`;
          return relay(res, peers.forward(remote.peer, 'GET', q));
        }
        const s = collector.find((x) => x.id === id && !x.subagent);
        if (!s) return text(res, 404, 'sessão não encontrada');
        const r = await filePreview({ cwd: s.cwd, relPath, mode });
        return r.status !== 200 ? text(res, r.status || 400, r.error || 'não foi possível ler o arquivo') : json(res, r.body);
      }

      if (!cwdParam) return text(res, 400, 'informe id da sessão ou cwd autorizado');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        const q = `/api/fs/preview?local=1&cwd=${encodeURIComponent(cwdParam)}&path=${encodeURIComponent(relPath)}&mode=${mode}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const check = checkAuthorizedCwd(cwdParam);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await filePreview({ cwd: cwdParam, relPath, mode });
      return r.status !== 200 ? text(res, r.status || 400, r.error || 'não foi possível ler o arquivo') : json(res, r.body);
    } },

    { method: 'GET', path: '/api/fs/list', handler: async ({ res, url }) => {
      const cwd = url.searchParams.get('cwd') || '';
      const relDir = url.searchParams.get('path') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        const q = `/api/fs/list?local=1&cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relDir)}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = fileList({ cwd, relDir });
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'GET', path: '/api/fs/git', handler: async ({ res, url }) => {
      const cwd = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        const q = `/api/fs/git?local=1&cwd=${encodeURIComponent(cwd)}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await projectGit(cwd);
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'POST', path: '/api/fs/exec', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!terminal) return text(res, 501, 'Terminal integrado indisponível.');
      const cwd = String(body.cwd || '').trim();
      const machine = String(body.machine || '').trim();
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        return relay(res, peers.forward(peer, 'POST', '/api/fs/exec?local=1', {
          cwd,
          command: body.command,
          timeoutMs: body.timeoutMs,
        }));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await terminal({ cwd, command: body.command, timeoutMs: body.timeoutMs });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/pty/status', handler: ({ res }) => {
      json(res, ptyManager ? ptyManager.status() : { ok: true, available: false });
    } },
  ];
};
