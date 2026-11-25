import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive,
  ArchiveRestore,
  Bot,
  CheckCircle2,
  Columns3,
  Download,
  ExternalLink,
  FilePlus2,
  FileText,
  GitCommitHorizontal,
  HardDrive,
  ImagePlus,
  LayoutGrid,
  List,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, EmptyState, ModalFrame, StageDot } from '../ui';
import type { CardExecIntent } from './LiveHudPane';
import type {
  CardDoc,
  CardItem,
  CardStatus,
  CardTemplate,
  ConflictError,
  GitInfo,
  GoldfishEstimate,
  GoldfishReviewResult,
  ProjectDocEntry,
} from '../types';

export const BOARD_STATUSES: { id: CardStatus; label: string }[] = [
  { id: 'idea', label: 'Ideia' },
  { id: 'spec', label: 'Spec / Plano' },
  { id: 'in-progress', label: 'Em andamento' },
  { id: 'review', label: 'Revisão' },
  { id: 'done', label: 'Concluído' },
];

export const EGM_STAGE_GUIDE: Record<CardStatus, { short: string; actionTip: string }> = {
  idea: {
    short: '🐘 Elefante (Spec-First): levantar requisitos e gerar spec enxuta antes de codar',
    actionTip: 'EGM Ideia → Spec: investigar e gerar especificação enxuta sem implementar código ainda',
  },
  spec: {
    short: '🐟 Portão Goldfish + Início: validar lacunas/riscos da spec e iniciar implementação no escopo',
    actionTip: 'EGM Spec → Em andamento: seguir a spec (e parecer Goldfish) iniciando apenas o escopo aprovado',
  },
  'in-progress': {
    short: '⚙️ Execução focada: concluir implementação no escopo da spec e validar com testes',
    actionTip: 'EGM Em andamento → Revisão: concluir mudanças no escopo, rodar testes/build e resumir evidências',
  },
  review: {
    short: '🐟 Goldfish (Revisão fria): auditar git diff contra a spec, edge-cases, testes e aceite',
    actionTip: 'EGM Revisão → Concluído: revisão fria Goldfish sobre o git diff + validação final de testes',
  },
  done: {
    short: '✅ Concluído: tarefa finalizada, pronta para commit e sincronização de checklist',
    actionTip: 'Tarefa concluída',
  },
};

export function nextWorkflowStatus(current: CardStatus): { status: CardStatus; label: string } | null {
  const idx = BOARD_STATUSES.findIndex((s) => s.id === current);
  if (idx < 0 || idx >= BOARD_STATUSES.length - 1) return null;
  const next = BOARD_STATUSES[idx + 1];
  return { status: next.id, label: next.label };
}

interface Props {
  entityId: string;
  filePath: string;
  hasProjectCwd?: boolean;
  projectCwd?: string;
  projectMachine?: string;
  projectTitle?: string;
  lastAutoDone?: { entityId: string; itemId?: string; title: string; ts: number } | null;
  reloadKey?: number;
  snapshotVersion?: string;
  onNotify: (msg: string, err?: boolean) => void;
  onSendPrompt: (prompt: string) => void;
  onExecuteItem?: (intent: CardExecIntent) => void;
  onOpenDoc?: (docPath: string) => void;
  onRunConfigUpdated?: () => void;
}

const AUDIT_BOARD_PROMPT =
  'Leia `.ai-workspace/board.card.json` (ou use a tool MCP `board_read`), compare as tarefas em `idea`, `spec` e `in-progress` com o código e o git atual do projeto, liste quais já foram concluídas com evidência curta e atualize os status delas (usando `board_update_status` ou editando `.ai-workspace/board.card.json` mantendo o schema `ai-card` v1 e sincronizando `- [x]` nos docs vinculados).';

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function sortRecentFirst(items: CardItem[]): CardItem[] {
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const diff = (b.item.updatedAt || 0) - (a.item.updatedAt || 0);
      return diff !== 0 ? diff : a.idx - b.idx;
    })
    .map((x) => x.item);
}

const COMMIT_STOPWORDS = new Set([
  'para', 'com', 'sem', 'uma', 'uns', 'umas', 'dos', 'das', 'que', 'por', 'pela', 'pelo',
  'como', 'mais', 'sobre', 'entre', 'apos', 'antes', 'the', 'and', 'for', 'with', 'from', 'feat', 'fix', 'chore', 'docs',
]);

