// GET /api/fs/preview?id=<sessao>&path=<rel>&mode=diff|content: prévia segura somente leitura
// de um arquivo modificado ou seu `git diff`, restrita à pasta `cwd` da sessão.
module.exports = ({ filePreview, peers, collector, relay, json, text }) => [
  { method: 'GET', path: '/api/fs/preview', handler: async ({ res, url }) => {
    const id = url.searchParams.get('id') || '';
    const relPath = url.searchParams.get('path') || '';
    const mode = url.searchParams.get('mode') === 'content' ? 'content' : 'diff';
    if (!id || !relPath) return text(res, 400, 'informe id da sessão e caminho do arquivo');
    const remote = peers.byId(id);
    if (remote) {
      const q = `/api/fs/preview?id=${encodeURIComponent(remote.rid)}&path=${encodeURIComponent(relPath)}&mode=${mode}`;
      return relay(res, peers.forward(remote.peer, 'GET', q));
    }
    const s = collector.find((x) => x.id === id && !x.subagent);
    if (!s) return text(res, 404, 'sessão não encontrada');
    const r = await filePreview({ cwd: s.cwd, relPath, mode });
    if (r.status !== 200) return text(res, r.status || 400, r.error || 'não foi possível ler o arquivo');
    return json(res, r.body);
  } },
];
