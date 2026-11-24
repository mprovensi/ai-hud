import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown,
  ArrowUp,
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
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type {
  CardDoc,
  CardItem,
  CardStatus,
  CardTemplate,
  ConflictError,
  GoldfishEstimate,
  ProjectDocEntry,
} from '../types';

const STATUSES: { id: CardStatus; label: string }[] = [
  { id: 'idea', label: 'Ideia' },
  { id: 'spec', label: 'Spec / Plano' },
  { id: 'in-progress', label: 'Em andamento' },
  { id: 'review', label: 'Revisão' },
  { id: 'done', label: 'Concluído' },
];

interface Props {
  entityId: string;
  filePath: string;
  hasProjectCwd?: boolean;
  reloadKey?: number;
  onNotify: (msg: string, err?: boolean) => void;
  onSendPrompt: (prompt: string) => void;
  onOpenDoc?: (docPath: string) => void;
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function CardEditor({
  entityId,
  filePath,
  hasProjectCwd = false,
  reloadKey = 0,
  onNotify,
  onSendPrompt,
  onOpenDoc,
}: Props) {
  const draftKey = `aiws.draft.${entityId}.${filePath}`;
  const [card, setCard] = useState<CardDoc | null>(null);
  const [baseHash, setBaseHash] = useState('');
  const [storage, setStorage] = useState<'in-project' | 'hub' | 'hub-cache'>('hub');
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentContent: CardDoc; currentHash: string } | null>(null);

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

  // Revisão Goldfish sob demanda direto do Quadro
  const [reviewTarget, setReviewTarget] = useState<{ itemId: string; docPath: string; estimate: GoldfishEstimate } | null>(null);
  const [reviewRunning, setReviewRunning] = useState(false);

  // Drag-and-drop entre colunas
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<CardStatus | null>(null);

