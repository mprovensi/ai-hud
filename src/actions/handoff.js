// Handoff de conversa longa ("Resumir e continuar" na mesma IA ou Cross-IA transparente).
// Gera `# Handoff` sanitizado em `<dataDir>/workspace/inbox/handoffs/`, inicia a nova sessão,
// registra a troca na sessão compartilhada (`.ai-workspace/sessions/`), herda metadados (pin/alias/grupo)
// e vincula o novo UUID automaticamente mesmo quando a CLI demora > 4s para criar o arquivo.
const fs = require('fs');
const path = require('path');
const { handoffFileName, buildHandoffMarkdown, buildHandoffPrompt } = require('../core/handoff');
const { readGitBrief } = require('../collect/file-preview');
const { createSharedSessions } = require('./shared-sessions');

const PENDING_LINK_TTL_MS = 90 * 1000;

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function normCwd(p) {
  if (!p) return '';
  const clean = String(p).trim().replace(/^\\\\\?\\/, '');
  const abs = path.resolve(clean);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
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

function inheritSessionMeta(sessionMeta, fromId, toId) {
  if (!sessionMeta || !fromId || !toId || fromId === toId) return;
  try {
    const prev = sessionMeta.get(fromId);
    if (!prev) return;
    if (!prev.pinned && !prev.alias && !prev.group) return;
    const cur = sessionMeta.get(toId);
    if (cur && (cur.pinned || cur.alias || cur.group)) return;
    sessionMeta.set({
      id: toId,
      pinned: !!prev.pinned,
      alias: prev.alias || '',
      group: prev.group || '',
    });
  } catch {}
}

function createHandoff({
  dataDir,
  launch,
  sharedSessions = null,
  sessionMeta = null,
  readGit = readGitBrief,
  now = () => Date.now(),
} = {}) {
  const store = sharedSessions || createSharedSessions({ workspaceRoot: path.join(dataDir, 'workspace'), now });
  const handoffsDir = path.join(dataDir, 'workspace', 'inbox', 'handoffs');
  const pendingLinks = [];

  function reconcile(sessions) {
    if (!pendingLinks.length || !Array.isArray(sessions) || !sessions.length) return 0;
    const ts = now();
    let linked = 0;
    for (let i = pendingLinks.length - 1; i >= 0; i--) {
      const p = pendingLinks[i];
      if (ts > p.expiresAt) {
        pendingLinks.splice(i, 1);
        continue;
      }
      const match = sessions.find((s) => {
        if (!s || s.subagent || !s.id) return false;
        if (p.knownIds.has(s.id)) return false;
        const sTool = s.tool === 'Antigravity' ? 'Gemini' : s.tool;
        if (sTool !== p.tool) return false;
        // Se o primeiro prompt cita explicitamente o ID da sessão compartilhada, casa na hora (mesmo se cwd ainda não foi gravado pelo agy)
        const fp = String(s.firstPrompt || s.title || '');
        if (p.sharedId && fp.includes(p.sharedId)) return true;
        if (p.cwdNorm && normCwd(s.cwd) !== p.cwdNorm) return false;
        const started = Date.parse(s.start) || 0;
        return started >= p.since - 15000;
      });
      if (!match) continue;
      try {
        store.update({ cwd: p.cwd, id: p.sharedId, tool: p.tool, addNative: String(match.id) });
        inheritSessionMeta(sessionMeta, p.fromId, String(match.id));
        linked += 1;
      } catch {}
      pendingLinks.splice(i, 1);
    }
    return linked;
  }

  async function handoff({
    session,
    targetTool = '',
    targetModel = '',
    note = '',
    cardTitle = '',
    docRef = '',
    knownIds = null,
  }) {
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
      cardTitle,
      docRef,
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
    let prompt = buildHandoffPrompt({ filePath, session, note, targetTool: tool, cardTitle, docRef });
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

    const newId = launched.body && launched.body.id ? String(launched.body.id) : '';
    if (newId) {
      if (shared) {
        try { store.update({ cwd: shared.cwd, id: shared.id, tool, addNative: newId }); } catch {}
      }
      inheritSessionMeta(sessionMeta, session.id, newId);
    } else if (shared) {
      // CLI demorou > 4s para emitir UUID: reconcilia automaticamente assim que aparecer no collector
      const idsSet = new Set(knownIds || []);
      idsSet.add(session.id);
      for (const n of shared.natives || []) idsSet.add(n);
      pendingLinks.push({
        cwd: shared.cwd,
        cwdNorm: normCwd(shared.cwd),
        sharedId: shared.id,
        tool,
        fromId: session.id,
        since: ts,
        expiresAt: ts + PENDING_LINK_TTL_MS,
        knownIds: idsSet,
      });
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
  }

  handoff.reconcile = reconcile;
  return handoff;
}

module.exports = { createHandoff, inheritSessionMeta };
