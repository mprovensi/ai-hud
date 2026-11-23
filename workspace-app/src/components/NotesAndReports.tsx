import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Save } from 'lucide-react';
import { api } from '../api';
import type { ConflictError } from '../types';

interface Props {
  mode: 'entity' | 'global';
  entityId?: string;
  filePath?: string;
  viewer?: 'markdown' | 'html';
  area?: string;
  docName?: string;
  onNotify: (msg: string, err?: boolean) => void;
}

export function NotesAndReports({ mode, entityId, filePath, viewer = 'markdown', area, docName, onNotify }: Props) {
  const [content, setContent] = useState('');
  const [baseHash, setBaseHash] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState<{ currentContent: string; currentHash: string } | null>(null);

  const readOnly = mode === 'global' && area === 'handoffs';

  useEffect(() => {
    if (viewer === 'html') {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setConflict(null);
    setDirty(false);
    (async () => {
      try {
        const res = mode === 'entity'
          ? await api.getEntityFile<string>(entityId!, filePath!)
          : await api.getGlobalDoc(area!, docName!);
        if (!cancelled) {
          setContent(typeof res.content === 'string' ? res.content : '');
          setBaseHash(res.hash);
        }
      } catch (e) {
        if (!cancelled) onNotify((e as Error).message, true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, entityId, filePath, viewer, area, docName]);

  async function save() {
    if (readOnly || saving || !dirty) return;
    setSaving(true);
    try {
      const res = mode === 'entity'
        ? await api.saveEntityFile({ id: entityId!, path: filePath!, content, baseHash })
        : await api.saveGlobalDoc({ area: area!, name: docName!, content, baseHash });
      setBaseHash(res.hash);
      setDirty(false);
      setConflict(null);
      onNotify('Documento salvo.');
    } catch (e) {
      const ce = e as ConflictError;
      if (ce.conflict) {
        setConflict({ currentContent: String(ce.currentContent || ''), currentHash: ce.currentHash });
        onNotify('Conflito 409: documento alterado em disco.', true);
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
  }, [content, baseHash, dirty, saving, readOnly]);

  if (viewer === 'html' && entityId && filePath) {
    return (
      <div>
        <div className="toolbar">
          <span className="badge">Relatório HTML isolado (sandbox)</span>
        </div>
        <iframe
          className="report-frame"
          sandbox="allow-scripts"
          src={api.entityAssetUrl(entityId, filePath)}
          title={filePath}
        />
      </div>
    );
  }

  if (loading) return <div className="empty">Carregando documento…</div>;

  return (
    <div>
      {conflict && (
        <div className="conflict-box">
          <h4>Conflito 409 — o arquivo mudou em disco</h4>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                setContent(conflict.currentContent);
                setBaseHash(conflict.currentHash);
                setDirty(false);
                setConflict(null);
              }}
            >
              Carregar versão do disco
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                setBaseHash(conflict.currentHash);
                setConflict(null);
              }}
            >
              Manter minha edição (pronto p/ salvar)
            </button>
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="toolbar">
          <span className="badge">{mode === 'entity' ? filePath : `${area}/${docName}`}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {dirty && <span className="badge waiting">Não salvo</span>}
            <button className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={save}>
              <Save size={13} /> {saving ? 'Salvando…' : 'Salvar (Ctrl+S)'}
            </button>
          </div>
        </div>
      )}

      {readOnly ? (
        <div className="split-pane md" style={{ minHeight: 420 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <div className="split">
          <div className="split-pane">
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              placeholder="Escreva em Markdown…"
            />
          </div>
          <div className="split-pane md" style={{ overflowY: 'auto', maxHeight: '68vh' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '*Prévia vazia*'}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
