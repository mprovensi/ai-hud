// POST /api/focus: Abrir no PC (actions/focus).
// Se a sessão estiver vinculada a um projeto do AI Workspace, abre o projeto + sessão direto no AI Workspace (Desktop ou navegador).
const { samePath, isWithinRoot, detectPathPlatform } = require('../../core/path-guard');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { readWorkspaceJson } = require('../../collect/workspace');

function findLinkedEntity(cwd, entities) {
  const clean = String(cwd || '').trim().replace(/^\\\\\?\\/, '');
  if (!clean || !Array.isArray(entities) || !entities.length) return null;
  const plat = detectPathPlatform(clean);
  let best = null;
  let bestLen = -1;
  for (const e of entities) {
    if (!e || !Array.isArray(e.projectBindings)) continue;
    for (const b of e.projectBindings) {
      const bCwd = String((b && b.cwd) || '').trim().replace(/^\\\\\?\\/, '');
      if (!bCwd) continue;
      if (samePath(bCwd, clean, plat)) return e;
      if (isWithinRoot(bCwd, clean, plat) && bCwd.length > bestLen) {
        best = e;
        bestLen = bCwd.length;
      }
    }
  }
  return best;
}

function resolveHubOrigin(req) {
  if (!req || !req.headers || !req.headers.host) return '';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

function buildWorkspaceFocusUrl({ entityId, sessionId, hubOrigin = '', hubSessionId = '', config = {} }) {
  const cleanOrigin = String(hubOrigin || '').trim().replace(/\/+$/, '');
  const useRemoteHub = /^https?:\/\//i.test(cleanOrigin) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(cleanOrigin);
  let base = '';
  let tok = '';
  let sid = sessionId;

  if (useRemoteHub) {
    base = cleanOrigin;
    sid = hubSessionId || sessionId;
    const primaryPeer = Array.isArray(config.peers)
      ? config.peers.find((p) => p && p.primary === true && p.token)
      : null;
    if (primaryPeer && primaryPeer.token) tok = String(primaryPeer.token).trim();
  } else {
    const port = Number(config.port) || 8787;
    base = `http://127.0.0.1:${port}`;
    if (config.token) tok = String(config.token).trim();
  }

  const params = new URLSearchParams();
  params.set('project', entityId);
  params.set('session', sid);
  if (tok) params.set('t', tok);
  return `${base}/workspace?${params.toString()}`;
}

module.exports = ({ focus, peers, collector, relay, config, dataDir, json, send }) => [
  { method: 'POST', path: '/api/focus', json: true, handler: async ({ req, res, body }) => {
    const remote = peers.byId(body.id);
    if (remote) {
      return relay(res, peers.forward(remote.peer, 'POST', '/api/focus', {
        id: remote.rid,
        hubSessionId: String(body.id || ''),
        hubOrigin: resolveHubOrigin(req),
      }));
    }
    const s = collector.find((x) => x.id === body.id && !x.subagent);
    if (!s) return send(res, 404, 'text/plain', 'sessão não encontrada');

    let opts = {};
    if (dataDir && s.cwd) {
      try {
        const wsRoot = resolveWorkspaceRoot(dataDir, config || {});
        const index = readWorkspaceJson(wsRoot);
        const entity = findLinkedEntity(s.cwd, index && index.entities);
        if (entity && entity.id) {
          opts = {
            projectTitle: entity.title || entity.id,
            workspaceUrl: buildWorkspaceFocusUrl({
              entityId: entity.id,
              sessionId: s.id,
              hubOrigin: body.hubOrigin || resolveHubOrigin(req),
              hubSessionId: body.hubSessionId || '',
              config: config || {},
            }),
          };
        }
      } catch {}
    }
    json(res, await focus(s, opts));
  } },
];
