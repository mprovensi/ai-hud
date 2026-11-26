import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  CheckCircle2,
  Download,
  FilePlus2,
  FileText,
  Play,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { api } from '../api';
import type { ConflictError, GoldfishEstimate, GoldfishReviewResult, ProjectDocEntry } from '../types';

interface Props {
  entityId: string;
  initialDocPath?: string;
  onNotify: (msg: string, err?: boolean) => void;
  onSendPrompt: (prompt: string) => void;
  onBoardChanged?: () => void;
}

const CAT_META: { id: ProjectDocEntry['category']; label: string }[] = [
  { id: 'plan', label: '🗺️ Planos & Roadmaps' },
  { id: 'spec', label: '📐 Specs & Designs' },
  { id: 'doc', label: '📄 Documentação' },
  { id: 'review', label: '🐟 Revisões Goldfish' },
];

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function ProjectDocsPane({ entityId, initialDocPath = '', onNotify, onSendPrompt, onBoardChanged }: Props) {
  const [docs, setDocs] = useState<ProjectDocEntry[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState('');

  const [content, setContent] = useState('');
  const [baseHash, setBaseHash] = useState('');
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentContent: string; currentHash: string } | null>(null);
  const editRevRef = useRef(0);
  const docKeyRef = useRef('');
  docKeyRef.current = `${entityId}:${selectedPath}`;

  // Nova Spec (EGM Lite)
  const [newSpecOpen, setNewSpecOpen] = useState(false);
  const [newSpecTitle, setNewSpecTitle] = useState('');
  const [newSpecSummary, setNewSpecSummary] = useState('');
  const [creatingSpec, setCreatingSpec] = useState(false);

  // Revisão Goldfish (estimativa prévia -> confirmação)
  const [estimate, setEstimate] = useState<GoldfishEstimate | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [lastReview, setLastReview] = useState<GoldfishReviewResult | null>(null);

  // Importar 0 tokens para o Quadro
  const [importing, setImporting] = useState(false);

  async function loadList(selectAfter?: string) {
    setLoadingList(true);
    try {
      const r = await api.listProjectDocs(entityId);
      const list = r.docs || [];
      setDocs(list);
      const target = (selectAfter || initialDocPath || '').split('#')[0];
      if (target && list.some((d) => d.path === target)) {
        setSelectedPath(target);
      } else if (!selectedPath || !list.some((d) => d.path === selectedPath)) {
        setSelectedPath(list[0]?.path || '');
      }
    } catch (e) {
      onNotify((e as Error).message, true);
      setDocs([]);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    setSelectedPath('');
    setEstimate(null);
    setLastReview(null);
    setEditing(false);
    loadList(initialDocPath);
  }, [entityId]);

  useEffect(() => {
    const clean = (initialDocPath || '').split('#')[0];
    if (clean && clean !== selectedPath && docs.some((d) => d.path === clean)) {
      setSelectedPath(clean);
    }
  }, [initialDocPath, docs]);

  useEffect(() => {
    if (!selectedPath) {
      setContent('');
      setBaseHash('');
      return;
    }
    let alive = true;
    editRevRef.current += 1;
    setLoadingDoc(true);
    setConflict(null);
    setDirty(false);
    setEditing(false);
    setEstimate(null);
    setLastReview(null);
    api.getProjectDoc(entityId, selectedPath)
      .then((r) => {
        if (!alive) return;
        setContent(r.content || '');
        setBaseHash(r.hash);
      })
      .catch((e) => { if (alive) onNotify((e as Error).message, true); })
      .finally(() => { if (alive) setLoadingDoc(false); });
    return () => { alive = false; };
  }, [entityId, selectedPath]);

  async function saveDoc() {
    if (!selectedPath || saving || !dirty) return;
    const sentKey = docKeyRef.current;
    const sentRev = editRevRef.current;
    const sentPath = selectedPath;
    const sentContent = content;
    const sentBaseHash = baseHash;
    setSaving(true);
    try {
      const r = await api.saveProjectDoc({ entityId, path: sentPath, content: sentContent, baseHash: sentBaseHash });
      if (docKeyRef.current !== sentKey) return;
      setBaseHash(r.hash);
      setConflict(null);
      if (editRevRef.current === sentRev) {
        setDirty(false);
        onNotify(`Salvo: ${sentPath}`);
      } else {
        onNotify(`Salvo: ${sentPath} (alterações mais recentes continuam pendentes).`);
      }
      loadList(sentPath);
    } catch (e) {
      if (docKeyRef.current !== sentKey) return;
      const ce = e as ConflictError;
      if (ce.conflict) {
        setConflict({ currentContent: String(ce.currentContent || ''), currentHash: ce.currentHash });
        onNotify('Conflito 409: o arquivo mudou em disco.', true);
      } else {
        onNotify(ce.message, true);
      }
    } finally {
      if (docKeyRef.current === sentKey) setSaving(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && editing && dirty) {
        e.preventDefault();
        saveDoc();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, dirty, content, baseHash, selectedPath, saving]);

  async function handleCreateSpec() {
    const title = newSpecTitle.trim();
    if (!title || creatingSpec) return;
    setCreatingSpec(true);
    try {
      const r = await api.createProjectSpec({ entityId, title, summary: newSpecSummary.trim() });
      setNewSpecOpen(false);
      setNewSpecTitle('');
      setNewSpecSummary('');
      onNotify(`Spec criada em ${r.path}`);
      await loadList(r.path);
      setSelectedPath(r.path);
      setEditing(true);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setCreatingSpec(false);
    }
  }

  async function handleImportThisDoc() {
    if (!selectedPath || importing) return;
    setImporting(true);
    try {
      const r = await api.importProjectDocs({ entityId, paths: [selectedPath], dryRun: false });
      onNotify(
        r.addedCount && r.addedCount > 0
          ? `${r.addedCount} item(ns) importado(s) para o Quadro (0 tokens).`
          : 'Todos os itens deste documento já estão no Quadro (0 tokens).',
      );
      onBoardChanged?.();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setImporting(false);
    }
  }

  async function requestGoldfishEstimate() {
    if (!selectedPath || reviewing) return;
    setReviewing(true);
    setLastReview(null);
    try {
      const r = await api.reviewProjectSpec({ entityId, docPath: selectedPath, dryRun: true });
      if ('dryRun' in r && r.dryRun) {
        setEstimate(r);
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setReviewing(false);
    }
  }

  async function runGoldfishReview() {
    if (!selectedPath || reviewing) return;
    setReviewing(true);
    try {
      const r = await api.reviewProjectSpec({ entityId, docPath: selectedPath, dryRun: false });
      if (!('dryRun' in r)) {
        setEstimate(null);
        setLastReview(r);
        const tok = r.usage ? ` · ${fmtTok(r.usage.totalTokens)} tok${r.usage.estimated ? ' est.' : ''}` : '';
        onNotify(`Revisão Goldfish (${r.engine}${tok}): ${r.verdict === 'approved' ? 'Aprovada' : 'Ajustes sugeridos'}`);
        loadList(selectedPath);
        onBoardChanged?.();
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setReviewing(false);
    }
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? docs.filter((d) => `${d.title} ${d.path}`.toLowerCase().includes(q))
      : docs;
    return CAT_META
      .map((cat) => ({ ...cat, items: filtered.filter((d) => d.category === cat.id) }))
      .filter((g) => g.items.length > 0);
  }, [docs, query]);

  const activeDoc = docs.find((d) => d.path === selectedPath) || null;

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-primary btn-sm" onClick={() => setNewSpecOpen((v) => !v)}>
          <FilePlus2 size={14} /> Nova Spec (EGM)
        </button>
        <button className="btn btn-sm" onClick={() => loadList(selectedPath)} disabled={loadingList} title="Reescanear docs/ do projeto (0 tokens)">
          <RefreshCw size={13} /> Atualizar lista
        </button>
        <span className="badge">{docs.length} documento(s) no projeto</span>

        {selectedPath && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm"
              onClick={handleImportThisDoc}
              disabled={importing}
              title="Extrair checkboxes e seções deste documento para o Quadro sem gastar tokens"
            >
              <Download size={13} /> {importing ? 'Importando…' : 'Enviar p/ Quadro (0 tok)'}
            </button>
            <button
              className="btn btn-sm"
              onClick={requestGoldfishEstimate}
              disabled={reviewing}
              title="Revisão independente (contexto zero) — mostra estimativa de tokens antes de rodar"
            >
              <Sparkles size={13} /> {reviewing ? 'Calculando…' : '🐟 Revisar Spec'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => onSendPrompt(`Leia o documento \`${selectedPath}\` do projeto e vamos trabalhar nos itens definidos nele.`)}
              title="Enviar referência deste documento para a conversa com IA"
            >
              <Play size={13} /> Usar na IA
            </button>
            {editing ? (
              <>
                <button className="btn btn-sm" onClick={() => { setEditing(false); setDirty(false); }}>Cancelar</button>
                <button className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={saveDoc}>
                  <Save size={13} /> {saving ? 'Salvando…' : 'Salvar'}
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setEditing(true)}>Editar</button>
            )}
          </div>
        )}
      </div>

      {newSpecOpen && (
        <div className="docs-banner">
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            📐 Nova Especificação enxuta (<span className="mono">docs/specs/&lt;nome&gt;.md</span>)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              className="inp"
              autoFocus
              value={newSpecTitle}
              onChange={(e) => setNewSpecTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSpec(); }}
              placeholder="Título da feature ou melhoria (ex.: Refatoração de autenticação)…"
            />
            <input
              className="inp"
              value={newSpecSummary}
              onChange={(e) => setNewSpecSummary(e.target.value)}
              placeholder="Objetivo em 1 frase (opcional)…"
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm btn-primary" disabled={creatingSpec || !newSpecTitle.trim()} onClick={handleCreateSpec}>
                {creatingSpec ? 'Criando…' : 'Criar Spec (0 tokens)'}
              </button>
              <button className="btn btn-sm" onClick={() => setNewSpecOpen(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {estimate && (
        <div className="goldfish-box">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ fontSize: 13 }}>🐟 Revisão Goldfish (1 chamada isolada, contexto zero)</strong>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                {estimate.available ? (
                  <>
                    Motor: <b style={{ color: 'var(--text)' }}>{estimate.engine}{estimate.model ? `/${estimate.model}` : ''}</b> ·
                    Estimativa: <b style={{ color: 'var(--text)' }}>~{fmtTok(estimate.estimatedTotalTokens)} tokens</b>
                    {' '}(in ~{fmtTok(estimate.estimatedInputTokens)} / out ~{fmtTok(estimate.estimatedOutputTokens)})
                    {estimate.engine === 'Ollama' ? ' · 0 de cota!' : ''}
                  </>
                ) : (
                  <span style={{ color: 'var(--warn)' }}>Nenhum motor disponível: {estimate.reason}</span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" onClick={() => setEstimate(null)}>Cancelar</button>
              <button
                className="btn btn-sm btn-primary"
                disabled={!estimate.available || reviewing}
                onClick={runGoldfishReview}
              >
                {reviewing ? 'Revisando…' : 'Confirmar revisão'}
              </button>
            </div>
          </div>
        </div>
      )}

      {lastReview && (
        <div className="goldfish-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            {lastReview.verdict === 'approved'
              ? <CheckCircle2 size={15} color="var(--ok)" />
              : <ShieldAlert size={15} color="var(--warn)" />}
            <strong style={{ fontSize: 13 }}>
              {lastReview.verdict === 'approved' ? 'Spec Aprovada pelo Goldfish' : 'Goldfish sugeriu ajustes'}
            </strong>
            <span className="badge">{lastReview.engine}{lastReview.model ? `/${lastReview.model}` : ''}</span>
            {lastReview.usage && (
              <span className="badge">
                {fmtTok(lastReview.usage.totalTokens)} tok ({lastReview.usage.estimated ? 'est.' : 'real'})
              </span>
            )}
            {lastReview.reportPath && (
              <button className="doc-chip" onClick={() => setSelectedPath(lastReview.reportPath!)}>
                Abrir parecer ({lastReview.reportPath})
              </button>
            )}
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setLastReview(null)}>Fechar</button>
          </div>
          <div style={{ fontSize: 12.5, marginBottom: 6 }}>{lastReview.summary}</div>
          {lastReview.gaps.length > 0 && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              <b>Lacunas:</b> {lastReview.gaps.join(' · ')}
            </div>
          )}
          {lastReview.risks.length > 0 && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              <b>Riscos:</b> {lastReview.risks.join(' · ')}
            </div>
          )}
          {lastReview.cuts.length > 0 && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              <b>Simplificações:</b> {lastReview.cuts.join(' · ')}
            </div>
          )}
        </div>
      )}

      {conflict && (
        <div className="conflict-box">
          <h4>Conflito 409 — o documento mudou em disco</h4>
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
              Recarregar do disco
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setBaseHash(conflict.currentHash);
                setConflict(null);
                onNotify('Clique em Salvar novamente para sobrescrever.');
              }}
            >
              Manter minha versão
            </button>
          </div>
        </div>
      )}

      <div className="docs-grid">
        <aside className="docs-list-pane">
          <input
            className="inp"
            style={{ width: '100%', height: 34, padding: '6px 10px', fontSize: 12.5, flex: '0 0 auto' }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar planos, specs e docs…"
          />
          {loadingList ? (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>Escaneando docs/ do projeto…</div>
          ) : grouped.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              Nenhum documento Markdown encontrado em <code className="mono">docs/</code> ou na raiz.
              Clique em <b>Nova Spec (EGM)</b> para criar o primeiro plano.
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.id}>
                <div className="docs-cat-head">{g.label}</div>
                {g.items.map((d) => (
                  <button
                    key={d.path}
                    className={`docs-row ${selectedPath === d.path ? 'active' : ''}`}
                    onClick={() => setSelectedPath(d.path)}
                    title={d.path}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                      <FileText size={13} color={selectedPath === d.path ? 'var(--accent)' : 'var(--muted)'} style={{ flexShrink: 0 }} />
                      <span className="ell" style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{d.title}</span>
                      {d.taskCount > 0 && (
                        <span className="badge" style={{ fontSize: 10, padding: '1px 6px' }}>
                          {d.doneCount}/{d.taskCount}
                        </span>
                      )}
                    </div>
                    <div className="mono ell" style={{ fontSize: 10.5, color: 'var(--muted)', paddingLeft: 19 }}>
                      {d.path}
                    </div>
                  </button>
                ))}
              </div>
            ))
          )}
        </aside>

        <section style={{ minWidth: 0 }}>
          {!selectedPath ? (
            <div className="split-pane empty" style={{ minHeight: 360 }}>
              Selecione um documento à esquerda ou crie uma nova Spec (EGM).
            </div>
          ) : loadingDoc ? (
            <div className="split-pane empty" style={{ minHeight: 360 }}>
              Carregando {selectedPath}…
            </div>
          ) : editing ? (
            <div className="split">
              <div className="split-pane">
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{selectedPath}</div>
                <textarea
                  value={content}
                  onChange={(e) => { editRevRef.current += 1; setContent(e.target.value); setDirty(true); }}
                  placeholder="Escreva em Markdown…"
                />
              </div>
              <div className="split-pane md" style={{ overflowY: 'auto' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '*Vazio*'}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="split-pane md" style={{ minHeight: 420 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--accent)' }}>{selectedPath}</span>
                {activeDoc && activeDoc.taskCount > 0 && (
                  <span className="badge">{activeDoc.doneCount}/{activeDoc.taskCount} tarefas</span>
                )}
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '*Documento vazio.*'}</ReactMarkdown>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
