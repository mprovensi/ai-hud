// Handoff de conversa longa ("Resumir e continuar" na mesma IA ou Cross-IA).
// Gera `# Handoff` sanitizado em `<dataDir>/workspace/inbox/handoffs/` e inicia a nova sessão.
// Também registra a troca de IA na sessão compartilhada do projeto (`.ai-workspace/sessions/`).
const fs = require('fs');
const path = require('path');
const { handoffFileName, buildHandoffMarkdown, buildHandoffPrompt } = require('../core/handoff');
const { readGitBrief } = require('../collect/file-preview');
const { createSharedSessions } = require('./shared-sessions');

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

// Localiza (ou cria) a sessão compartilhada da sessão nativa e registra o handoff.
// Falhas aqui não bloqueiam o handoff: a sessão compartilhada é um complemento.
function recordSharedHandoff(store, session, { tool, targetModel, note }) {
  if (!store || !session.cwd) return null;
  try {
    let shared = store.findByNative({ cwd: session.cwd, nativeSessionId: session.id });
    if (!shared) {
      const created = store.create({
        cwd: session.cwd,
        goal: session.title || session.firstPrompt || '',
        tool: session.tool,
        nativeSessionId: session.id,
      });
      if (created.error) return null;
      shared = created.session;
    }
    const files = Object.keys(session.files || {}).slice(-20);
    if (files.length) store.update({ cwd: session.cwd, id: shared.id, tool: session.tool, addFiles: files });
    const r = store.handoff({ cwd: session.cwd, id: shared.id, fromTool: session.tool, toTool: tool, toModel: targetModel, note });
    return r.error ? null : r.session;
  } catch {
    return null;
  }
}

function createHandoff({ dataDir, launch, sharedSessions = null, readGit = readGitBrief, now = () => Date.now() } = {}) {
  const store = sharedSessions || createSharedSessions({ workspaceRoot: path.join(dataDir, 'workspace'), now });
  const handoffsDir = path.join(dataDir, 'workspace', 'inbox', 'handoffs');

  return async function handoff({ session, targetTool = '', targetModel = '', note = '' }) {
    if (!session) return { status: 404, body: 'sessão não encontrada' };
    const rawTool = String(targetTool || session.tool || '').trim();
    const tool = rawTool === 'Antigravity' ? 'Gemini' : rawTool;
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

    const shared = recordSharedHandoff(store, session, { tool, targetModel, note });
    let prompt = buildHandoffPrompt({ filePath, session, note, targetTool: tool });
    if (shared) {
      // O launcher corta o prompt em 4000 caracteres: reserva espaço para a referência não ser truncada.
      const ref = `\n\nSessão compartilhada AI HUD: ${shared.id} (rev ${shared.rev}). Para atualizar o estado, use o MCP ai-hud-memory: session_read/session_update com cwd="${shared.cwd}" e id="${shared.id}".`;
      prompt = `${prompt.slice(0, Math.max(0, 4000 - ref.length))}${ref}`;
    }
    const launched = await launch({
      tool,
      model: targetModel,
      cwd: tool === 'Ollama' ? '' : (session.cwd || ''),
      prompt,
    });

    if (launched.status !== 200) {
      return launched;
    }
    if (shared && launched.body && launched.body.id) {
      try { store.update({ cwd: shared.cwd, id: shared.id, tool, addNative: String(launched.body.id) }); } catch {}
    }
    return {
      status: 200,
      body: {
        ...launched.body,
        handoffFile: filePath,
        fromId: session.id,
        fromTool: session.tool,
        ...(shared ? { sharedSessionId: shared.id } : {}),
      },
    };
  };
}

module.exports = { createHandoff };
