// O que é uma sessão e em que estado ela está. Regras puras: nada de arquivo, rede ou processo.
//
// Toda fonte (collect/sources) devolve sessões neste formato:
/**
 * @typedef {object} Session
 * @property {string} tool          'Claude Code' | 'Codex' | 'Antigravity' | 'Ollama'
 * @property {string} id
 * @property {string} file          arquivo de origem ('' se não houver)
 * @property {string} cwd
 * @property {string} [where]       'vscode' | 'terminal' | 'claude-desktop' | 'codex-desktop' | 'ollama-app' | 'ollama-run' | 'ollama-api'
 * @property {string} start         ISO
 * @property {string} end           ISO
 * @property {number} [mtime]       ms; última atividade conhecida
 * @property {string} lastStop      'end_turn' quando o turno terminou
 * @property {number} [completedAt]
 * @property {number} [endedAt]     ms; quando o HUD encerrou o processo da sessão
 * @property {string} title
 * @property {string} [project]
 * @property {number} prompts
 * @property {string} firstPrompt
 * @property {string} lastPrompt
 * @property {string} lastReply
 * @property {number} [lastReplyAt]
 * @property {Set<string>} models
 * @property {boolean} subagent
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} context
 * @property {number} contextWindow
 * @property {number} toolCalls
 * @property {string} lastTool
 * @property {Object<string, number>} tools
 * @property {{ts: string, fresh: number, cacheRead: number}[]} events
 * @property {{role: string, content: string, at?: number}[]} [history]  Ollama
 */

const ACTIVE_MS = 2 * 60 * 1000;   // log mexido há menos disso: trabalhando
const RECENT_MS = 30 * 60 * 1000;  // até isso: sessão aberta, ociosa

// Atividade pelo último registro do log: no Windows a data de modificação de um arquivo
// mantido aberto (Codex retomando uma sessão antiga) só atualiza quando ele é fechado
function sessionState(s, now) {
  const last = Math.max(s.mtime || 0, Date.parse(s.end) || 0);
  // Encerrada pelo HUD e sem atividade depois disso (retomar a sessão a reabre)
  if (s.endedAt && s.endedAt >= last) return 'closed';
  const idle = now - last;
  if (idle < ACTIVE_MS && s.lastStop !== 'end_turn') return 'working';
  if (idle >= RECENT_MS) return 'closed';
  // Terminou o turno e está parada: é a vez do usuário
  return s.lastStop === 'end_turn' ? 'waiting' : 'idle';
}

// Ordem dos cartões: permissões pendentes primeiro, encerradas por último; depois a última atividade
const ORDER = { permission: 0, closed: 2 };
function compareSessions(a, b) {
  const priority = (ORDER[a.state] ?? 1) - (ORDER[b.state] ?? 1);
  const recent = (b.end || 0) - (a.end || 0);
  const aId = String(a.id || ''), bId = String(b.id || '');
  return priority || recent || (aId < bId ? -1 : aId > bId ? 1 : 0);
}

// Último nome de uma pasta (Windows ou Unix)
const base = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');

module.exports = { sessionState, compareSessions, base, ACTIVE_MS, RECENT_MS };
