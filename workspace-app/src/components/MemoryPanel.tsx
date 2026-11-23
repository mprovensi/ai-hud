import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link2, Moon, Pin, RotateCcw, Save } from 'lucide-react';
import { api } from '../api';
import type { ConflictError, MemoryData } from '../types';

const MEM_TABS = [
  { file: 'MEMORY.md', label: 'MEMORY.md' },
  { file: 'pinned.md', label: '📌 pinned.md' },
  { file: 'current-state.md', label: 'Estado atual' },
  { file: 'decisions.md', label: 'Decisões' },
  { file: 'pitfalls.md', label: 'Armadilhas' },
  { file: 'dream-log.md', label: 'Log Dreaming' },
];

interface Props {
  project: string;
  cwd?: string;
  onNotify: (msg: string, err?: boolean) => void;
}

export function MemoryPanel({ project, cwd, onNotify }: Props) {
  const [mem, setMem] = useState<MemoryData | null>(null);
  const [tab, setTab] = useState('MEMORY.md');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [dreaming, setDreaming] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const data = await api.getMemory(project, cwd);
      setMem(data);
      setDraft(data.files[tab] || '');
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  useEffect(() => {
    setEditing(false);
    load();
  }, [project, cwd]);

  useEffect(() => {
    if (mem) setDraft(mem.files[tab] || '');
  }, [tab]);

  async function handleSave() {
    if (!mem || tab === 'dream-log.md') return;
    setSaving(true);
    try {
      await api.saveMemoryFile({
        project,
        cwd,
        mode: mem.mode,
        file: tab,
        content: draft,
        baseHash: mem.hashes[tab] || '',
      });
      setEditing(false);
      onNotify(`${tab} salvo.`);
      await load();
    } catch (e) {
      const ce = e as ConflictError;
      onNotify(ce.conflict ? 'Conflito 409: memória atualizada em paralelo. Recarregue antes de salvar.' : ce.message, true);
    } finally {
      setSaving(false);
    }
  }

  async function handleDream(force = false) {
    setDreaming(true);
    try {
      const r = await api.runDream({ project, cwd, force, ignoreQuota: true });
      if (r.skipped) {
        onNotify(r.reason || 'Nenhuma sessão nova para consolidar.');
      } else {
        onNotify(`Dreaming concluído (${r.engine}): ${r.summary || 'OK'}`);
      }
      await load();
    } catch (e) {
      onNotify(`Dreaming falhou: ${(e as Error).message}`, true);
    } finally {
      setDreaming(false);
    }
  }

  async function handleUndo() {
    if (!window.confirm('Restaurar a memória para o estado imediatamente anterior ao último Dreaming?')) return;
    try {
      const r = await api.undoDream({ project, cwd });
      onNotify(`Backup ${r.backup} restaurado (${r.restored} arquivos).`);
      await load();
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  async function handleBridges() {
    if (!cwd) return onNotify('Vincule uma pasta local ao projeto para instalar pontes.', true);
    try {
      const r = await api.installBridges({ project, cwd, mode: 'in-repo' });
      onNotify(`Pontes atualizadas: ${r.updated.join(', ')}`);
      await load();
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  if (!mem) return <div className="empty">Carregando memória compartilhada…</div>;

  const isLog = tab === 'dream-log.md';

  return (
    <div>
      <div className="toolbar">
        <span className={`badge ${mem.pendingCount > 0 ? 'waiting' : 'done'}`}>
          {mem.pendingCount > 0 ? `${mem.pendingCount} sessão(ões) pendente(s)` : 'Tudo consolidado'}
        </span>
        <span className="badge">Modo: {mem.mode}</span>
        {mem.lastDreamAt > 0 && (
          <span className="badge">
            Último Dream: {new Date(mem.lastDreamAt).toLocaleString('pt-BR')} {mem.lastEngine ? `(${mem.lastEngine})` : ''}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" disabled={dreaming} onClick={() => handleDream(false)}>
            <Moon size={14} /> {dreaming ? 'Consolidando…' : 'Consolidar (Dream)'}
          </button>
          <button className="btn btn-sm" disabled={dreaming} onClick={() => handleDream(true)} title="Reprocessar sessões recentes mesmo já consolidadas">
            Forçar Dream
          </button>
          <button className="btn btn-sm" onClick={handleUndo} title="Restaurar backup anterior ao último Dreaming">
            <RotateCcw size={13} /> Desfazer
          </button>
          {cwd && (
            <button className="btn btn-sm" onClick={handleBridges} title="Adicionar pontes em CLAUDE.md, AGENTS.md e GEMINI.md">
              <Link2 size={13} /> Instalar pontes
            </button>
          )}
        </div>
      </div>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <div className="seg">
          {MEM_TABS.map((t) => (
            <button key={t.file} className={tab === t.file ? 'on' : ''} onClick={() => { setTab(t.file); setEditing(false); }}>
              {t.label}
            </button>
          ))}
        </div>
        {!isLog && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {editing ? (
              <>
                <button className="btn btn-sm" onClick={() => { setEditing(false); setDraft(mem.files[tab] || ''); }}>Cancelar</button>
                <button className="btn btn-sm btn-primary" disabled={saving} onClick={handleSave}>
                  <Save size={13} /> {saving ? 'Salvando…' : 'Salvar'}
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setEditing(true)}>Editar {tab}</button>
            )}
          </div>
        )}
      </div>

      {tab === 'pinned.md' && (
        <div style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Pin size={13} /> Regras fixadas aqui são imutáveis: o Dreaming lê como referência e nunca altera nem apaga.
        </div>
      )}

      {editing ? (
        <div className="split">
          <div className="split-pane">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Conteúdo de ${tab}…`} />
          </div>
          <div className="split-pane md" style={{ overflowY: 'auto' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft || '*Vazio*'}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="split-pane md" style={{ minHeight: 360 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {mem.files[tab] || `*${tab} ainda está vazio. Clique em "Consolidar (Dream)" ou em "Editar".*`}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