  async function load(ignoreDraft = false) {
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
      onNotify((e as Error).message, true);
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
    setEditingId(null);
    setImportOpen(false);
    setAiStructEstimate(null);
    setAiProposed(null);
    setReviewTarget(null);
    load();
    refreshProjectDocs();
  }, [entityId, filePath, hasProjectCwd, reloadKey]);

  function updateCard(next: CardDoc) {
    setCard(next);
    setDirty(true);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {}
  }

  async function save(cardOverride?: CardDoc) {
    const targetCard = cardOverride || card;
    if (!targetCard || saving || offlineFallback) return;
    setSaving(true);
    try {
      const r = hasProjectCwd
        ? await api.saveProjectBoard({ entityId, content: targetCard, baseHash })
        : await api.saveEntityFile({ id: entityId, path: filePath, content: targetCard, baseHash });
      setBaseHash(r.hash);
      setDirty(false);
      setConflict(null);
      sessionStorage.removeItem(draftKey);
      if (hasProjectCwd) setStorage('in-project');
      onNotify('Quadro salvo.');
    } catch (e) {
      const ce = e as ConflictError;
      if (ce.conflict && ce.currentContent) {
        setConflict({ currentContent: ce.currentContent as CardDoc, currentHash: ce.currentHash });
        onNotify('Conflito detectado: o quadro foi alterado em disco.', true);
      } else {
        onNotify(ce.message, true);
      }
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, baseHash, saving, offlineFallback]);

  if (!card) return <div className="empty">Carregando quadro…</div>;

  function addItem(status: CardStatus = 'idea') {
    if (!card) return;
    const id = `item-${Date.now().toString(36)}`;
    const nextItem: CardItem = { id, title: 'Novo item', body: '', status };
    updateCard({ ...card, items: [...card.items, nextItem] });
    setEditingId(id);
  }

  function patchItem(id: string, patch: Partial<CardItem>) {
    if (!card) return;
    updateCard({ ...card, items: card.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  }

  async function changeItemStatus(item: CardItem, nextStatus: CardStatus, autoSave = false) {
    if (!card || offlineFallback) return;
    const prevStatus = item.status || 'idea';
    if (prevStatus === nextStatus) return;
    const nextCard: CardDoc = {
      ...card,
      items: card.items.map((it) => (it.id === item.id ? { ...it, status: nextStatus } : it)),
    };
    updateCard(nextCard);
    if (autoSave) {
      await save(nextCard);
    }
    // Sync reverso Quadro -> docs/: ao entrar ou sair de "Concluído", atualiza `- [x]` / `- [ ]` no Markdown vinculado
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

  function removeItem(id: string) {
    if (!card) return;
    updateCard({ ...card, items: card.items.filter((it) => it.id !== id) });
    if (editingId === id) setEditingId(null);
  }

  function moveItem(id: string, delta: number) {
    if (!card) return;
    const idx = card.items.findIndex((i) => i.id === id);
    const nextIdx = idx + delta;
    if (idx < 0 || nextIdx < 0 || nextIdx >= card.items.length) return;
    const copy = [...card.items];
    const [moved] = copy.splice(idx, 1);
    copy.splice(nextIdx, 0, moved);
    updateCard({ ...card, items: copy });
  }

  async function handleImageUpload(itemId: string, file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api.uploadEntityMedia({
          id: entityId,
          fileName: file.name,
          base64Data: String(reader.result || ''),
        });
        patchItem(itemId, { image: res.path, alt: file.name });
        onNotify('Imagem anexada. Salve o quadro para persistir.');
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
      const nextCard: CardDoc = {
        ...card,
        items: card.items.map((it) => (it.id === item.id ? { ...it, docRef: r.path, status: 'spec' } : it)),
      };
      setCard(nextCard);
      await save(nextCard);
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
    try {
      const r = await api.reviewProjectSpec({ entityId, docPath, itemId: item.id, dryRun: true });
      if ('dryRun' in r && r.dryRun) {
        setReviewTarget({ itemId: item.id, docPath, estimate: r });
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setReviewRunning(false);
    }
  }

  async function confirmItemReview() {
    if (!reviewTarget || reviewRunning) return;
    setReviewRunning(true);
    try {
      const r = await api.reviewProjectSpec({
        entityId,
        docPath: reviewTarget.docPath,
        itemId: reviewTarget.itemId,
        dryRun: false,
      });
      if (!('dryRun' in r)) {
        const tok = r.usage ? ` · ${fmtTok(r.usage.totalTokens)} tok${r.usage.estimated ? ' est.' : ''}` : '';
        onNotify(`Goldfish (${r.engine}${tok}): ${r.verdict === 'approved' ? 'Spec aprovada' : 'Ajustes sugeridos'}`);
        setReviewTarget(null);
        await load(true);
      }
    } catch (e) {
      onNotify((e as Error).message, true);
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
      onNotify(
        r.addedCount && r.addedCount > 0
          ? `${r.addedCount} item(ns) importado(s) para o Quadro (0 tokens).`
          : 'Nenhum item novo encontrado nos documentos selecionados (0 tokens).',
      );
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
    const added: CardItem[] = [];
    for (const it of aiProposed) {
      if (seen.has(it.title.trim().toLowerCase())) continue;
      let id = it.id;
      let n = 2;
      while (usedIds.has(id)) id = `${it.id}-${n++}`;
      usedIds.add(id);
      seen.add(it.title.trim().toLowerCase());
      added.push({ ...it, id });
    }
    const nextCard = { ...card, items: [...card.items, ...added] };
    setAiProposed(null);
    setImportOpen(false);
    updateCard(nextCard);
    save(nextCard);
  }

  function buildExecutePrompt(item: CardItem): string {
    if (item.prompt) return item.prompt;
    if (item.docRef) {
      return `Leia \`${item.docRef}\` e trabalhe na tarefa "${item.title}"${item.body ? `:\n${item.body}` : '.'}`;
    }
    return `Trabalhe na tarefa "${item.title}"${item.body ? `:\n${item.body}` : '.'}`;
  }

  function renderItemCard(item: CardItem) {
    const isEditing = editingId === item.id;
    const docClean = (item.docRef || '').split('#')[0];
    const canDrag = card?.template === 'board' && !isEditing && !offlineFallback;
    return (
      <div
        key={item.id}
        className={`card-item ${dragItemId === item.id ? 'dragging' : ''}`}
        draggable={canDrag}
        onDragStart={(e) => {
          if (!canDrag) return;
          setDragItemId(item.id);
          e.dataTransfer.setData('text/plain', item.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          setDragItemId(null);
          setDragOverCol(null);
        }}
      >
        {isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <input
              className="inp"
              value={item.title}
              onChange={(e) => patchItem(item.id, { title: e.target.value })}
              placeholder="Título da tarefa"
            />
            <textarea
              className="ta"
              rows={3}
              value={item.body || ''}
              onChange={(e) => patchItem(item.id, { body: e.target.value })}
              placeholder="Descrição / notas (suporta Markdown)"
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                className="sel"
                value={item.status || 'idea'}
                onChange={(e) => patchItem(item.id, { status: e.target.value as CardStatus })}
              >
                {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <input
                className="inp"
                value={item.phase || ''}
                onChange={(e) => patchItem(item.id, { phase: e.target.value || undefined })}
                placeholder="Fase / tag (opcional)"
              />
            </div>
            <input
              className="inp mono"
              style={{ fontSize: 11.5 }}
              value={item.docRef || ''}
              onChange={(e) => patchItem(item.id, { docRef: e.target.value || undefined })}
              placeholder="Doc vinculado (ex.: docs/specs/auth.md)"
            />
            <input
              className="inp"
              value={item.prompt || ''}
              onChange={(e) => patchItem(item.id, { prompt: e.target.value })}
              placeholder="Prompt customizado para IA (opcional)"
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                <ImagePlus size={13} /> Imagem
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImageUpload(item.id, f);
                  }}
                />
              </label>
              <button className="btn btn-sm btn-primary" onClick={() => setEditingId(null)}>Concluir</button>
              <button className="btn btn-sm btn-danger" onClick={() => removeItem(item.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <h4 style={{ flex: 1, cursor: 'pointer' }} onClick={() => setEditingId(item.id)}>
                {item.title || '(sem título)'}
              </h4>
              {card?.template !== 'board' && item.status && (
                <span className={`badge ${item.status}`}>{STATUSES.find((s) => s.id === item.status)?.label || item.status}</span>
              )}
            </div>

            {(item.phase || docClean || (item.review && item.review.status && item.review.status !== 'none')) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
                {item.phase && <span className="badge" style={{ fontSize: 10 }}>{item.phase}</span>}
                {docClean && (
                  <button
                    type="button"
                    className="doc-chip mono ell"
                    title={`Abrir ${item.docRef} em Docs & Specs`}
                    onClick={() => onOpenDoc?.(item.docRef!)}
                  >
                    <FileText size={11} style={{ flexShrink: 0 }} />
                    <span className="ell">{docClean.split('/').pop()}</span>
                  </button>
                )}
                {item.review && item.review.status && item.review.status !== 'none' && (
                  <button
                    type="button"
                    className={`badge ${item.review.status === 'approved' ? 'done' : 'review'}`}
                    style={{ fontSize: 10, cursor: item.review.reportPath ? 'pointer' : 'default' }}
                    title={item.review.summary || 'Parecer da revisão Goldfish'}
                    onClick={() => { if (item.review?.reportPath) onOpenDoc?.(item.review.reportPath); }}
                  >
                    {item.review.status === 'approved' ? <CheckCircle2 size={11} /> : <ShieldAlert size={11} />}
                    {item.review.status === 'approved' ? 'Goldfish OK' : 'Ajustes'}
                  </button>
                )}
              </div>
            )}

            {item.image && <img src={api.entityAssetUrl(entityId, item.image)} alt={item.alt || item.title} />}
            {item.body && (
              <div className="md" style={{ fontSize: 12, color: 'var(--muted)' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
              </div>
            )}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, marginTop: 4 }}
              >
                <ExternalLink size={12} /> {item.linkLabel || item.url}
              </a>
            )}

            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setEditingId(item.id)}>Editar</button>
              {hasProjectCwd && !docClean && (item.status === 'idea' || !item.status) && (
                <button
                  className="btn btn-sm"
                  title="Criar especificação enxuta (docs/specs/) e mover para Spec (0 tokens)"
                  onClick={() => handleCreateSpecForItem(item)}
                >
                  <FilePlus2 size={12} /> Spec
                </button>
              )}
              {hasProjectCwd && docClean && (
                <button
                  className="btn btn-sm"
                  title="Revisão Goldfish isolada desta spec (mostra estimativa de tokens antes)"
                  onClick={() => requestItemReview(item)}
                  disabled={reviewRunning}
                >
                  🐟 Revisar
                </button>
              )}
              <button
                className="btn btn-sm"
                title="Enviar tarefa para a conversa com IA (contexto enxuto)"
                onClick={() => onSendPrompt(buildExecutePrompt(item))}
              >
                <Play size={12} /> Executar
              </button>
              {card?.template === 'board' && (
                <select
                  className="sel"
                  style={{ width: 'auto', padding: '3px 6px', fontSize: 11 }}
                  value={item.status || 'idea'}
                  onChange={(e) => changeItemStatus(item, e.target.value as CardStatus, false)}
                >
                  {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              )}
              <button className="btn btn-sm btn-icon" title="Subir" onClick={() => moveItem(item.id, -1)}>
                <ArrowUp size={12} />
              </button>
              <button className="btn btn-sm btn-icon" title="Descer" onClick={() => moveItem(item.id, 1)}>
                <ArrowDown size={12} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const totalTasksInDocs = projectDocs.reduce((acc, d) => acc + (d.taskCount || 0), 0);

  return (
    <div>
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

      {reviewTarget && (
        <div className="goldfish-box">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ fontSize: 13 }}>🐟 Revisão Goldfish de <code className="mono">{reviewTarget.docPath}</code></strong>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                {reviewTarget.estimate.available ? (
                  <>
                    1 chamada isolada (contexto zero) · Motor: <b style={{ color: 'var(--text)' }}>{reviewTarget.estimate.engine}{reviewTarget.estimate.model ? `/${reviewTarget.estimate.model}` : ''}</b> ·
                    Estimativa: <b style={{ color: 'var(--text)' }}>~{fmtTok(reviewTarget.estimate.estimatedTotalTokens)} tokens</b>
                    {reviewTarget.estimate.engine === 'Ollama' ? ' (0 de cota!)' : ''}
                  </>
                ) : (
                  <span style={{ color: 'var(--warn)' }}>Nenhum motor disponível: {reviewTarget.estimate.reason}</span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" onClick={() => setReviewTarget(null)}>Cancelar</button>
              <button
                className="btn btn-sm btn-primary"
                disabled={!reviewTarget.estimate.available || reviewRunning}
                onClick={confirmItemReview}
              >
                {reviewRunning ? 'Revisando…' : 'Confirmar revisão'}
              </button>
            </div>
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

        <button className="btn btn-sm" onClick={() => addItem('idea')} disabled={offlineFallback}>
          <Plus size={14} /> Novo item
        </button>

        {hasProjectCwd && (
          <button
            className="btn btn-sm"
            onClick={() => { setImportOpen((v) => !v); setAiStructEstimate(null); setAiProposed(null); }}
            disabled={offlineFallback}
            title="Importar planos, specs e checklists da pasta docs/ do projeto"
          >
            <Download size={13} /> Importar de docs/
          </button>
        )}

        <span className="badge" title={storage === 'in-project' ? 'Salvo em .ai-workspace/board.card.json dentro da pasta do projeto (portátil entre workspaces)' : 'Salvo no Hub do AI Workspace'}>
          <HardDrive size={11} /> {storage === 'in-project' ? '.ai-workspace (portátil)' : storage === 'hub-cache' ? 'Cache offline' : 'Hub'}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {dirty && <span className="badge waiting">Não salvo</span>}
          <button className="btn btn-primary btn-sm" disabled={!dirty || saving || offlineFallback} onClick={() => save()}>
            <Save size={14} /> {saving ? 'Salvando…' : 'Salvar (Ctrl+S)'}
          </button>
        </div>
      </div>

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
            {STATUSES.map((col) => {
              const items = card.items.filter((i) => (i.status || 'idea') === col.id);
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
                    if (!droppedId) return;
                    const found = card.items.find((i) => i.id === droppedId);
                    if (found) changeItemStatus(found, col.id, true);
                  }}
                >
                  <div className="board-col-head">
                    <span>{col.label} ({items.length})</span>
                    <button className="btn btn-sm btn-icon" onClick={() => addItem(col.id)} title={`Adicionar em ${col.label}`} disabled={offlineFallback}>
                      <Plus size={12} />
                    </button>
                  </div>
                  {items.map(renderItemCard)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {card.template === 'research' && (
        <div className="research-list">
          {card.items.length === 0 ? <div className="empty">Nenhum item ainda. Clique em "Novo item" ou "Importar de docs/".</div> : card.items.map(renderItemCard)}
        </div>
      )}

      {card.template === 'gallery' && (
        <div className="gallery-grid">
          {card.items.length === 0 ? <div className="empty">Galeria vazia. Adicione itens com imagens ou prompts.</div> : card.items.map(renderItemCard)}
        </div>
      )}
    </div>
  );
}