function normCommitText(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function commitKeywords(raw: string): string[] {
  return normCommitText(raw)
    .split(' ')
    .filter((w) => w.length >= 3 && !COMMIT_STOPWORDS.has(w));
}

interface CardCommitStatus {
  state: 'committed' | 'pending' | 'clean' | 'unknown';
  hash?: string;
  message?: string;
  branch?: string;
  source?: 'card' | 'git-log';
  pendingFiles: number;
  docDirty: boolean;
  reason?: string;
}

function resolveCardCommitStatus(item: CardItem, gitInfo: GitInfo | null): CardCommitStatus {
  const docClean = (item.docRef || '').split('#')[0].replace(/\\/g, '/').trim().toLowerCase();
  const modified = gitInfo?.modified || [];
  const docDirty = !!(
    docClean &&
    modified.some((m) => {
      const mp = String(m.path || '').replace(/\\/g, '/').replace(/^"|"$/g, '').trim().toLowerCase();
      return mp === docClean || mp.endsWith(`/${docClean}`);
    })
  );

  // 1. Commit salvo explicitamente no card
  if (item.commit?.hash) {
    if (docDirty) {
      return {
        state: 'pending',
        hash: item.commit.hash,
        message: item.commit.message || '',
        branch: item.commit.branch || gitInfo?.branch || '',
        pendingFiles: modified.length,
        docDirty: true,
        reason: `O documento vinculado (${item.docRef}) foi alterado após o commit ${item.commit.hash}.`,
      };
    }
    return {
      state: 'committed',
      hash: item.commit.hash,
      message: item.commit.message || '',
      branch: item.commit.branch || gitInfo?.branch || '',
      source: 'card',
      pendingFiles: modified.length,
      docDirty: false,
    };
  }

  // 2. Cruzamento determinístico com os últimos 30 commits do repositório (0 tokens)
  if (gitInfo?.isRepo && gitInfo.commits && gitInfo.commits.length > 0) {
    const titleNorm = normCommitText(item.title);
    const titleKw = commitKeywords(item.title);
    const idLower = (item.id || '').toLowerCase();
    const matched = gitInfo.commits.find((c) => {
      const msgNorm = normCommitText(c.message);
      if (!msgNorm) return false;
      if (idLower.length >= 6 && !idLower.startsWith('item-') && msgNorm.includes(idLower)) return true;
      if (titleNorm.length >= 8 && msgNorm.includes(titleNorm)) return true;
      if (titleKw.length === 1) return titleKw[0].length >= 6 && msgNorm.includes(titleKw[0]);
      if (titleKw.length >= 2) {
        const msgSet = new Set(msgNorm.split(' '));
        const hits = titleKw.filter((w) => msgSet.has(w)).length;
        return hits >= 2 && hits / titleKw.length >= 0.6;
      }
      return false;
    });
    if (matched) {
      if (docDirty) {
        return {
          state: 'pending',
          hash: matched.hash,
          message: matched.message,
          branch: gitInfo.branch || '',
          pendingFiles: modified.length,
          docDirty: true,
          reason: `Detectado commit ${matched.hash}, mas ${item.docRef} tem novas alterações pendentes.`,
        };
      }
      return {
        state: 'committed',
        hash: matched.hash,
        message: matched.message,
        branch: gitInfo.branch || '',
        source: 'git-log',
        pendingFiles: modified.length,
        docDirty: false,
      };
    }
  }

  if (!gitInfo || !gitInfo.isRepo) {
    return { state: 'unknown', pendingFiles: 0, docDirty: false };
  }
  if (modified.length > 0) {
    return {
      state: 'pending',
      branch: gitInfo.branch || '',
      pendingFiles: modified.length,
      docDirty,
      reason: docDirty
        ? `O arquivo vinculado (${item.docRef}) tem alterações não commitadas.`
        : `${modified.length} arquivo(s) com alterações não commitadas em ${gitInfo.branch || 'git'}.`,
    };
  }
  return {
    state: 'clean',
    branch: gitInfo.branch || '',
    pendingFiles: 0,
    docDirty: false,
  };
}

export function CardEditor({
  entityId,
  filePath,
  hasProjectCwd = false,
  projectCwd = '',
  projectMachine = '',
  projectTitle = '',
  lastAutoDone = null,
  reloadKey = 0,
  snapshotVersion = '',
  onNotify,
  onSendPrompt,
  onExecuteItem,
  onOpenDoc,
  onRunConfigUpdated,
}: Props) {
  const draftKey = `aiws.draft.${entityId}.${filePath}`;
  const [card, setCard] = useState<CardDoc | null>(null);
  const [baseHash, setBaseHash] = useState('');
  const [storage, setStorage] = useState<'in-project' | 'hub' | 'hub-cache'>('hub');
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentContent: CardDoc; currentHash: string } | null>(null);
  const [runBootAlert, setRunBootAlert] = useState<{ title: string; error: string } | null>(null);
  const runAutoCfgBusyRef = useRef(false);
  const loadSeqRef = useRef(0);

  // Modal de detalhes e edição de card
  const [detailModal, setDetailModal] = useState<{ draft: CardItem; isNew: boolean; bodyPreview: boolean } | null>(null);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState('');

  // Descoberta e importação de docs/ (0 tokens + opção IA)
  const [projectDocs, setProjectDocs] = useState<ProjectDocEntry[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [importingDocs, setImportingDocs] = useState(false);
  const [aiStructEstimate, setAiStructEstimate] = useState<{
    available?: boolean;
    engine?: string;
    model?: string;
    reason?: string;
    estimatedInputTokens?: number;
    estimatedOutputTokens?: number;
    estimatedTotalTokens?: number;
  } | null>(null);
  const [aiStructLoading, setAiStructLoading] = useState(false);
  const [aiProposed, setAiProposed] = useState<CardItem[] | null>(null);

  // Revisão Goldfish sob demanda (modal sempre visível)
  const [reviewModal, setReviewModal] = useState<{
    itemId: string;
    itemTitle: string;
    docPath: string;
    loading: boolean;
    estimate: GoldfishEstimate | null;
    result: GoldfishReviewResult | null;
    error: string;
  } | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);

  // Drag-and-drop entre colunas e reordenação dentro da coluna
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<CardStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  const wasDraggingRef = useRef(false);

  const [undoing, setUndoing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recentImportCount, setRecentImportCount] = useState<number | null>(null);
  const [pendingExternalReload, setPendingExternalReload] = useState(false);

  // Prompt rápido de commit ao concluir tarefa + verificação Git (0 tokens)
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [checkingGit, setCheckingGit] = useState(false);
  const [quickCommit, setQuickCommit] = useState<{
    itemId?: string;
    taskTitle: string;
    message: string;
    branch: string;
    modified: { code: string; path: string }[];
    push: boolean;
    committing: boolean;
  } | null>(null);
  const lastHandledAutoDoneRef = useRef(0);

  const baseHashRef = useRef('');
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const modalOpenRef = useRef(false);
  baseHashRef.current = baseHash;
  dirtyRef.current = dirty;
  savingRef.current = saving;
  modalOpenRef.current = !!detailModal;

  async function load(ignoreDraft = false, showSkeleton = false) {
    const seq = ++loadSeqRef.current;
    if (showSkeleton) setLoadingBoard(true);
    setConflict(null);
    try {
      const r = hasProjectCwd
        ? await api.getProjectBoard(entityId)
        : await api.getEntityFile<CardDoc>(entityId, filePath).then((f) => ({
            ok: true,
            exists: true,
            storage: 'hub' as const,
            offlineFallback: false,
            content: f.content,
            hash: f.hash,
          }));
      if (seq !== loadSeqRef.current) return;
      setStorage(r.storage);
      setOfflineFallback(!!r.offlineFallback);
      const serverCard: CardDoc = r.content || {
        format: 'ai-card',
        version: 1,
        template: 'board',
        title: 'Quadro',
        summary: '',
        items: [],
      };
      const savedDraft = !ignoreDraft ? sessionStorage.getItem(draftKey) : null;
      if (savedDraft) {
        try {
          setCard(JSON.parse(savedDraft));
          setDirty(true);
        } catch {
          setCard(serverCard);
          setDirty(false);
        }
      } else {
        setCard(serverCard);
        setDirty(false);
      }
      setBaseHash(r.hash || '');
    } catch (e) {
      if (seq === loadSeqRef.current) onNotify((e as Error).message, true);
    } finally {
      if (seq === loadSeqRef.current) setLoadingBoard(false);
    }
  }

  async function refreshProjectDocs() {
    if (!hasProjectCwd) {
      setProjectDocs([]);
      return;
    }
    try {
      const r = await api.listProjectDocs(entityId);
      const list = r.docs || [];
      setProjectDocs(list);
      const defaults = list
        .filter((d) => d.category === 'plan' || d.category === 'spec' || d.taskCount > 0)
        .map((d) => d.path);
      setSelectedDocs(defaults.length ? defaults : list.slice(0, 5).map((d) => d.path));
    } catch {
      setProjectDocs([]);
    }
  }

  useEffect(() => {
    setDetailModal(null);
    setImportOpen(false);
    setAiStructEstimate(null);
    setAiProposed(null);
    setReviewModal(null);
    setPendingExternalReload(false);
    setRecentImportCount(null);
    load(false, true);
    refreshProjectDocs();
  }, [entityId, filePath, hasProjectCwd, reloadKey]);

  // Atualização transparente em disco (sem banner ruidoso — apenas reflete na tela!)
  async function checkExternalUpdate(manual = false) {
    if (savingRef.current) return;
    if (manual) setRefreshing(true);
    try {
      const r = hasProjectCwd
        ? await api.getProjectBoard(entityId)
        : await api.getEntityFile<CardDoc>(entityId, filePath).then((f) => ({
            ok: true,
            exists: true,
            storage: 'hub' as const,
            offlineFallback: false,
            content: f.content,
            hash: f.hash,
          }));
      setStorage(r.storage);
      setOfflineFallback(!!r.offlineFallback);
      const nextHash = r.hash || '';
      const changed = !!(nextHash && baseHashRef.current && nextHash !== baseHashRef.current);

      if (manual) {
        if (r.content) {
          setCard(r.content);
          setBaseHash(nextHash);
          setDirty(false);
          setConflict(null);
          setPendingExternalReload(false);
          sessionStorage.removeItem(draftKey);
          onNotify(changed ? 'Quadro atualizado.' : 'Quadro já está atualizado.');
        }
        return;
      }

      if (changed && r.content) {
        if (!dirtyRef.current && !modalOpenRef.current) {
          // Aplica silenciosamente e de forma transparente (Item 6)
          setCard(r.content);
          setBaseHash(nextHash);
          setConflict(null);
          setPendingExternalReload(false);
        } else {
          setPendingExternalReload(true);
        }
      }
    } catch (e) {
      if (manual) onNotify((e as Error).message, true);
    } finally {
      if (manual) setRefreshing(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') checkExternalUpdate(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [entityId, filePath, hasProjectCwd]);

  async function refreshGitStatus(showToast = false): Promise<GitInfo | null> {
    if (!projectCwd || offlineFallback) {
      setGitInfo(null);
      return null;
    }
    setCheckingGit(true);
    try {
      const g = await api.getGit(projectCwd, projectMachine);
      setGitInfo(g);
      if (showToast) {
        if (!g.isRepo) onNotify('Esta pasta não é um repositório Git.');
        else if ((g.modified || []).length === 0) onNotify(`Git limpo em ${g.branch || 'HEAD'} (sem alterações pendentes).`);
        else onNotify(`${g.modified.length} arquivo(s) pendente(s) de commit em ${g.branch || 'HEAD'}.`);
      }
      return g;
    } catch (e) {
      if (showToast) onNotify((e as Error).message, true);
      return null;
    } finally {
      setCheckingGit(false);
    }
  }

  useEffect(() => {
    if (snapshotVersion && baseHashRef.current) {
      checkExternalUpdate(false);
      refreshGitStatus(false);
    }
  }, [snapshotVersion]);

  useEffect(() => {
    setQuickCommit(null);
    setGitInfo(null);
    if (projectCwd && !offlineFallback) refreshGitStatus(false);
  }, [entityId, projectCwd, projectMachine, offlineFallback]);

  async function promptQuickCommit(taskTitle: string, explicit = false, itemId?: string) {
    if (!projectCwd || offlineFallback) return;
    try {
      const g = await refreshGitStatus(false);
      if (!g || !g.isRepo) {
        if (explicit) onNotify('Esta pasta não é um repositório Git.', true);
        return;
      }
      const mod = g.modified || [];
      if (mod.length === 0) {
        if (explicit) onNotify('Nenhuma alteração pendente para commitar no Git.');
        return;
      }
      const cleanTitle = taskTitle.trim().replace(/\s+/g, ' ').slice(0, 80);
      setQuickCommit({
        itemId,
        taskTitle: cleanTitle,
        message: cleanTitle ? `feat: ${cleanTitle}` : 'chore: atualizar tarefa',
        branch: g.branch || 'HEAD',
        modified: mod,
        push: false,
        committing: false,
      });
    } catch (e) {
      if (explicit) onNotify((e as Error).message, true);
    }
  }

  async function runQuickCommit() {
    if (!quickCommit || !projectCwd || quickCommit.committing) return;
    const msg = quickCommit.message.trim();
    if (!msg) return;
    const linkedItemId = quickCommit.itemId;
    setQuickCommit((prev) => (prev ? { ...prev, committing: true } : null));
    try {
      const r = await api.commitGit({
        cwd: projectCwd,
        machine: projectMachine,
        message: msg,
        push: quickCommit.push,
      });
      setQuickCommit(null);
      if (r.nothingToCommit) {
        onNotify('Nada para commitar no Git.');
      } else {
        if (r.committed && r.hash && linkedItemId && card && !offlineFallback) {
          const commitMeta = { hash: r.hash, branch: r.branch || '', message: msg, at: Date.now() };
          const nextCard: CardDoc = {
            ...card,
            items: card.items.map((it) => (it.id === linkedItemId ? { ...it, commit: commitMeta } : it)),
          };
          setCard(nextCard);
          await save(nextCard, true);
        }
        if (r.pushError) {
          onNotify(`Commit ${r.hash || ''} criado em ${r.branch || 'git'}, mas o push falhou: ${r.pushError}`, true);
        } else if (r.pushed) {
          onNotify(`Commit ${r.hash || ''} criado e enviado (push) em ${r.branch || 'git'}.`);
        } else {
          onNotify(`Commit ${r.hash || ''} criado em ${r.branch || 'git'}.`);
        }
      }
      await refreshGitStatus(false);
    } catch (e) {
      setQuickCommit((prev) => (prev ? { ...prev, committing: false } : null));
      onNotify((e as Error).message, true);
    }
  }

  useEffect(() => {
    if (!lastAutoDone || lastAutoDone.entityId !== entityId) return;
    if (lastAutoDone.ts <= lastHandledAutoDoneRef.current) return;
    lastHandledAutoDoneRef.current = lastAutoDone.ts;
    promptQuickCommit(lastAutoDone.title, false, lastAutoDone.itemId);
  }, [lastAutoDone, entityId, projectCwd, projectMachine]);

  function updateCard(next: CardDoc) {
    setCard(next);
    setDirty(true);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {}
  }

  async function save(cardOverride?: CardDoc, silentToast = false) {
    const targetCard = cardOverride || card;
    if (!targetCard || savingRef.current || offlineFallback) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const r = hasProjectCwd
        ? await api.saveProjectBoard({ entityId, content: targetCard, baseHash: baseHashRef.current })
        : await api.saveEntityFile({ id: entityId, path: filePath, content: targetCard, baseHash: baseHashRef.current });
      baseHashRef.current = r.hash;
      setBaseHash(r.hash);
      setDirty(false);
      setConflict(null);
      setPendingExternalReload(false);
      sessionStorage.removeItem(draftKey);
      if (hasProjectCwd) setStorage('in-project');
      if (!silentToast) onNotify('Quadro salvo.');
      return true;
    } catch (e) {
      const ce = e as ConflictError;
      if (ce.conflict && ce.currentContent) {
        setConflict({ currentContent: ce.currentContent as CardDoc, currentHash: ce.currentHash });
        onNotify('Conflito detectado: o quadro foi alterado em disco.', true);
      } else {
        onNotify(ce.message, true);
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Salva automaticamente qualquer alteração pendente no Board (debounce curto, sem exigir Ctrl+S)
  useEffect(() => {
    if (!dirty || !card || offlineFallback || saving || conflict) return;
    const timer = window.setTimeout(() => {
      save(card, true);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [dirty, card, offlineFallback, saving, conflict, entityId, filePath, hasProjectCwd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (detailModal) {
          saveDetailModal();
        } else {
          save();
        }
      } else if (e.key === 'Escape' && detailModal) {
        setDetailModal(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, baseHash, saving, offlineFallback, detailModal]);

  if (loadingBoard || !card) {
    return (
      <div className="card-editor-root" aria-busy="true" aria-label="Carregando quadro do projeto">
        <div className="toolbar">
          <div className="skel" style={{ width: 170, height: 28 }} />
          <div className="skel" style={{ width: 92, height: 28 }} />
          <div className="skel" style={{ width: 120, height: 28 }} />
          <div className="skel" style={{ width: 110, height: 28, marginLeft: 'auto' }} />
        </div>
        <div className="board-scroll">
          <div className="board-grid">
            {BOARD_STATUSES.map((col, colIdx) => (
              <div key={col.id} className="board-col">
                <div className="board-col-head">
                  <span>{col.label}</span>
                  <div className="skel" style={{ width: 22, height: 16 }} />
                </div>
                <div className="board-col-body">
                  {Array.from({ length: colIdx === 0 ? 3 : colIdx === 4 ? 2 : 1 }).map((_, k) => (
                    <div key={k} className="skel-card">
                      <div className="skel" style={{ width: `${72 + ((colIdx + k) % 3) * 8}%`, height: 14 }} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <div className="skel" style={{ width: 64, height: 16 }} />
                        <div className="skel" style={{ width: 52, height: 16 }} />
                      </div>
                      <div className="skel" style={{ width: '92%', height: 10 }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function openNewItemModal(status: CardStatus = 'idea') {
    const id = `item-${Date.now().toString(36)}`;
    setDetailModal({
      draft: { id, title: '', body: '', status, updatedAt: Date.now() },
      isNew: true,
      bodyPreview: false,
    });
  }

  function openItemModal(item: CardItem) {
    setDetailModal({
      draft: { ...item },
      isNew: false,
      bodyPreview: !!item.body,
    });
  }

  async function syncCheckboxIfCrossedDone(prevStatus: CardStatus, nextStatus: CardStatus, item: CardItem) {
    const crossedDone = (prevStatus === 'done') !== (nextStatus === 'done');
    if (hasProjectCwd && item.docRef && crossedDone) {
      try {
        const sr = await api.syncDocCheckbox({
          entityId,
          docRef: item.docRef,
          title: item.title,
          done: nextStatus === 'done',
        });
        if (sr.changed && sr.path) {
          onNotify(`Checklist atualizado em ${sr.path} (${nextStatus === 'done' ? '- [x]' : '- [ ]'}).`);
        }
      } catch {}
    }
  }

  async function ensurePlayConfiguredOnReview(itemTitle: string) {
    if (!hasProjectCwd || !projectCwd || runAutoCfgBusyRef.current) return;
    runAutoCfgBusyRef.current = true;
    try {
      const cur = await api.getRunConfig(projectCwd, projectMachine);
      if (cur.source === 'saved') return;
      onNotify('Sem Play configurado — configurando .ai-workspace/run.json via IA e validando boot…');
      const r = await api.autoConfigureRun({
        cwd: projectCwd,
        machine: projectMachine,
        project: projectTitle || undefined,
      });
      if (r.configured) onRunConfigUpdated?.();
      if (r.bootOk) {
        setRunBootAlert(null);
        const via = r.engine ? ` (${r.engine}${r.model ? '/' + r.model : ''})` : '';
        onNotify(`Play configurado via IA${via} e validado: projeto subiu sem erros!`);
      } else {
        const errMsg = r.bootError || 'O projeto não subiu por completo na validação.';
        setRunBootAlert({ title: itemTitle, error: errMsg });
        onNotify(`Play salvo, mas falhou ao validar boot: ${errMsg}`, true);
      }
    } catch (e) {
      const msg = (e as Error).message || 'Falha ao configurar Play automaticamente.';
      setRunBootAlert({ title: itemTitle, error: msg });
      onNotify(msg, true);
    } finally {
      runAutoCfgBusyRef.current = false;
    }
  }

  async function saveDetailModal() {
    if (!card || !detailModal || offlineFallback) return;
    const cleanTitle = detailModal.draft.title.trim();
    if (!cleanTitle) return onNotify('Informe o título do item.', true);
    const stamped: CardItem = {
      ...detailModal.draft,
      title: cleanTitle,
      status: detailModal.draft.status || 'idea',
      updatedAt: Date.now(),
    };
    const prev = card.items.find((i) => i.id === stamped.id);
    const nextItems = detailModal.isNew
      ? [stamped, ...card.items]
      : card.items.map((it) => (it.id === stamped.id ? stamped : it));
    const nextCard: CardDoc = { ...card, items: nextItems };
    updateCard(nextCard);
    const ok = await save(nextCard);
    if (ok) {
      setDetailModal(null);
      const prevSt = (prev?.status || 'idea') as CardStatus;
      const nextSt = (stamped.status || 'idea') as CardStatus;
      if (prev) {
        await syncCheckboxIfCrossedDone(prevSt, nextSt, stamped);
      }
      if (prevSt !== 'review' && nextSt === 'review') {
        ensurePlayConfiguredOnReview(stamped.title);
      }
      if (prevSt !== 'done' && nextSt === 'done') {
        promptQuickCommit(stamped.title, false, stamped.id);
      }
    }
  }

  async function deleteFromModal(id: string) {
    if (!card || offlineFallback) return;
    const nextCard: CardDoc = { ...card, items: card.items.filter((it) => it.id !== id) };
    updateCard(nextCard);
    setDetailModal(null);
    await save(nextCard);
  }

  async function archiveItem(id: string) {
    if (!card || offlineFallback) return;
    const now = Date.now();
    const nextCard: CardDoc = {
      ...card,
      items: card.items.map((it) => (it.id === id ? { ...it, status: 'done', archived: true, archivedAt: now } : it)),
    };
    updateCard(nextCard);
    setDetailModal((cur) => (cur && cur.draft.id === id ? null : cur));
    await save(nextCard, true);
    onNotify('Tarefa arquivada.');
  }

  async function unarchiveItem(id: string) {
    if (!card || offlineFallback) return;
    const now = Date.now();
    const nextCard: CardDoc = {
      ...card,
      items: card.items.map((it) => {
        if (it.id !== id) return it;
        const copy: CardItem = { ...it, status: 'done', updatedAt: now };
        delete copy.archived;
        delete copy.archivedAt;
        return copy;
      }),
    };
    updateCard(nextCard);
    setDetailModal((cur) => (cur && cur.draft.id === id ? null : cur));
    await save(nextCard, true);
    onNotify('Tarefa restaurada para Concluído.');
  }

  async function archiveAllDone() {
    if (!card || offlineFallback) return;
    const doneIds = card.items.filter((it) => !it.archived && (it.status || 'idea') === 'done').map((it) => it.id);
    if (!doneIds.length) return;
    const idSet = new Set(doneIds);
    const now = Date.now();
    const nextCard: CardDoc = {
      ...card,
      items: card.items.map((it) => (idSet.has(it.id) ? { ...it, archived: true, archivedAt: now } : it)),
    };
    updateCard(nextCard);
    await save(nextCard, true);
    onNotify(`${doneIds.length} tarefa(s) concluída(s) arquivada(s).`);
  }

  async function handleDropCard(droppedId: string, targetCol: CardStatus, beforeItem?: CardItem) {
    if (!card || offlineFallback) return;
    const found = card.items.find((i) => i.id === droppedId);
    if (!found) return;
    if (beforeItem && beforeItem.id === droppedId) return;

    const prevStatus = (found.status || 'idea') as CardStatus;
    const now = Date.now();
    // Calcula updatedAt para manter a ordenação "mais recente primeiro" e respeitar a posição solta sobre outro card
    let nextUpdatedAt = now;
    if (beforeItem) {
      const colItems = sortRecentFirst(card.items.filter((i) => (i.status || 'idea') === targetCol && i.id !== droppedId));
      const targetIdx = colItems.findIndex((i) => i.id === beforeItem.id);
      const refTs = beforeItem.updatedAt || now;
      if (targetIdx <= 0) {
        nextUpdatedAt = Math.max(now, refTs + 1000);
      } else {
        const aboveTs = colItems[targetIdx - 1].updatedAt || (refTs + 2000);
        nextUpdatedAt = aboveTs > refTs + 1 ? Math.floor((aboveTs + refTs) / 2) : refTs + 1;
      }
    }

    const updatedItem: CardItem = { ...found, status: targetCol, updatedAt: nextUpdatedAt };
    const others = card.items.filter((i) => i.id !== droppedId);
    let nextItems: CardItem[];
    if (beforeItem) {
      const idx = others.findIndex((i) => i.id === beforeItem.id);
      nextItems = idx >= 0 ? [...others.slice(0, idx), updatedItem, ...others.slice(idx)] : [updatedItem, ...others];
    } else {
      nextItems = [updatedItem, ...others];
    }

    const nextCard: CardDoc = { ...card, items: nextItems };
    updateCard(nextCard);
    await save(nextCard, true);
    await syncCheckboxIfCrossedDone(prevStatus, targetCol, updatedItem);
    if (prevStatus !== 'review' && targetCol === 'review') {
      ensurePlayConfiguredOnReview(updatedItem.title);
    }
    if (prevStatus !== 'done' && targetCol === 'done') {
      promptQuickCommit(updatedItem.title, false, updatedItem.id);
    }
  }

  async function handleModalImageUpload(file: File) {
    if (!detailModal) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api.uploadEntityMedia({
          id: entityId,
          fileName: file.name,
          base64Data: String(reader.result || ''),
        });
        setDetailModal((prev) => (prev ? { ...prev, draft: { ...prev.draft, image: res.path, alt: file.name } } : null));
        onNotify('Imagem anexada. Clique em Salvar alterações.');
      } catch (e) {
        onNotify((e as Error).message, true);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleCreateSpecForItem(item: CardItem) {
    if (!hasProjectCwd || !card) return;
    try {
      const r = await api.createProjectSpec({
        entityId,
        title: item.title,
        summary: item.body || '',
      });
      const updatedItem: CardItem = { ...item, docRef: r.path, status: 'spec', updatedAt: Date.now() };
      const nextCard: CardDoc = {
        ...card,
        items: card.items.some((it) => it.id === item.id)
          ? card.items.map((it) => (it.id === item.id ? updatedItem : it))
          : [updatedItem, ...card.items],
      };
      setCard(nextCard);
      await save(nextCard, true);
      setDetailModal(null);
      onNotify(`Spec criada em ${r.path}`);
      onOpenDoc?.(r.path);
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  async function requestItemReview(item: CardItem) {
    const docPath = (item.docRef || '').split('#')[0];
    if (!docPath || reviewRunning) return;
    setReviewRunning(true);
    setReviewModal({
      itemId: item.id,
      itemTitle: item.title,
      docPath,
      loading: true,
      estimate: null,
      result: null,
      error: '',
    });
    try {
      const r = await api.reviewProjectSpec({ entityId, docPath, itemId: item.id, dryRun: true });
      if ('dryRun' in r && r.dryRun) {
        setReviewModal((prev) => (prev ? { ...prev, loading: false, estimate: r } : null));
      } else {
        setReviewModal((prev) => (prev ? { ...prev, loading: false, error: 'Resposta inesperada da estimativa.' } : null));
      }
    } catch (e) {
      const msg = (e as Error).message || 'Falha ao calcular estimativa.';
      setReviewModal((prev) => (prev ? { ...prev, loading: false, error: msg } : null));
      onNotify(msg, true);
    } finally {
      setReviewRunning(false);
    }
  }

  async function confirmItemReview() {
    if (!reviewModal || reviewRunning) return;
    setReviewRunning(true);
    setReviewModal((prev) => (prev ? { ...prev, loading: true, error: '' } : null));
    try {
      const r = await api.reviewProjectSpec({
        entityId,
        docPath: reviewModal.docPath,
        itemId: reviewModal.itemId,
        dryRun: false,
      });
      if (!('dryRun' in r)) {
        const tok = r.usage ? ` · ${fmtTok(r.usage.totalTokens)} tok${r.usage.estimated ? ' est.' : ''}` : '';
        onNotify(`Goldfish (${r.engine}${tok}): ${r.verdict === 'approved' ? 'Spec aprovada' : 'Ajustes sugeridos'}`);
        setReviewModal((prev) => (prev ? { ...prev, loading: false, result: r } : null));
        await load(true);
      }
    } catch (e) {
      const msg = (e as Error).message || 'Falha durante a revisão Goldfish.';
      setReviewModal((prev) => (prev ? { ...prev, loading: false, error: msg } : null));
      onNotify(msg, true);
    } finally {
      setReviewRunning(false);
    }
  }

  async function handleDeterministicImport() {
    if (!selectedDocs.length || importingDocs) return;
    setImportingDocs(true);
    try {
      const r = await api.importProjectDocs({ entityId, paths: selectedDocs, dryRun: false });
      if (r.board) {
        setCard(r.board);
        setBaseHash(r.hash || '');
        setDirty(false);
        sessionStorage.removeItem(draftKey);
      }
      setImportOpen(false);
      if (r.addedCount && r.addedCount > 0) {
        setRecentImportCount(r.addedCount);
        onNotify(`${r.addedCount} item(ns) importado(s) para o Quadro (0 tokens).`);
      } else {
        onNotify('Nenhum item novo encontrado nos documentos selecionados (0 tokens).');
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setImportingDocs(false);
    }
  }

  async function handleAiStructureDryRun() {
    if (!selectedDocs.length || aiStructLoading) return;
    setAiStructLoading(true);
    setAiProposed(null);
    try {
      const r = await api.structureDocsAi({ entityId, docPaths: selectedDocs.slice(0, 6), dryRun: true });
      setAiStructEstimate(r);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setAiStructLoading(false);
    }
  }

  async function handleAiStructureConfirm() {
    if (!selectedDocs.length || aiStructLoading) return;
    setAiStructLoading(true);
    try {
      const r = await api.structureDocsAi({ entityId, docPaths: selectedDocs.slice(0, 6), dryRun: false });
      setAiStructEstimate(null);
      setAiProposed(r.items || []);
      const tok = r.usage ? ` · ${fmtTok(r.usage.totalTokens)} tok${r.usage.estimated ? ' est.' : ''}` : '';
      onNotify(`IA sugeriu ${(r.items || []).length} item(ns) (${r.engine}${tok}). Revise e clique em Aplicar.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setAiStructLoading(false);
    }
  }

  function applyAiProposed() {
    if (!card || !aiProposed || !aiProposed.length) return;
    const seen = new Set(card.items.map((i) => i.title.trim().toLowerCase()));
    const usedIds = new Set(card.items.map((i) => i.id));
    const now = Date.now();
    const added: CardItem[] = [];
    aiProposed.forEach((it, idx) => {
      if (seen.has(it.title.trim().toLowerCase())) return;
      let id = it.id;
      let n = 2;
      while (usedIds.has(id)) id = `${it.id}-${n++}`;
      usedIds.add(id);
      seen.add(it.title.trim().toLowerCase());
      added.push({ ...it, id, updatedAt: now - idx });
    });
    const nextCard = { ...card, items: [...added, ...card.items] };
    setAiProposed(null);
    setImportOpen(false);
    if (added.length > 0) setRecentImportCount(added.length);
    updateCard(nextCard);
    save(nextCard);
  }

  async function handleUndoBoard(skipConfirm = false) {
    if (!hasProjectCwd || undoing || offlineFallback) return;
    if (!skipConfirm && !window.confirm('Restaurar a versão anterior do Quadro (desfazer última alteração/importação)?')) return;
    setUndoing(true);
    try {
      const r = await api.undoProjectBoard(entityId);
      setCard(r.board);
      setBaseHash(r.hash);
      setDirty(false);
      setRecentImportCount(null);
      sessionStorage.removeItem(draftKey);
      onNotify(`Quadro restaurado para a versão anterior (${r.board.items.length} itens).`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setUndoing(false);
    }
  }

  function buildExecutePrompt(item: CardItem): string {
    const st = (item.status || 'idea') as CardStatus;
    if (item.prompt && item.prompt.trim()) return item.prompt.trim();

    const docClean = (item.docRef || '').split('#')[0].trim();
    const specLine = docClean ? `Spec/documento vinculado: \`${item.docRef}\`.` : '';
    const bodyLine = item.body ? `Contexto da tarefa:\n${item.body}` : '';
    const reviewLine = item.review?.reportPath
      ? `Parecer Goldfish (${item.review.status === 'approved' ? 'aprovado' : 'ajustes sugeridos'}): \`${item.review.reportPath}\`${item.review.summary ? ` — ${item.review.summary}` : ''}.`
      : '';

    const isHighComplexity =
      (item.body || '').length > 600 ||
      /\b(arquitetura|migra[cç][aã]o|seguran[cç]a|concorr[eê]ncia|refactor|multi-?m[aá]quina|websocket|pty|schema)\b/i.test(`${item.title} ${item.body || ''}`);

    const subagentRoutingLine = isHighComplexity
      ? `Roteamento de subagentes EGM (tarefa complexa): delegue buscas/leituras mecânicas a subagentes leves (\`haiku\`/\`flash\`/\`mini\`), mas execute arquitetura, implementação crítica e revisão Goldfish em modelo forte (\`sonnet\`/\`opus\`/\`pro\`).`
      : `Roteamento de subagentes EGM (tarefa simples/padrão): use subagentes leves (\`haiku\`/\`flash\`/\`mini\`) para buscas, leituras e checagens mecânicas; mantenha implementação e revisão Goldfish em modelo equilibrado (\`sonnet\`/padrão).`;

    if (st === 'idea') {
      const slug = normCommitText(item.title).replace(/\s+/g, '-').slice(0, 48) || 'spec';
      const targetDoc = docClean || `docs/specs/${slug}.md`;
      return [
        `[EGM · Ideia → Spec] Tarefa: "${item.title}"`,
        specLine,
        bodyLine,
        `Regras Elephant-Goldfish (fase Elefante / Spec-First):`,
        `1. NÃO implemente código de produção ainda.`,
        `2. Leia apenas os arquivos relevantes do projeto para entender o contexto real.`,
        `3. ${subagentRoutingLine}`,
        `4. Crie ou atualize uma especificação enxuta em \`${targetDoc}\` com: Objetivo, Escopo, Fora de escopo, Arquivos impactados e Critérios de aceite objetivos.`,
        `5. Ao concluir, atualize este item no \`.ai-workspace/board.card.json\` (ou via MCP \`board_update_status\`) com \`docRef: "${targetDoc}"\`.`,
      ].filter(Boolean).join('\n\n');
    }

    if (st === 'spec') {
      return [
        `[EGM · Spec → Em andamento] Tarefa: "${item.title}"`,
        specLine,
        reviewLine,
        bodyLine,
        `Regras Elephant-Goldfish (Portão Goldfish + Início de implementação):`,
        item.review?.status === 'changes'
          ? `1. Antes de codar, leia o parecer Goldfish e resolva as lacunas/riscos apontados na spec.`
          : item.review?.status === 'approved'
            ? `1. A spec já foi aprovada pelo Goldfish; siga-a rigorosamente sem expandir o escopo.`
            : `1. Faça uma checagem rápida estilo Goldfish (lacunas, riscos ou ambiguidades) na spec antes de codar; se não houver bloqueios, inicie a implementação.`,
        `2. ${subagentRoutingLine}`,
        `3. Implemente de forma enxuta e focada apenas nos itens do escopo aprovado e valide com testes/build.`,
      ].filter(Boolean).join('\n\n');
    }

    if (st === 'in-progress') {
      return [
        `[EGM · Em andamento → Revisão] Tarefa: "${item.title}"`,
        specLine,
        reviewLine,
        bodyLine,
        `Regras Elephant-Goldfish (Execução focada + Evidência):`,
        `1. Finalize a implementação estritamente dentro do escopo e critérios de aceite da tarefa (sem refatorações fora de escopo).`,
        `2. ${subagentRoutingLine}`,
        `3. Rode os testes e/ou build do projeto para comprovar que tudo passa sem regressões.`,
        `4. Verifique se \`.ai-workspace/run.json\` (Play do projeto) existe; se não existir, crie-o com o perfil correto e valide que o projeto sobe sem erros.`,
        `5. Entregue um resumo objetivo dos arquivos alterados e dos testes executados para a etapa de Revisão.`,
      ].filter(Boolean).join('\n\n');
    }

    if (st === 'review') {
      return [
        `[EGM · Revisão → Concluído (Goldfish)] Tarefa: "${item.title}"`,
        specLine,
        bodyLine,
        `Regras Elephant-Goldfish (Modo Goldfish — Revisão fria e aceite):`,
        `1. Atue como revisor independente a frio: inspecione o \`git diff\` atual contra a spec e os critérios de aceite.`,
        `2. ${subagentRoutingLine}`,
        `3. Procure apenas bugs concretos, regressões, edge-cases, segurança ou falta de testes; corrija pendências críticas se houver.`,
        `4. Confirme que \`.ai-workspace/run.json\` está configurado e que o projeto sobe como um todo sem erros, e que os testes/build passam 100%${docClean ? ` (sincronizando \`- [x]\` em \`${docClean}\`)` : ''}.`,
      ].filter(Boolean).join('\n\n');
    }

    return `Trabalhe na tarefa "${item.title}"${item.body ? `:\n${item.body}` : '.'}`;
  }

  function triggerExecute(item: CardItem) {
    const prompt = buildExecutePrompt(item);
    const curSt = (item.status || 'idea') as CardStatus;
    const nxt = nextWorkflowStatus(curSt);
    if (onExecuteItem) {
      onExecuteItem({
        entityId,
        itemId: item.id,
        title: item.title,
        currentStatus: curSt,
        nextStatus: nxt ? nxt.status : null,
        nextLabel: nxt ? nxt.label : '',
        prompt,
      });
    } else {
      onSendPrompt(prompt);
    }
  }

  // Card limpo no Board (detalhes completos e edição abrem no modal ao clicar)
  function renderItemCard(item: CardItem) {
    const docClean = (item.docRef || '').split('#')[0];
    const canDrag = card?.template === 'board' && !offlineFallback;
    const isBoard = card?.template === 'board';

    const st = (item.status || 'idea') as CardStatus;
    const isDone = st === 'done';
    const commitSt = isDone && projectCwd ? resolveCardCommitStatus(item, gitInfo) : null;

    return (
      <div
        key={item.id}
        className={`card-item clean-card stage-${st} ${dragItemId === item.id ? 'dragging' : ''} ${dragOverCardId === item.id ? 'drag-over-card' : ''}`}
        draggable={canDrag}
        onDragStart={(e) => {
          if (!canDrag) return;
          wasDraggingRef.current = true;
          setDragItemId(item.id);
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!canDrag || !dragItemId || dragItemId === item.id) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          if (dragOverCardId !== item.id) setDragOverCardId(item.id);
        }}
        onDragLeave={() => {
          setDragOverCardId((cur) => (cur === item.id ? null : cur));
        }}
        onDrop={(e) => {
          if (!canDrag) return;
          e.preventDefault();
          e.stopPropagation();
          const droppedId = e.dataTransfer.getData('text/plain') || dragItemId;
          setDragItemId(null);
          setDragOverCol(null);
          setDragOverCardId(null);
          if (droppedId && droppedId !== item.id) {
            handleDropCard(droppedId, (item.status || 'idea') as CardStatus, item);
          }
        }}
        onDragEnd={() => {
          setDragItemId(null);
          setDragOverCol(null);
          setDragOverCardId(null);
          window.setTimeout(() => { wasDraggingRef.current = false; }, 60);
        }}
        onClick={() => {
          if (wasDraggingRef.current) return;
          openItemModal(item);
        }}
        title="Clique para ver detalhes ou editar (arraste para mover ou reordenar)"
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <h4 className="card-title-clamp" style={{ flex: 1 }}>
            {item.title || '(sem título)'}
          </h4>
          {!isBoard && item.status && (
            <span className={`badge ${item.status}`}>
              {BOARD_STATUSES.find((s) => s.id === item.status)?.label || item.status}
            </span>
          )}
        </div>

        {(item.phase || docClean || (item.review && item.review.status && item.review.status !== 'none')) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {item.phase && <span className="badge" style={{ fontSize: 10 }}>{item.phase}</span>}
            {docClean && (
              <button
                type="button"
                className="doc-chip mono ell"
                title={`Abrir ${item.docRef} em Docs & Specs`}
                onClick={(e) => { e.stopPropagation(); onOpenDoc?.(item.docRef!); }}
              >
                <FileText size={10} style={{ flexShrink: 0 }} />
                <span className="ell">{docClean.split('/').pop()}</span>
              </button>
            )}
            {item.review && item.review.status && item.review.status !== 'none' && (
              <button
                type="button"
                className={`badge ${item.review.status === 'approved' ? 'done' : 'review'}`}
                style={{ fontSize: 10, cursor: item.review.reportPath ? 'pointer' : 'default' }}
                title={item.review.summary || 'Parecer da revisão Goldfish'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.review?.reportPath) onOpenDoc?.(item.review.reportPath);
                }}
              >
                {item.review.status === 'approved' ? <CheckCircle2 size={10} /> : <ShieldAlert size={10} />}
                {item.review.status === 'approved' ? 'Goldfish OK' : 'Ajustes'}
              </button>
            )}
          </div>
        )}

        {item.image && (
          <img
            src={api.entityAssetUrl(entityId, item.image)}
            alt={item.alt || item.title}
            style={{ maxHeight: isBoard ? 96 : 170, marginTop: 6 }}
          />
        )}

        {!isBoard && item.body && (
          <div className="md" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
          </div>
        )}

        {!isDone && (
          <div className="card-actions" style={{ marginTop: 7 }} onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-sm"
              style={{ padding: '3px 7px', fontSize: 11 }}
              title={EGM_STAGE_GUIDE[st]?.actionTip || 'Executar tarefa com IA (avança para a próxima fase ao concluir)'}
              onClick={() => triggerExecute(item)}
            >
              <Play size={11} /> Executar
            </button>
            {hasProjectCwd && !docClean && st === 'idea' && (
              <button
                className="btn btn-sm"
                style={{ padding: '3px 7px', fontSize: 11 }}
                title="Criar especificação enxuta (docs/specs/) e mover para Spec (0 tokens)"
                onClick={() => handleCreateSpecForItem(item)}
              >
                <FilePlus2 size={11} /> Spec
              </button>
            )}
            {hasProjectCwd && docClean && (st === 'spec' || st === 'idea') && (
              <button
                className="btn btn-sm"
                style={{ padding: '3px 7px', fontSize: 11 }}
                title="Revisão Goldfish isolada desta spec (mostra estimativa de tokens antes)"
                onClick={() => requestItemReview(item)}
                disabled={reviewRunning}
              >
                🐟 Revisar
              </button>
            )}
          </div>
        )}

        {isDone && !offlineFallback && (
          <div className="card-actions" style={{ marginTop: 7, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {projectCwd && commitSt && commitSt.state !== 'unknown' && (
              commitSt.state === 'pending' ? (
                <button
                  className="btn btn-sm"
                  style={{ padding: '3px 7px', fontSize: 11 }}
                  title={commitSt.reason || 'Commitar alterações pendentes no Git do projeto (0 tokens)'}
                  onClick={() => promptQuickCommit(item.title, true, item.id)}
                >
                  <GitCommitHorizontal size={11} /> Commitar
                  {commitSt.pendingFiles > 0 && (
                    <span style={{ color: 'var(--warn)', fontSize: 10, fontWeight: 700 }}>· {commitSt.pendingFiles}</span>
                  )}
                </button>
              ) : commitSt.state === 'committed' ? (
                <span
                  className="badge done mono"
                  style={{ fontSize: 10, gap: 4 }}
                  title={
                    commitSt.source === 'git-log'
                      ? `Commit detectado no Git (${commitSt.hash}): ${commitSt.message}`
                      : `Commitado (${commitSt.hash}${commitSt.branch ? ` em ${commitSt.branch}` : ''}): ${commitSt.message || item.title}`
                  }
                >
                  <CheckCircle2 size={10} /> {commitSt.hash}
                </span>
              ) : (
                <span
                  className="badge done"
                  style={{ fontSize: 10, gap: 4, opacity: .85 }}
                  title={`Repositório limpo em ${commitSt.branch || 'git'} — nenhuma alteração pendente para commitar`}
                >
                  <CheckCircle2 size={10} /> Git limpo
                </span>
              )
            )}
            <button
              className="btn btn-sm btn-icon"
              style={{ marginLeft: 'auto', padding: '3px 5px', borderColor: 'transparent', background: 'transparent', color: 'var(--muted)' }}
              title="Arquivar tarefa concluída"
              aria-label="Arquivar tarefa"
              onClick={() => archiveItem(item.id)}
            >
              <Archive size={12} />
            </button>
          </div>
        )}
      </div>
    );
  }

  const totalTasksInDocs = projectDocs.reduce((acc, d) => acc + (d.taskCount || 0), 0);
  const activeItems = card.items.filter((i) => !i.archived);
  const archivedItems = sortRecentFirst(card.items.filter((i) => !!i.archived));
  const filteredArchivedItems = archiveQuery.trim()
    ? archivedItems.filter((i) => `${i.title} ${i.phase || ''} ${i.body || ''} ${i.commit?.hash || ''}`.toLowerCase().includes(archiveQuery.trim().toLowerCase()))
    : archivedItems;

  return (
    <div key={entityId} className="card-editor-root board-fade-in">
      {conflict && (
        <div className="conflict-box">
          <h4>Conflito 409 — o quadro mudou em disco</h4>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>
            Um agente ou outra aba salvou uma versão mais recente. Escolha como resolver:
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                setCard(conflict.currentContent);
                setBaseHash(conflict.currentHash);
                setDirty(false);
                setConflict(null);
                sessionStorage.removeItem(draftKey);
              }}
            >
              Carregar versão do disco
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setBaseHash(conflict.currentHash);
                setConflict(null);
                onNotify('Base atualizada — clique em Salvar novamente para sobrescrever.');
              }}
            >
              Manter minhas edições
            </button>
          </div>
        </div>
      )}

      {offlineFallback && (
        <div className="conflict-box" style={{ background: 'rgba(229, 192, 99, .10)', borderColor: 'rgba(229, 192, 99, .45)' }}>
          <h4 style={{ color: 'var(--warn)' }}>Máquina do projeto offline — exibindo cópia em cache</h4>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Ligue a máquina dona da pasta para editar <code className="mono">.ai-workspace/board.card.json</code>.
          </div>
        </div>
      )}

      {runBootAlert && (
        <div className="conflict-box">
          <h4>Validação do Play falhou ao mover "{runBootAlert.title}" para Revisão</h4>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', wordBreak: 'break-word' }}>
            {runBootAlert.error}
          </p>
          <div className="ds-row">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                onSendPrompt(
                  `Ao mover "${runBootAlert.title}" para Revisão, a configuração de Play (\`.ai-workspace/run.json\`) foi testada mas o projeto não subiu sem erros:\n\n${runBootAlert.error}\n\nInvestigue a causa, ajuste \`.ai-workspace/run.json\` ou o código necessário e valide que o projeto sobe por completo sem erros.`,
                );
                setRunBootAlert(null);
              }}
            >
              <Sparkles size={12} /> Pedir à IA para corrigir boot
            </Button>
            <Button size="sm" onClick={() => setRunBootAlert(null)}>Fechar</Button>
          </div>
        </div>
      )}

      {/* Modal de Detalhes e Edição do Card (Item 1 e 3) */}
      {detailModal && (() => {
        const modalStage = (detailModal.draft.status || 'idea') as CardStatus;
        const modalStageLabel = BOARD_STATUSES.find((s) => s.id === modalStage)?.label || modalStage;
        const modalCommitSt = !detailModal.isNew && projectCwd ? resolveCardCommitStatus(detailModal.draft, gitInfo) : null;
        return (
        <div className="modal-bg">
          <div className={`modal card-detail-modal stage-${modalStage}`} style={{ maxWidth: 640, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>
                  {detailModal.isNew ? 'Novo item no Quadro' : 'Detalhes do card'}
                </h3>
                <span className={`badge ${modalStage}`} style={{ gap: 5 }}>
                  <span className={`col-dot ${modalStage}`} />
                  {modalStageLabel}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {!detailModal.isNew && modalStage !== 'done' && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      const item = detailModal.draft;
                      setDetailModal(null);
                      triggerExecute(item);
                    }}
                  >
                    <Play size={12} /> Executar
                  </button>
                )}
                {!detailModal.isNew && modalStage === 'done' && projectCwd && !offlineFallback && (gitInfo?.modified?.length ?? 1) > 0 && (
                  <button
                    className="btn btn-sm"
                    title="Commitar alterações pendentes no Git do projeto (0 tokens)"
                    onClick={() => {
                      const { title, id } = detailModal.draft;
                      setDetailModal(null);
                      promptQuickCommit(title, true, id);
                    }}
                  >
                    <GitCommitHorizontal size={13} /> Commitar
                  </button>
                )}
                {!detailModal.isNew && modalStage === 'done' && !detailModal.draft.archived && !offlineFallback && (
                  <button
                    className="btn btn-sm"
                    title="Arquivar tarefa concluída (sai da coluna Concluído mas continua acessível em Arquivados)"
                    onClick={() => archiveItem(detailModal.draft.id)}
                  >
                    <Archive size={13} /> Arquivar
                  </button>
                )}
                {!detailModal.isNew && detailModal.draft.archived && !offlineFallback && (
                  <button
                    className="btn btn-sm"
                    title="Restaurar tarefa para a coluna Concluído"
                    onClick={() => unarchiveItem(detailModal.draft.id)}
                  >
                    <ArchiveRestore size={13} /> Desarquivar
                  </button>
                )}
                <button className="btn btn-sm btn-icon" onClick={() => setDetailModal(null)} title="Fechar (Esc)">
                  <X size={15} />
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 11, paddingRight: 4 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Título</label>
                <input
                  className="inp"
                  autoFocus={detailModal.isNew}
                  disabled={offlineFallback}
                  value={detailModal.draft.title}
                  onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, title: e.target.value } } : null))}
                  placeholder="Título da tarefa ou melhoria…"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Coluna / Fase</label>
                  <select
                    className="sel"
                    disabled={offlineFallback}
                    value={detailModal.draft.status || 'idea'}
                    onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, status: e.target.value as CardStatus } } : null))}
                  >
                    {BOARD_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Tag / Etapa (opcional)</label>
                  <input
                    className="inp"
                    disabled={offlineFallback}
                    value={detailModal.draft.phase || ''}
                    onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, phase: e.target.value || undefined } } : null))}
                    placeholder="Ex.: Fase 1, Backend, UI…"
                  />
                </div>
              </div>

              <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '6px 9px', borderRadius: 7, background: 'rgba(255,255,255,.03)', border: '1px solid var(--border)' }}>
                {EGM_STAGE_GUIDE[modalStage]?.short}
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <label style={{ margin: 0 }}>Detalhes / Descrição (Markdown)</label>
                  <div className="seg">
                    <button
                      type="button"
                      className={!detailModal.bodyPreview ? 'on' : ''}
                      onClick={() => setDetailModal((p) => (p ? { ...p, bodyPreview: false } : null))}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className={detailModal.bodyPreview ? 'on' : ''}
                      onClick={() => setDetailModal((p) => (p ? { ...p, bodyPreview: true } : null))}
                    >
                      Visualizar
                    </button>
                  </div>
                </div>
                {detailModal.bodyPreview ? (
                  <div className="card-item md ds-m0" style={{ minHeight: 110, background: 'var(--ds-inset)' }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailModal.draft.body || '*Sem descrição.*'}</ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    className="ta"
                    rows={5}
                    disabled={offlineFallback}
                    value={detailModal.draft.body || ''}
                    onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, body: e.target.value } } : null))}
                    placeholder="Contexto, critérios de aceite, notas técnicas…"
                  />
                )}
              </div>

              {hasProjectCwd && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label style={{ margin: 0 }}>Documento / Spec vinculada</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {detailModal.draft.docRef ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              const ref = detailModal.draft.docRef!;
                              setDetailModal(null);
                              onOpenDoc?.(ref);
                            }}
                          >
                            <FileText size={12} /> Abrir doc
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={reviewRunning}
                            onClick={() => {
                              const item = detailModal.draft;
                              setDetailModal(null);
                              requestItemReview(item);
                            }}
                          >
                            🐟 Revisar Spec
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={offlineFallback || !detailModal.draft.title.trim()}
                          onClick={() => handleCreateSpecForItem(detailModal.draft)}
                        >
                          <FilePlus2 size={12} /> Criar Spec (0 tok)
                        </button>
                      )}
                    </div>
                  </div>
                  <input
                    className="inp mono"
                    style={{ fontSize: 12 }}
                    disabled={offlineFallback}
                    value={detailModal.draft.docRef || ''}
                    onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, docRef: e.target.value || undefined } } : null))}
                    placeholder="Ex.: docs/specs/minha-feature.md"
                  />
                  {detailModal.draft.review && detailModal.draft.review.status && detailModal.draft.review.status !== 'none' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12 }}>
                      <span className={`badge ${detailModal.draft.review.status === 'approved' ? 'done' : 'review'}`}>
                        {detailModal.draft.review.status === 'approved' ? '✅ Goldfish OK' : '⚠️ Ajustes sugeridos'}
                      </span>
                      <span style={{ color: 'var(--muted)', flex: 1 }}>{detailModal.draft.review.summary}</span>
                      {detailModal.draft.review.reportPath && (
                        <button
                          type="button"
                          className="doc-chip"
                          onClick={() => {
                            const rp = detailModal.draft.review!.reportPath!;
                            setDetailModal(null);
                            onOpenDoc?.(rp);
                          }}
                        >
                          Ver parecer
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="field" style={{ marginBottom: 0 }}>
                <label>Prompt customizado para IA (opcional)</label>
                <input
                  className="inp"
                  disabled={offlineFallback}
                  value={detailModal.draft.prompt || ''}
                  onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, prompt: e.target.value } } : null))}
                  placeholder="Deixe vazio para gerar automaticamente a partir do título e da spec…"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Link externo (opcional)</label>
                  <input
                    className="inp"
                    disabled={offlineFallback}
                    value={detailModal.draft.url || ''}
                    onChange={(e) => setDetailModal((p) => (p ? { ...p, draft: { ...p.draft, url: e.target.value || undefined } } : null))}
                    placeholder="https://…"
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Anexo de imagem</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <label className="btn btn-sm" style={{ cursor: offlineFallback ? 'default' : 'pointer' }}>
                      <ImagePlus size={13} /> {detailModal.draft.image ? 'Trocar imagem' : 'Anexar imagem'}
                      <input
                        type="file"
                        accept="image/*"
                        disabled={offlineFallback}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleModalImageUpload(f);
                        }}
                      />
                    </label>
                    {detailModal.draft.url && (
                      <a href={detailModal.draft.url} target="_blank" rel="noreferrer" className="btn btn-sm">
                        <ExternalLink size={12} /> Abrir link
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {detailModal.draft.image && (
                <img
                  src={api.entityAssetUrl(entityId, detailModal.draft.image)}
                  alt={detailModal.draft.alt || detailModal.draft.title}
                  style={{ width: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--ds-inset)' }}
                />
              )}

              {modalCommitSt && modalStage === 'done' && projectCwd && !offlineFallback && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                    <label style={{ margin: 0 }}>Status no Git</label>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={checkingGit}
                      onClick={() => refreshGitStatus(true)}
                      title="Rechecar git status e últimos commits (0 tokens)"
                    >
                      <RefreshCw size={11} className={checkingGit ? 'spin' : ''} /> Verificar Git
                    </button>
                  </div>
                  <div className="ds-inset-box ds-stack" style={{ gap: 5 }}>
                    {modalCommitSt.state === 'committed' ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ok)', flexWrap: 'wrap' }}>
                          <CheckCircle2 size={13} />
                          <b>Commitado</b>
                          <code className="mono">{modalCommitSt.hash}</code>
                          {modalCommitSt.branch && <span className="badge">{modalCommitSt.branch}</span>}
                          {modalCommitSt.source === 'git-log' && <span style={{ color: 'var(--muted)', fontSize: 11 }}>(detectado no histórico)</span>}
                        </div>
                        {modalCommitSt.message && (
                          <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{modalCommitSt.message}</div>
                        )}
                      </>
                    ) : modalCommitSt.state === 'pending' ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn)', flexWrap: 'wrap' }}>
                          <ShieldAlert size={13} />
                          <b>{modalCommitSt.reason || 'Alterações ainda não commitadas'}</b>
                        </div>
                        {gitInfo && gitInfo.modified.length > 0 && (
                          <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {gitInfo.modified.slice(0, 5).map((m, idx) => (
                              <div key={idx} className="ell">{m.code} {m.path}</div>
                            ))}
                            {gitInfo.modified.length > 5 && (
                              <div>+{gitInfo.modified.length - 5} outro(s) arquivo(s)</div>
                            )}
                          </div>
                        )}
                      </>
                    ) : modalCommitSt.state === 'clean' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ok)' }}>
                        <CheckCircle2 size={13} />
                        <span>Git limpo em <code className="mono">{modalCommitSt.branch || 'HEAD'}</code> — sem alterações pendentes.</span>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>Repositório Git não detectado nesta pasta.</span>
                    )}
                  </div>
                </div>
              )}

              {detailModal.draft.updatedAt && (
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Última alteração: {new Date(detailModal.draft.updatedAt).toLocaleString('pt-BR')}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
              {!detailModal.isNew && !offlineFallback && (
                <button className="btn btn-sm btn-danger" onClick={() => deleteFromModal(detailModal.draft.id)}>
                  <Trash2 size={13} /> Excluir
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={() => setDetailModal(null)}>Cancelar</button>
              <button
                className="btn btn-sm btn-primary"
                disabled={saving || offlineFallback || !detailModal.draft.title.trim()}
                onClick={saveDetailModal}
              >
                <Save size={13} /> {saving ? 'Salvando…' : detailModal.isNew ? 'Criar card' : 'Salvar alterações'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Modal de Tarefas Arquivadas */}
      <ModalFrame
        open={archiveModalOpen}
        onClose={() => setArchiveModalOpen(false)}
        closeOnBackdrop
        maxWidth={620}
        title={
          <span className="ds-row">
            <Archive size={16} color="var(--accent)" />
            Tarefas arquivadas ({archivedItems.length})
          </span>
        }
      >
        <input
          className="sb-search"
          style={{ width: '100%', flexShrink: 0 }}
          value={archiveQuery}
          onChange={(e) => setArchiveQuery(e.target.value)}
          placeholder="Filtrar tarefas arquivadas…"
        />
        <div className="ds-stack" style={{ gap: 7 }}>
          {filteredArchivedItems.length === 0 ? (
            <EmptyState compact>Nenhuma tarefa arquivada encontrada.</EmptyState>
          ) : (
            filteredArchivedItems.map((it) => (
              <div key={it.id} className="card-item stage-done ds-m0" style={{ padding: '9px 11px', opacity: 1 }}>
                <div className="ds-row" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <div className="ds-flex-1">
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{it.title || '(sem título)'}</div>
                    <div className="ds-row ds-wrap ds-text-muted" style={{ marginTop: 4, fontSize: 11 }}>
                      {it.phase && <Badge compact>{it.phase}</Badge>}
                      {it.commit?.hash && <Badge tone="done" mono compact>{it.commit.hash}</Badge>}
                      {it.archivedAt && (
                        <span>Arquivada em {new Date(it.archivedAt).toLocaleDateString('pt-BR')}</span>
                      )}
                    </div>
                  </div>
                  <div className="ds-row" style={{ flexShrink: 0 }}>
                    <Button
                      size="sm"
                      onClick={() => {
                        setArchiveModalOpen(false);
                        openItemModal(it);
                      }}
                    >
                      Detalhes
                    </Button>
                    {!offlineFallback && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => unarchiveItem(it.id)}
                        title="Restaurar para a coluna Concluído"
                      >
                        <ArchiveRestore size={12} /> Restaurar
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </ModalFrame>

      {/* Modal Goldfish Review */}
      {reviewModal && (
        <div className="modal-bg" onClick={() => { if (!reviewRunning) setReviewModal(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>🐟 Revisão Goldfish (EGM Lite)</h3>
              <button className="btn btn-sm" disabled={reviewRunning} onClick={() => setReviewModal(null)}>Fechar</button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
              Item: <b style={{ color: 'var(--text)' }}>{reviewModal.itemTitle}</b><br />
              Documento: <code className="mono" style={{ color: 'var(--accent)' }}>{reviewModal.docPath}</code>
            </div>

            {reviewModal.error && (
              <div className="conflict-box" style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12.5 }}>{reviewModal.error}</div>
              </div>
            )}

            {reviewModal.loading && !reviewModal.result ? (
              <div className="goldfish-box" style={{ textAlign: 'center', padding: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {reviewModal.estimate ? 'Revisando especificação com contexto zero (Goldfish)…' : 'Calculando estimativa de tokens…'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                  {reviewModal.estimate ? 'Aguarde alguns segundos pela resposta estruturada.' : 'Custo atual: 0 tokens.'}
                </div>
              </div>
            ) : reviewModal.result ? (
              <div className="goldfish-box">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  {reviewModal.result.verdict === 'approved'
                    ? <CheckCircle2 size={16} color="var(--ok)" />
                    : <ShieldAlert size={16} color="var(--warn)" />}
                  <strong style={{ fontSize: 13.5 }}>
                    {reviewModal.result.verdict === 'approved' ? 'Spec Aprovada pelo Goldfish' : 'Goldfish sugeriu ajustes'}
                  </strong>
                  <span className="badge">{reviewModal.result.engine}{reviewModal.result.model ? `/${reviewModal.result.model}` : ''}</span>
                  {reviewModal.result.usage && (
                    <span className="badge">
                      {fmtTok(reviewModal.result.usage.totalTokens)} tok ({reviewModal.result.usage.estimated ? 'est.' : 'real'})
                    </span>
                  )}
                </div>
                <p style={{ margin: '0 0 8px', fontSize: 13 }}>{reviewModal.result.summary}</p>
                {reviewModal.result.gaps.length > 0 && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    <b>Lacunas:</b>
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                      {reviewModal.result.gaps.map((g, i) => <li key={i}>{g}</li>)}
                    </ul>
                  </div>
                )}
                {reviewModal.result.risks.length > 0 && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    <b>Riscos:</b>
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                      {reviewModal.result.risks.map((rk, i) => <li key={i}>{rk}</li>)}
                    </ul>
                  </div>
                )}
                {reviewModal.result.cuts.length > 0 && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    <b>Simplificações:</b>
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                      {reviewModal.result.cuts.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {reviewModal.result.reportPath && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        const rp = reviewModal.result?.reportPath;
                        setReviewModal(null);
                        if (rp) onOpenDoc?.(rp);
                      }}
                    >
                      Abrir parecer em Docs & Specs
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => setReviewModal(null)}>Concluir</button>
                </div>
              </div>
            ) : reviewModal.estimate ? (
              <div className="goldfish-box">
                <div style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
                  {reviewModal.estimate.available ? (
                    <>
                      1 chamada isolada (contexto zero, sem histórico de conversa).<br />
                      Motor: <b>{reviewModal.estimate.engine}{reviewModal.estimate.model ? `/${reviewModal.estimate.model}` : ''}</b><br />
                      Estimativa: <b>~{fmtTok(reviewModal.estimate.estimatedTotalTokens)} tokens</b>
                      {' '}(entrada ~{fmtTok(reviewModal.estimate.estimatedInputTokens)} / saída ~{fmtTok(reviewModal.estimate.estimatedOutputTokens)})
                      {reviewModal.estimate.engine === 'Ollama' ? ' · 0 de cota!' : ''}
                    </>
                  ) : (
                    <span style={{ color: 'var(--warn)' }}>Nenhum motor disponível: {reviewModal.estimate.reason}</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm" onClick={() => setReviewModal(null)}>Cancelar</button>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!reviewModal.estimate.available || reviewRunning}
                    onClick={confirmItemReview}
                  >
                    Confirmar revisão Goldfish
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div className="toolbar">
        <div className="seg">
          {([
            ['board', 'Board', Columns3],
            ['research', 'Lista', List],
            ['gallery', 'Gallery', LayoutGrid],
          ] as [CardTemplate, string, typeof Columns3][]).map(([tpl, label, Icon]) => (
            <button
              key={tpl}
              className={card.template === tpl ? 'on' : ''}
              onClick={() => updateCard({ ...card, template: tpl })}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon size={13} /> {label}
              </span>
            </button>
          ))}
        </div>

        <button className="btn btn-sm" onClick={() => openNewItemModal('idea')} disabled={offlineFallback}>
          <Plus size={14} /> Novo item
        </button>

        {hasProjectCwd && (
          <>
            <button
              className="btn btn-sm"
              onClick={() => { setImportOpen((v) => !v); setAiStructEstimate(null); setAiProposed(null); }}
              disabled={offlineFallback}
              title="Importar planos, specs e checklists da pasta docs/ do projeto"
            >
              <Download size={13} /> Importar de docs/
            </button>
            <button
              className="btn btn-sm"
              onClick={() => onSendPrompt(AUDIT_BOARD_PROMPT)}
              disabled={offlineFallback}
              title="Pedir à IA no chat para auditar .ai-workspace/board.card.json contra o código/git e atualizar os status"
            >
              <Bot size={13} /> Auditar com IA
            </button>
            <button
              className="btn btn-sm"
              onClick={() => handleUndoBoard(false)}
              disabled={undoing || offlineFallback}
              title="Restaurar versão anterior do Quadro (desfazer importação ou alteração da IA)"
            >
              <RotateCcw size={13} /> {undoing ? 'Desfazendo…' : 'Desfazer'}
            </button>
          </>
        )}

        {archivedItems.length > 0 && (
          <button
            className="btn btn-sm"
            onClick={() => { setArchiveQuery(''); setArchiveModalOpen(true); }}
            title="Ver ou restaurar tarefas concluídas arquivadas"
          >
            <Archive size={13} /> Arquivados ({archivedItems.length})
          </button>
        )}

        <button
          className="btn btn-sm btn-icon"
          onClick={() => { checkExternalUpdate(true); refreshGitStatus(false); }}
          disabled={refreshing}
          title="Atualizar quadro e status Git sem recarregar a página"
          aria-label="Atualizar quadro"
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
        </button>

        <span className="badge" title={storage === 'in-project' ? 'Salvo em .ai-workspace/board.card.json dentro da pasta do projeto (portátil entre workspaces)' : 'Salvo no Hub do AI Workspace'}>
          <HardDrive size={11} /> {storage === 'in-project' ? '.ai-workspace' : storage === 'hub-cache' ? 'Cache offline' : 'Hub'}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {saving && <span className="badge" style={{ fontSize: 11 }}>Salvando…</span>}
          {!saving && dirty && conflict && (
            <button className="btn btn-primary btn-sm" disabled={offlineFallback} onClick={() => save()}>
              <Save size={14} /> Salvar
            </button>
          )}
        </div>
      </div>

      {/* Prompt rápido de commit ao concluir tarefa (0 tokens) */}
      {quickCommit && projectCwd && !offlineFallback && (
        <div className="quick-commit-bar">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <GitCommitHorizontal size={15} color="var(--ok)" />
              <span>
                Tarefa concluída · <b>{quickCommit.modified.length} arquivo(s)</b> alterado(s) em <code className="mono">{quickCommit.branch}</code>
              </span>
              <span
                className="badge"
                title={quickCommit.modified.slice(0, 12).map((m) => `${m.code} ${m.path}`).join('\n')}
                style={{ cursor: 'help' }}
              >
                ver arquivos
              </span>
            </div>
            <button className="btn btn-sm btn-icon" onClick={() => setQuickCommit(null)} title="Fechar" disabled={quickCommit.committing}>
              <X size={13} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="inp"
              style={{ flex: 1, minWidth: 220, padding: '6px 10px', fontSize: 12.5 }}
              value={quickCommit.message}
              disabled={quickCommit.committing}
              onChange={(e) => setQuickCommit((prev) => (prev ? { ...prev, message: e.target.value } : null))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runQuickCommit();
                } else if (e.key === 'Escape') {
                  setQuickCommit(null);
                }
              }}
              placeholder="Mensagem do commit…"
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={quickCommit.push}
                disabled={quickCommit.committing}
                onChange={(e) => setQuickCommit((prev) => (prev ? { ...prev, push: e.target.checked } : null))}
              />
              Fazer push
            </label>
            <button className="btn btn-sm" disabled={quickCommit.committing} onClick={() => setQuickCommit(null)}>
              Agora não
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={quickCommit.committing || !quickCommit.message.trim()}
              onClick={runQuickCommit}
            >
              <GitCommitHorizontal size={13} /> {quickCommit.committing ? 'Commitando…' : 'Commitar'}
            </button>
          </div>
        </div>
      )}

      {/* Só avisa mudança em disco quando há edição local aberta/não salva */}
      {pendingExternalReload && (
        <div className="docs-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', borderColor: 'rgba(229, 192, 99, .45)', background: 'rgba(229, 192, 99, .10)' }}>
          <span style={{ fontSize: 12.5 }}>
            🔄 O quadro mudou em disco enquanto você editava.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm btn-primary" onClick={() => checkExternalUpdate(true)}>Recarregar do disco</button>
            <button className="btn btn-sm" onClick={() => setPendingExternalReload(false)}>Ignorar</button>
          </div>
        </div>
      )}

      {/* Banner de desfazer rápido logo após importação de docs/ */}
      {recentImportCount !== null && hasProjectCwd && !offlineFallback && (
        <div className="docs-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px' }}>
          <span style={{ fontSize: 12.5 }}>
            📥 <b>{recentImportCount} item(ns)</b> importado(s) para o Quadro. Não ficou como queria?
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm btn-primary" disabled={undoing} onClick={() => handleUndoBoard(true)}>
              <RotateCcw size={12} /> Desfazer importação
            </button>
            <button className="btn btn-sm" onClick={() => setRecentImportCount(null)}>Manter</button>
          </div>
        </div>
      )}

      {/* Onboarding automático quando o quadro está vazio e existem docs/ no projeto */}
      {hasProjectCwd && card.items.length === 0 && projectDocs.length > 0 && !importOpen && !offlineFallback && (
        <div className="docs-banner" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <strong style={{ fontSize: 13.5 }}>📚 Encontramos {projectDocs.length} documento(s) neste projeto</strong>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              {totalTasksInDocs > 0
                ? `${totalTasksInDocs} tarefa(s)/seção(ões) prontas para montar o Quadro inicial com 0 tokens.`
                : 'Você pode importar esses documentos ou estruturar o Quadro inicial a partir deles.'}
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setImportOpen(true)}>
            <Download size={13} /> Montar Quadro a partir de docs/
          </button>
        </div>
      )}

      {importOpen && hasProjectCwd && (
        <div className="docs-banner">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong style={{ fontSize: 13.5 }}>📥 Estruturar Quadro a partir dos documentos do projeto</strong>
            <button className="btn btn-sm" onClick={() => setImportOpen(false)}>Fechar</button>
          </div>
          {projectDocs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Nenhum arquivo Markdown encontrado em <code className="mono">docs/</code> ou na raiz do projeto.
            </div>
          ) : (
            <>
              <div style={{ maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                {projectDocs.filter((d) => d.category !== 'review').map((d) => {
                  const checked = selectedDocs.includes(d.path);
                  return (
                    <label
                      key={d.path}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 7, background: 'var(--card)', cursor: 'pointer', fontSize: 12 }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedDocs((prev) => (e.target.checked ? [...prev, d.path] : prev.filter((p) => p !== d.path)));
                        }}
                      />
                      <span className="ell" style={{ fontWeight: 600 }}>{d.title}</span>
                      <span className="mono ell" style={{ color: 'var(--muted)', fontSize: 11, flex: 1 }}>{d.path}</span>
                      {d.taskCount > 0 && <span className="badge">{d.taskCount} item(ns)</span>}
                    </label>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!selectedDocs.length || importingDocs}
                  onClick={handleDeterministicImport}
                >
                  <Download size={13} /> {importingDocs ? 'Importando…' : 'Importar checklists e seções (0 tokens)'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={!selectedDocs.length || aiStructLoading}
                  onClick={handleAiStructureDryRun}
                  title="Útil quando os docs são texto corrido sem checkboxes — mostra estimativa de tokens antes de rodar"
                >
                  <Sparkles size={13} /> {aiStructLoading ? 'Calculando…' : 'Estruturar com IA (ver custo antes)'}
                </button>
              </div>

              {aiStructEstimate && (
                <div className="goldfish-box" style={{ marginTop: 10, marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12 }}>
                      {aiStructEstimate.available ? (
                        <>
                          Motor: <b>{aiStructEstimate.engine}{aiStructEstimate.model ? `/${aiStructEstimate.model}` : ''}</b> ·
                          Estimativa: <b>~{fmtTok(aiStructEstimate.estimatedTotalTokens || 0)} tokens</b>
                          {' '}(in ~{fmtTok(aiStructEstimate.estimatedInputTokens || 0)} / out ~{fmtTok(aiStructEstimate.estimatedOutputTokens || 0)})
                        </>
                      ) : (
                        <span style={{ color: 'var(--warn)' }}>Indisponível: {aiStructEstimate.reason}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => setAiStructEstimate(null)}>Cancelar</button>
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={!aiStructEstimate.available || aiStructLoading}
                        onClick={handleAiStructureConfirm}
                      >
                        {aiStructLoading ? 'Gerando…' : 'Confirmar e gerar prévia'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {aiProposed && (
                <div className="goldfish-box" style={{ marginTop: 10, marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <strong style={{ fontSize: 12.5 }}>Prévia sugerida pela IA ({aiProposed.length} itens)</strong>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => setAiProposed(null)}>Descartar</button>
                      <button className="btn btn-sm btn-primary" onClick={applyAiProposed}>Aplicar ao Quadro</button>
                    </div>
                  </div>
                  <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {aiProposed.map((it) => (
                      <div key={it.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className={`badge ${it.status || 'idea'}`}>{it.status || 'idea'}</span>
                        <b>{it.title}</b>
                        {it.docRef && <span className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>{it.docRef}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {card.template === 'board' && (
        <div className="board-scroll">
          <div className="board-grid">
            {BOARD_STATUSES.map((col) => {
              const items = sortRecentFirst(activeItems.filter((i) => (i.status || 'idea') === col.id));
              return (
                <div
                  key={col.id}
                  className={`board-col ${dragOverCol === col.id ? 'drag-over' : ''}`}
                  onDragOver={(e) => {
                    if (offlineFallback) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverCol !== col.id) setDragOverCol(col.id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDragOverCol((cur) => (cur === col.id ? null : cur));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const droppedId = e.dataTransfer.getData('text/plain') || dragItemId;
                    setDragItemId(null);
                    setDragOverCol(null);
                    setDragOverCardId(null);
                    if (droppedId) handleDropCard(droppedId, col.id);
                  }}
                >
                  <div className="board-col-head">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <StageDot stage={col.id} />
                      {col.label} ({items.length})
                    </span>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {col.id === 'done' && items.length > 0 && !offlineFallback && (
                        <button
                          className="btn btn-sm btn-icon"
                          onClick={archiveAllDone}
                          title={`Arquivar todas as ${items.length} tarefa(s) concluída(s)`}
                          aria-label="Arquivar tarefas concluídas"
                        >
                          <Archive size={12} />
                        </button>
                      )}
                      <button className="btn btn-sm btn-icon" onClick={() => openNewItemModal(col.id)} title={`Adicionar em ${col.label}`} disabled={offlineFallback}>
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="board-col-body">
                    {items.map(renderItemCard)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {card.template === 'research' && (
        <div className="research-list">
          {activeItems.length === 0 ? <div className="empty">Nenhum item ativo. Clique em "Novo item" ou "Importar de docs/".</div> : sortRecentFirst(activeItems).map(renderItemCard)}
        </div>
      )}

      {card.template === 'gallery' && (
        <div className="gallery-grid">
          {activeItems.length === 0 ? <div className="empty">Galeria vazia. Adicione itens com imagens ou prompts.</div> : sortRecentFirst(activeItems).map(renderItemCard)}
        </div>
      )}
    </div>
  );
}
