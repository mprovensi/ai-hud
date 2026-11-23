// Geração pura de documentos `# Handoff` e prompt inicial para continuar uma sessão longa
// na mesma IA ou em outra IA (Cross-IA Handoff). Camada core: sem I/O.
const { redactSecrets } = require('./redact');

function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'sessao';
}

function handoffFileName(project, id, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const tail = String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8) || '00000000';
  return `${day}-${slugify(project)}-${tail}.md`;
}

function clipBlock(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function buildHandoffMarkdown(session, { note = '', targetTool = '', gitBranch = '', gitStatus = '', maxTurns = 10, now = Date.now() } = {}) {
  const lines = [];
  const project = session.project || 'projeto';
  const title = session.title || session.firstPrompt || project;
  const models = session.models && [...session.models].join(', ');
  const pct = session.contextWindow ? Math.round((session.context || 0) / session.contextWindow * 100) : 0;

  lines.push(`# Handoff — ${project}`);
  lines.push('');
  lines.push(`- **Data:** ${new Date(now).toISOString()}`);
  lines.push(`- **Sessão de origem:** ${session.tool}${models ? ` (${models})` : ''} · \`${session.id}\``);
  if (targetTool && targetTool !== session.tool) lines.push(`- **Continuação Cross-IA em:** ${targetTool}`);
  if (session.cwd) lines.push(`- **Pasta do projeto:** \`${session.cwd}\``);
  if (gitBranch) lines.push(`- **Branch Git:** \`${gitBranch}\``);
  if (pct) lines.push(`- **Contexto na origem:** ${pct}% (${session.prompts || 0} pedidos)`);
  lines.push('');

  lines.push('## Objetivo inicial');
  lines.push(clipBlock(title, 600) || '(não informado)');
  lines.push('');

  if (note && String(note).trim()) {
    lines.push('## Instrução do usuário para esta continuação');
    lines.push(clipBlock(note, 1000));
    lines.push('');
  }

  const files = Object.entries(session.files || {}).slice(-20);
  if (files.length) {
    lines.push('## Arquivos modificados na sessão anterior');
    for (const [f, count] of files) lines.push(`- \`${f}\` (${count}×)`);
    lines.push('');
  }

  if (gitStatus && String(gitStatus).trim()) {
    lines.push('## Estado Git atual (`git status --short`)');
    lines.push('```text');
    lines.push(clipBlock(gitStatus, 1200));
    lines.push('```');
    lines.push('');
  }

  if (session.testRun) {
    lines.push('## Última execução de testes');
    lines.push(`- **Status:** ${session.testRun.ok ? 'Passou' : 'Falhou'}`);
    if (session.testRun.command) lines.push(`- **Comando:** \`${session.testRun.command}\``);
    if (session.testRun.summary) lines.push(`- **Resumo:** ${clipBlock(session.testRun.summary, 400)}`);
    lines.push('');
  }

  const history = Array.isArray(session.history) && session.history.length
    ? session.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-maxTurns)
    : [];
  if (history.length) {
    lines.push('## Resumo dos últimos turnos');
    for (const m of history) {
      const who = m.role === 'user' ? 'Usuário' : session.tool;
      lines.push(`### ${who}`);
      lines.push(clipBlock(m.content, m.role === 'user' ? 600 : 1200));
      lines.push('');
    }
  } else if (session.lastPrompt || session.lastReply) {
    lines.push('## Última troca registrada');
    if (session.lastPrompt) { lines.push('### Usuário'); lines.push(clipBlock(session.lastPrompt, 600)); lines.push(''); }
    if (session.lastReply) { lines.push(`### ${session.tool}`); lines.push(clipBlock(session.lastReply, 1500)); lines.push(''); }
  }

  const raw = lines.join('\n').trim() + '\n';
  return redactSecrets(raw).text;
}

function buildHandoffPrompt({ filePath, session, note = '', targetTool = '' }) {
  const isCross = targetTool && targetTool !== session.tool;
  const parts = [
    `Continuação de sessão por Handoff${isCross ? ` (vindo de ${session.tool})` : ''}.`,
  ];
  if (filePath) {
    parts.push(`Leia primeiro o arquivo de handoff completo em: ${filePath}`);
  }
  const files = Object.keys(session.files || {}).slice(-8);
  if (files.length) parts.push(`Arquivos recentes: ${files.join(', ')}`);
  if (session.testRun && !session.testRun.ok) {
    parts.push(`Atenção: o último teste falhou (${session.testRun.command || 'ver handoff'}).`);
  }
  if (session.lastReply) {
    parts.push(`Última resposta da sessão anterior:\n${clipBlock(redactSecrets(session.lastReply).text, 900)}`);
  }
  if (note && String(note).trim()) {
    parts.push(`Instrução específica para continuar agora: ${clipBlock(redactSecrets(note).text, 800)}`);
  } else {
    parts.push('Após ler o arquivo de handoff, confirme brevemente o contexto entendido e proponha (ou execute, se já estiver claro) o próximo passo.');
  }
  return parts.join('\n\n').slice(0, 3900);
}

module.exports = {
  handoffFileName,
  buildHandoffMarkdown,
  buildHandoffPrompt,
};
