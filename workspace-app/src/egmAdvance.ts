// Portão de evidência para avanço automático de etapa no Board (R18).
// Espelha `evaluateStageAdvance` em `src/core/egm.js`: fim de turno (`waiting`/`idle`) isolado
// não comprova entrega — exige detalhes válidos da sessão, ausência de perguntas/bloqueios e evidência da etapa.
import type { CardItem, CardStatus, SessionDetail } from './types';

const QUESTION_OR_BLOCKER_RE = /\b(bloquead[oa]|impedid[oa]|n[ãa]o foi poss[íi]vel|preciso de confirma[çc][ãa]o|aguardando confirma[çc][ãa]o|aguardando decis[ãa]o|qual op[çc][ãa]o|voc[êe] prefere|pode confirmar|erro cr[íi]tico|falhou ao|blocked|need clarification|please confirm)\b/i;
const REVIEW_REJECTION_RE = /\b(reprovad[oa]|n[ãa]o aprovad[oa]|ajustes necess[áa]rios|bloqueio de aceite|mudan[çc]as obrigat[óo]rias|changes requested|rejected)\b/i;

export function evaluateStageAdvance(params: {
  currentStatus: CardStatus;
  nextStatus?: CardStatus | null;
  detail: SessionDetail | null;
  target?: CardItem | null;
}): { ok: boolean; reason: string } {
  const { currentStatus, nextStatus, detail, target } = params;
  if (!nextStatus) return { ok: false, reason: 'Próxima etapa não definida.' };
  if (!detail) return { ok: false, reason: 'Detalhes da sessão indisponíveis para validar a entrega.' };
  if (detail.permission) return { ok: false, reason: 'Sessão aguardando decisão de permissão.' };
  if (detail.testRun && detail.testRun.ok === false) return { ok: false, reason: 'Última execução de testes falhou.' };

  const reply = String(detail.lastReply || '').trim();
  if (!reply) return { ok: false, reason: 'Sessão encerrou turno sem resposta final.' };
  if (/^\s*⚠/.test(reply)) return { ok: false, reason: 'Resposta indica aviso ou erro.' };

  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tailLines = lines.slice(-3).join('\n');
  if (lines.length && /\?\s*$/.test(lines[lines.length - 1])) {
    return { ok: false, reason: 'Resposta terminou com pergunta aguardando o usuário.' };
  }
  if (QUESTION_OR_BLOCKER_RE.test(tailLines)) {
    return { ok: false, reason: 'Resposta indica bloqueio ou pedido de confirmação.' };
  }

  const modifiedFiles = Array.isArray(detail.files)
    ? detail.files.map((f) => (Array.isArray(f) ? String(f[0] || '') : String(f || '')))
    : [];
  const hasMdFile = modifiedFiles.some((f) => /\.md$/i.test(String(f || '')));
  const mentionsMd = /(?:^|[\s`(["'])(?:docs\/[^\s`)"']+\.md|[^\s`)"']*spec[^\s`)"']*\.md)/i.test(reply);
  const hasDocRef = !!(target && target.docRef && String(target.docRef).trim());

  if (currentStatus === 'idea' && nextStatus === 'spec') {
    if (!hasDocRef && !hasMdFile && !mentionsMd) {
      return { ok: false, reason: 'Nenhuma spec/documento .md identificado como evidência.' };
    }
  }

  if (nextStatus === 'review') {
    const hasWorkEvidence = modifiedFiles.length > 0 || !!(detail.testRun && detail.testRun.ok === true) || hasDocRef;
    if (!hasWorkEvidence) {
      return { ok: false, reason: 'Sem evidência de alterações, testes ou documento atualizado para ir para Revisão.' };
    }
  }

  if (nextStatus === 'done') {
    if (target && target.review && target.review.status === 'changes') {
      return { ok: false, reason: 'Revisão ainda indica ajustes pendentes.' };
    }
    if (REVIEW_REJECTION_RE.test(reply)) {
      return { ok: false, reason: 'Resposta relata pendências ou reprovação na revisão.' };
    }
  }

  return { ok: true, reason: '' };
}
