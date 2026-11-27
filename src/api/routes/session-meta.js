// POST /api/session-meta: fixa (pinned), renomeia (alias) ou agrupa (group) uma sessão no Hub.
module.exports = ({ sessionMeta, collector, workspacePeerSync, json, text }) => [
  { method: 'POST', path: '/api/session-meta', json: true, handler: ({ res, body }) => {
    const r = sessionMeta.set({
      id: body.id,
      pinned: body.pinned,
      alias: body.alias,
      group: body.group,
    });
    if (r.status === 200) {
      collector.poke();
      if (workspacePeerSync && typeof workspacePeerSync.scheduleSessionMetaSync === 'function') {
        workspacePeerSync.scheduleSessionMetaSync();
      }
    }
    return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
  } },
];
