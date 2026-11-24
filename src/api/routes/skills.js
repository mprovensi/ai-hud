// GET /api/skills?cwd=: lista comandos `/` e skills disponíveis para autocomplete na caixa de resposta.
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { collectSkills } = require('../../collect/skills');

module.exports = ({ dataDir, config, json }) => [
  { method: 'GET', path: '/api/skills', handler: ({ res, url }) => {
    const cwd = (url.searchParams.get('cwd') || '').trim();
    const skills = collectSkills({ workspaceRoot: resolveWorkspaceRoot(dataDir, config), cwd });
    json(res, { skills });
  } },
];
