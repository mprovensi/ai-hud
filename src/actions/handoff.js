// Handoff de conversa longa ("Resumir e continuar" na mesma IA ou Cross-IA).
// Gera `# Handoff` sanitizado em `<dataDir>/workspace/inbox/handoffs/` e inicia a nova sessão.
const fs = require('fs');
const path = require('path');
const { handoffFileName, buildHandoffMarkdown, buildHandoffPrompt } = require('../core/handoff');
const { readGitBrief } = require('../collect/file-preview');

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function createHandoff({ dataDir, launch, readGit = readGitBrief, now = () => Date.now() } = {}) {
  const handoffsDir = path.join(dataDir, 'workspace', 'inbox', 'handoffs');

  return async function handoff({ session, targetTool = '', targetModel = '', note = '' }) {
    if (!session) return { status: 404, body: 'sessão não encontrada' };
    const tool = String(targetTool || session.tool || '').trim();
    if (!['Claude Code', 'Codex', 'Gemini', 'Ollama'].includes(tool)) {
      return { status: 400, body: 'ferramenta de destino inválida para handoff' };
    }

    const ts = now();
    const git = session.cwd ? await readGit(session.cwd).catch(() => ({ branch: '', status: '' })) : { branch: '', status: '' };
    const markdown = buildHandoffMarkdown(session, {
      note,
      targetTool: tool,
      gitBranch: git.branch,
      gitStatus: git.status,
      now: ts,
    });

    const fileName = handoffFileName(session.project || 'sessao', session.id, ts);
    const filePath = path.join(handoffsDir, fileName);
    try {
      writeAtomic(filePath, markdown);
    } catch (e) {
      return { status: 500, body: `não foi possível salvar o arquivo de handoff: ${e.message}` };
    }

    const prompt = buildHandoffPrompt({ filePath, session, note, targetTool: tool });
    const launched = await launch({
      tool,
      model: targetModel,
      cwd: tool === 'Ollama' ? '' : (session.cwd || ''),
      prompt,
    });

    if (launched.status !== 200) {
      return launched;
    }
    return {
      status: 200,
      body: {
        ...launched.body,
        handoffFile: filePath,
        fromId: session.id,
        fromTool: session.tool,
      },
    };
  };
}

module.exports = { createHandoff };
