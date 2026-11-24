import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  CheckCircle2,
  Columns3,
  Download,
  ExternalLink,
  FilePlus2,
  FileText,
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
import type { CardExecIntent } from './LiveHudPane';
import type {
  CardDoc,
  CardItem,
  CardStatus,
  CardTemplate,
  ConflictError,
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
  reloadKey?: number;
  snapshotVersion?: string;
  onNotify: (msg: string, err?: boolean) => void;
  onSendPrompt: (prompt: string) => void;
  onExecuteItem?: (intent: CardExecIntent) => void;
  onOpenDoc?: (docPath: string) => void;
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

export function CardEditor({
  entityId,
  filePath,
  hasProjectCwd = false,
  reloadKey = 0,
  snapshotVersion = '',
  onNotify,
  onSendPrompt,
  onExecuteItem,
  onOpenDoc,
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
  const loadSeqRef = useRef(0);

  // Modal de detalhes e edição de card
  const [detailModal, setDetailModal] = useState<{ draft: CardItem; isNew: boolean; bodyPreview: boolean } | null>(null);

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

  useEffect(() => {
    if (snapshotVersion && baseHashRef.current) checkExternalUpdate(false);
  }, [snapshotVersion]);

  function updateCard(next: CardDoc) {
    setCard(next);
    setDirty(true);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {}
  }

  async function save(cardOverride?: CardDoc, silentToast = false) {
    const targetCard = cardOverride || card;
    if (!targetCard || saving || offlineFallback) return false;
    setSaving(true);
    try {
      const r = hasProjectCwd
        ? await api.saveProjectBoard({ entityId, content: targetCard, baseHash })
        : await api.saveEntityFile({ id: entityId, path: filePath, content: targetCard, baseHash });
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
      setSaving(false);
    }
  }

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
      if (prev) {
        await syncCheckboxIfCrossedDone((prev.status || 'idea') as CardStatus, (stamped.status || 'idea') as CardStatus, stamped);
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
    if (item.prompt) return item.prompt;
    if (item.docRef) {
      return `Leia \`${item.docRef}\` e trabalhe na tarefa "${item.title}"${item.body ? `:\n${item.body}` : '.'}`;
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
              title="Executar tarefa com IA (avança para a próxima fase ao concluir)"
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
      </div>
    );
  }

  const totalTasksInDocs = projectDocs.reduce((acc, d) => acc + (d.taskCount || 0), 0);

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

      {/* Modal de Detalhes e Edição do Card (Item 1 e 3) */}
      {detailModal && (
        <div className="modal-bg" onClick={() => setDetailModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexShrink: 0 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {detailModal.isNew ? 'Novo item no Quadro' : 'Detalhes do card'}
              </h3>
              <div style={{ display: 'flex', gap: 6 }}>
                {!detailModal.isNew && (detailModal.draft.status || 'idea') !== 'done' && (
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
                  <div className="card-item md" style={{ minHeight: 110, marginBottom: 0, background: '#101216' }}>
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
                  style={{ width: '100%', maxHeight: 200, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: '#101216' }}
                />
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
      )}

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

        <button
          className="btn btn-sm btn-icon"
          onClick={() => checkExternalUpdate(true)}
          disabled={refreshing}
          title="Atualizar quadro do disco sem recarregar a página"
          aria-label="Atualizar quadro"
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
        </button>

        <span className="badge" title={storage === 'in-project' ? 'Salvo em .ai-workspace/board.card.json dentro da pasta do projeto (portátil entre workspaces)' : 'Salvo no Hub do AI Workspace'}>
          <HardDrive size={11} /> {storage === 'in-project' ? '.ai-workspace' : storage === 'hub-cache' ? 'Cache offline' : 'Hub'}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {dirty && <span className="badge waiting">Não salvo</span>}
          {dirty && (
            <button className="btn btn-primary btn-sm" disabled={saving || offlineFallback} onClick={() => save()}>
              <Save size={14} /> {saving ? 'Salvando…' : 'Salvar (Ctrl+S)'}
            </button>
          )}
        </div>
      </div>

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
              const items = sortRecentFirst(card.items.filter((i) => (i.status || 'idea') === col.id));
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
                      <span className={`col-dot ${col.id}`} />
                      {col.label} ({items.length})
                    </span>
                    <button className="btn btn-sm btn-icon" onClick={() => openNewItemModal(col.id)} title={`Adicionar em ${col.label}`} disabled={offlineFallback}>
                      <Plus size={12} />
                    </button>
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
          {card.items.length === 0 ? <div className="empty">Nenhum item ainda. Clique em "Novo item" ou "Importar de docs/".</div> : sortRecentFirst(card.items).map(renderItemCard)}
        </div>
      )}

      {card.template === 'gallery' && (
        <div className="gallery-grid">
          {card.items.length === 0 ? <div className="empty">Galeria vazia. Adicione itens com imagens ou prompts.</div> : sortRecentFirst(card.items).map(renderItemCard)}
        </div>
      )}
    </div>
  );
}
