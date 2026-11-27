// Geração pura de documentos `# Handoff`, prompt inicial, costura de histórico unificado Cross-IA
// e detecção de cota esgotada para sugestão automática de troca de IA. Camada core: sem I/O.
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

function buildHandoffMarkdown(session, {
  note = '',
  targetTool = '',
  gitBranch = '',
  gitStatus = '',
  cardTitle = '',
  docRef = '',
  maxTurns = 10,
  now = Date.now(),
} = {}) {
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
  if (cardTitle) lines.push(`- **Tarefa ativa no Quadro:** ${clipBlock(cardTitle, 160)}`);
  if (docRef) lines.push(`- **Spec / Doc vinculado:** \`${clipBlock(docRef, 200)}\``);
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
    if (session.testRun.summary) lines.push(`- **Resumo:** ${clipBlock(session.testRun.summary, 600)}`);
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

function buildHandoffPrompt({ filePath, session, note = '', targetTool = '', cardTitle = '', docRef = '' }) {
  const isCross = targetTool && targetTool !== session.tool;
  const parts = [
    `Continuação de sessão por Handoff${isCross ? ` (vindo de ${session.tool})` : ''}.`,
  ];
  if (filePath) {
    parts.push(`Leia primeiro o arquivo de handoff completo em: ${filePath}`);
  }
  if (cardTitle || docRef) {
    parts.push(`Tarefa ativa: ${cardTitle || '(ver handoff)'}${docRef ? ` · Spec: ${docRef}` : ''}`);
  }
  const files = Object.keys(session.files || {}).slice(-8);
  if (files.length) parts.push(`Arquivos recentes: ${files.join(', ')}`);
  if (session.testRun && !session.testRun.ok) {
    parts.push(`Atenção: o último teste falhou (${session.testRun.command || 'ver handoff'})${session.testRun.summary ? `:\n${clipBlock(session.testRun.summary, 400)}` : '.'}`);
  }
  if (session.lastReply) {
    parts.push(`Última resposta da sessão anterior:\n${clipBlock(redactSecrets(session.lastReply).text, 900)}`);
  }
  if (note && String(note).trim()) {
    parts.push(`Instrução específica para continuar agora: ${clipBlock(redactSecrets(note).text, 800)}`);
  } else {
    parts.push('Após ler o arquivo de handoff, confirme brevemente o contexto entendido e continue diretamente do ponto de parada.');
  }
  return parts.join('\n\n').slice(0, 3900);
}

// Identifica prompts sintéticos gerados pelo handoff para ocultar o boilerplate na conversa unificada,
// preservando apenas a mensagem real escrita pelo usuário (se houver).
function extractHandoffUserNote(rawContent) {
  const text = String(rawContent || '');
  if (!/^Continuação de sessão por Handoff\b/.test(text.trim())) {
    return { isHandoffPrompt: false, userText: text };
  }
  const m = /Instrução específica para continuar agora:\s*([\s\S]*?)(?:\n\nSessão compartilhada AI HUD:|$)/.exec(text);
  const userText = m ? m[1].trim() : '';
  return { isHandoffPrompt: true, userText };
}

// Costura o histórico de múltiplas sessões nativas pertencentes à mesma sessão compartilhada
// em uma única linha de chat contínua com divisores `role: 'handoff'`.
function stitchSharedHistory({ chain = [], maxMessages = 45 } = {}) {
  const out = [];
  let prevTool = '';

  for (let si = 0; si < chain.length; si++) {
    const seg = chain[si];
    if (!seg) continue;
    const segTool = seg.tool || 'IA';
    const rawMsgs = Array.isArray(seg.history) && seg.history.length
      ? seg.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      : [
          ...(seg.lastPrompt ? [{ role: 'user', content: seg.lastPrompt, at: Date.parse(seg.start) || 0 }] : []),
          ...(seg.lastReply ? [{ role: 'assistant', content: seg.lastReply, at: seg.lastReplyAt || Date.parse(seg.end) || 0 }] : []),
        ];

    if (si > 0) {
      const segAt = (rawMsgs[0] && rawMsgs[0].at) || Date.parse(seg.start) || 0;
      out.push({
        role: 'handoff',
        fromTool: prevTool || 'IA',
        toTool: segTool,
        content: `${segTool} assumiu a conversa`,
        at: segAt,
      });
    }

    let handledFirstHandoffPrompt = false;
    for (let mi = 0; mi < rawMsgs.length; mi++) {
      const m = rawMsgs[mi];
      if (si > 0 && !handledFirstHandoffPrompt && m.role === 'user') {
        handledFirstHandoffPrompt = true;
        const parsed = extractHandoffUserNote(m.content);
        if (parsed.isHandoffPrompt) {
          if (parsed.userText) {
            out.push({
              role: 'user',
              content: parsed.userText.slice(0, 4000),
              at: m.at || 0,
              tool: segTool,
            });
          }
          continue;
        }
      }
      out.push({
        role: m.role,
        content: String(m.content || '').slice(0, 4000),
        at: m.at || 0,
        tool: segTool,
        ...(Array.isArray(m.tools) && m.tools.length ? { tools: m.tools.slice(0, 6) } : {}),
      });
    }
    prevTool = segTool;
  }

  return out.length > maxMessages ? out.slice(-maxMessages) : out;
}

const RATE_LIMIT_RE = /\b(quota\s+exceeded|rate\s*limit|usage\s+limit|out\s+of\s+(credits|quota|usage)|limit\s+reached|too\s+many\s+requests|429|cota\s+(esgotada|atingida)|limite\s+atingido)\b/i;

function toolQuotaKey(tool) {
  if (tool === 'Claude Code') return 'claude';
  if (tool === 'Codex') return 'codex';
  if (tool === 'Gemini' || tool === 'Antigravity') return 'gemini';
  return '';
}

function quotaPeakUsed(q) {
  if (!q || !q.windows) return null;
  const vals = Object.values(q.windows)
    .map((w) => (w && typeof w.used === 'number' ? w.used : null))
    .filter((v) => v !== null);
  return vals.length ? Math.max(...vals) : null;
}

// Detecta se a IA atual atingiu 100% da cota ou retornou erro de limite e sugere a melhor IA alternativa livre.
function detectQuotaHandoffSuggestion({ tool, lastReply = '', quotas = null, availableTools = null } = {}) {
  const normTool = tool === 'Antigravity' ? 'Gemini' : tool;
  const qKey = toolQuotaKey(normTool);
  const curQuota = qKey && quotas ? quotas[qKey] : null;
  const curUsed = quotaPeakUsed(curQuota);
  const textHit = RATE_LIMIT_RE.test(String(lastReply || '').slice(-800));
  const exhausted = (curUsed !== null && curUsed >= 98) || textHit;
  if (!exhausted) return null;

  const candidates = ['Claude Code', 'Codex', 'Gemini', 'Ollama']
    .filter((t) => t !== normTool)
    .filter((t) => !Array.isArray(availableTools) || !availableTools.length || availableTools.includes(t))
    .map((t) => {
      const k = toolQuotaKey(t);
      const used = k && quotas ? quotaPeakUsed(quotas[k]) : (t === 'Ollama' ? 0 : null);
      return { tool: t, used };
    })
    .filter((c) => c.used === null || c.used < 95)
    .sort((a, b) => {
      // Prefere IAs de nuvem com menor uso; Ollama fica como último fallback
      const aOlla = a.tool === 'Ollama' ? 1 : 0;
      const bOlla = b.tool === 'Ollama' ? 1 : 0;
      if (aOlla !== bOlla) return aOlla - bOlla;
      return (a.used ?? 50) - (b.used ?? 50);
    });

  const best = candidates[0] || null;
  return {
    reason: curUsed !== null && curUsed >= 98 ? 'quota-full' : 'rate-limit',
    currentTool: normTool,
    currentUsed: curUsed !== null ? Math.round(curUsed) : null,
    suggestedTool: best ? best.tool : '',
    suggestedUsed: best && best.used !== null ? Math.round(best.used) : null,
    alternatives: candidates.map((c) => ({ tool: c.tool, used: c.used !== null ? Math.round(c.used) : null })),
  };
}

module.exports = {
  handoffFileName,
  buildHandoffMarkdown,
  buildHandoffPrompt,
  extractHandoffUserNote,
  stitchSharedHistory,
  detectQuotaHandoffSuggestion,
};
