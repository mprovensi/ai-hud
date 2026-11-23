import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown,
  ArrowUp,
  ImagePlus,
  LayoutGrid,
  List,
  Play,
  Plus,
  Save,
  Trash2,
  Columns3,
  ExternalLink,
} from 'lucide-react';
import { api } from '../api';
import type { CardDoc, CardItem, CardStatus, CardTemplate, ConflictError } from '../types';

const STATUSES: { id: CardStatus; label: string }[] = [
  { id: 'idea', label: 'Ideia' },
  { id: 'in-progress', label: 'Em andamento' },
  { id: 'review', label: 'Revisão' },
  { id: 'done', label: 'Concluído' },
];

interface Props {
  entityId: string;
  filePath: string;
  onNotify: (msg: string, err?: boolean) => void;
  onSendPrompt: (prompt: string) => void;
}

export function CardEditor({ entityId, filePath, onNotify, onSendPrompt }: Props) {
  const draftKey = `aiws.draft.${entityId}.${filePath}`;
  const [card, setCard] = useState<CardDoc | null>(null);
  const [baseHash, setBaseHash] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentContent: CardDoc; currentHash: string } | null>(null);

  async function load() {
    setConflict(null);
    try {
      const r = await api.getEntityFile<CardDoc>(entityId, filePath);
      const savedDraft = sessionStorage.getItem(draftKey);
      if (savedDraft) {
        try {
          setCard(JSON.parse(savedDraft));
          setDirty(true);
        } catch {
          setCard(r.content);
          setDirty(false);
        }
      } else {
        setCard(r.content);
        setDirty(false);
      }
      setBaseHash(r.hash);
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  useEffect(() => {
    setEditingId(null);
    load();
  }, [entityId, filePath]);

  function updateCard(next: CardDoc) {
    setCard(next);
    setDirty(true);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {}
  }

  async function save() {
    if (!card || saving) return;
    setSaving(true);
    try {
      const r = await api.saveEntityFile({ id: entityId, path: filePath, content: card, baseHash });
      setBaseHash(r.hash);
      setDirty(false);
      setConflict(null);
      sessionStorage.removeItem(draftKey);
      onNotify('Card salvo.');
    } catch (e) {
      const ce = e as ConflictError;
      if (ce.conflict && ce.currentContent) {
        setConflict({ currentContent: ce.currentContent as CardDoc, currentHash: ce.currentHash });
        onNotify('Conflito detectado: o arquivo foi alterado em disco.', true);
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
  }, [card, baseHash, saving]);

  if (!card) return <div className="empty">Carregando card…</div>;

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

  function removeItem(id: string) {
    if (!card) return;
    updateCard({ ...card, items: card.items.filter((it) => it.id !== id) });
    if (editingId === id) setEditingId(null);
  }

  function moveItem(id: string, dir: -1 | 1) {
    if (!card) return;
    const idx = card.items.findIndex((x) => x.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= card.items.length) return;
    const copy = card.items.slice();
    const [m] = copy.splice(idx, 1);
    copy.splice(to, 0, m);
    updateCard({ ...card, items: copy });
  }

  async function uploadImage(id: string, file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api.uploadEntityMedia({
          id: entityId,
          fileName: file.name,
          base64Data: String(reader.result || ''),
        });
        patchItem(id, { image: res.path, alt: file.name });
        onNotify('Imagem enviada — clique em Salvar para fixar no card.');
      } catch (e) {
        onNotify((e as Error).message, true);
      }
    };
    reader.readAsDataURL(file);
  }

  function renderItemCard(it: CardItem) {
    const editing = editingId === it.id;
    return (
      <div className="card-item" key={it.id}>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <input
              className="inp"
              value={it.title}
              onChange={(e) => patchItem(it.id, { title: e.target.value })}
              placeholder="Título do item"
            />
            <textarea
              className="ta"
              rows={3}
              value={it.body || ''}
              onChange={(e) => patchItem(it.id, { body: e.target.value })}
              placeholder="Notas em Markdown…"
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                className="sel"
                value={it.status || 'idea'}
                onChange={(e) => patchItem(it.id, { status: e.target.value as CardStatus })}
              >
                {STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <label className="btn btn-sm" title="Enviar imagem">
                <ImagePlus size={14} /> Imagem
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadImage(it.id, f);
                  }}
                />
              </label>
            </div>
            <input
              className="inp"
              value={it.prompt || ''}
              onChange={(e) => patchItem(it.id, { prompt: e.target.value })}
              placeholder="Prompt salvo para enviar a uma IA (opcional)…"
            />
            <input
              className="inp"
              value={it.url || ''}
              onChange={(e) => patchItem(it.id, { url: e.target.value })}
              placeholder="URL de referência https://… (opcional)"
            />
            <div className="card-actions">
              <button className="btn btn-sm btn-primary" onClick={() => setEditingId(null)}>Concluir edição</button>
              <button className="btn btn-sm btn-danger" onClick={() => removeItem(it.id)}>
                <Trash2 size={13} /> Remover
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <h4 style={{ flex: 1, cursor: 'pointer' }} onClick={() => setEditingId(it.id)}>{it.title}</h4>
              {it.status && card?.template !== 'board' && (
                <span className={`badge ${it.status}`}>
                  {STATUSES.find((s) => s.id === it.status)?.label || it.status}
                </span>
              )}
            </div>
            {it.image && <img src={api.entityAssetUrl(entityId, it.image)} alt={it.alt || it.title} />}
            {it.body && (
              <div className="md" style={{ fontSize: 12.5 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.body}</ReactMarkdown>
              </div>
            )}
            {it.url && (
              <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <ExternalLink size={12} /> {it.linkLabel || it.url}
              </a>
            )}
            <div className="card-actions">
              <button className="btn btn-sm" onClick={() => setEditingId(it.id)}>Editar</button>
              {(it.prompt || it.body) && (
                <button
                  className="btn btn-sm"
                  title="Enviar este item para iniciar uma sessão de IA"
                  onClick={() => onSendPrompt(it.prompt || `${it.title}\n\n${it.body || ''}`)}
                >
                  <Play size={12} /> Enviar p/ IA
                </button>
              )}
              {card?.template === 'board' && (
                <select
                  className="sel"
                  style={{ width: 'auto', padding: '2px 6px', fontSize: 11.5 }}
                  value={it.status || 'idea'}
                  onChange={(e) => patchItem(it.id, { status: e.target.value as CardStatus })}
                >
                  {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              )}
              <button className="btn btn-sm btn-icon" title="Subir" onClick={() => moveItem(it.id, -1)}><ArrowUp size={12} /></button>
              <button className="btn btn-sm btn-icon" title="Descer" onClick={() => moveItem(it.id, 1)}><ArrowDown size={12} /></button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      {conflict && (
        <div className="conflict-box">
          <h4>Conflito de edição (409) — um agente ou outra janela alterou este card</h4>
          <p style={{ margin: '0 0 8px', fontSize: 12.5 }}>
            Seu rascunho continua preservado. Você pode recarregar a versão mais recente do disco ou salvar por cima explicitamente.
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
                onNotify('Versão mais recente carregada.');
              }}
            >
              Descartar rascunho e carregar do disco
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                setBaseHash(conflict.currentHash);
                setConflict(null);
                onNotify('Hash atualizado — clique em Salvar novamente para confirmar.');
              }}
            >
              Manter meu rascunho (pronto para salvar)
            </button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Visualização">
          {([
            ['board', 'Board', Columns3],
            ['research', 'Research', List],
            ['gallery', 'Gallery', LayoutGrid],
          ] as [CardTemplate, string, typeof Columns3][]).map(([tpl, label, Icon]) => (
            <button
              key={tpl}
              className={card.template === tpl ? 'on' : ''}
              onClick={() => updateCard({ ...card, template: tpl })}
            >
              <Icon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              {label}
            </button>
          ))}
        </div>

        <button className="btn btn-sm" onClick={() => addItem('idea')}>
          <Plus size={14} /> Novo item
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {dirty && <span className="badge waiting">Alterações não salvas</span>}
          <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
            <Save size={14} /> {saving ? 'Salvando…' : 'Salvar (Ctrl+S)'}
          </button>
        </div>
      </div>

      {card.template === 'board' ? (
        <div className="board-grid">
          {STATUSES.map((col) => {
            const items = card.items.filter((x) => (x.status || 'idea') === col.id);
            return (
              <div className="board-col" key={col.id}>
                <div className="board-col-head">
                  <span>{col.label} ({items.length})</span>
                  <button className="btn btn-sm btn-icon" onClick={() => addItem(col.id)} title={`Adicionar em ${col.label}`}>
                    <Plus size={12} />
                  </button>
                </div>
                {items.map(renderItemCard)}
              </div>
            );
          })}
        </div>
      ) : card.template === 'gallery' ? (
        <div className="gallery-grid">{card.items.map(renderItemCard)}</div>
      ) : (
        <div className="research-list">{card.items.map(renderItemCard)}</div>
      )}
    </div>
  );
}
