import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Monitor, Send, Star, X } from 'lucide-react';
import { api } from '../api';
import type { FsEntry, MachineCaps, Snapshot, WorkspaceEntity } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  defaultBinding?: { machine: string; cwd: string } | null;
  entities: WorkspaceEntity[];
  snapshot: Snapshot | null;
  initialPrompt?: string;
  onCreated: (sessionId?: string) => void;
  onNotify: (msg: string, err?: boolean) => void;
}

const AI_META: { id: string; label: string; color: string; quotaKey?: 'claude' | 'codex' | 'gemini' }[] = [
  { id: 'Claude Code', label: 'Claude Code', color: 'var(--claude)', quotaKey: 'claude' },
  { id: 'Codex', label: 'Codex', color: 'var(--codex)', quotaKey: 'codex' },
  { id: 'Gemini', label: 'Gemini (agy)', color: 'var(--gemini)', quotaKey: 'gemini' },
  { id: 'Ollama', label: 'Ollama Local', color: '#9ed6b5' },
];

function shortFolder(p: string): string {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function joinPath(base: string, child: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${child}`;
}

export function NewSessionDrawer({
  open,
  onClose,
  defaultBinding,
  entities,
  snapshot,
  initialPrompt = '',
  onCreated,
  onNotify,
}: Props) {
  const [caps, setCaps] = useState<MachineCaps[]>([]);
  const [loadingCaps, setLoadingCaps] = useState(false);
  const [machine, setMachine] = useState('');
  const [cwd, setCwd] = useState('');
  const [folderQuery, setFolderQuery] = useState('');
  const [browseBase, setBrowseBase] = useState('');
  const [browseRel, setBrowseRel] = useState('');
  const [browseDirs, setBrowseDirs] = useState<FsEntry[]>([]);
  const [tool, setTool] = useState('Claude Code');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Carrega capacidades e aplica defaults ao abrir
  useEffect(() => {
    if (!open) return;
    setPrompt(initialPrompt || '');
    setBrowseBase('');
    setBrowseRel('');
    setBrowseDirs([]);
    setFolderQuery('');
    setLoadingCaps(true);
    api.getCapabilities()
      .then((r) => {
        const list = r.machines || [];
        setCaps(list);
        const preferred = (defaultBinding?.machine && list.find((m) => m.name === defaultBinding.machine))
          || list.find((m) => m.online)
          || list[0];
        if (preferred) {
          setMachine(preferred.name);
          setCwd(defaultBinding?.cwd || preferred.pinned?.[0] || preferred.cwds?.[0] || '');
          const availTool = AI_META.find((a) => preferred.tools?.[a.id])?.id || 'Claude Code';
          setTool(availTool);
        }
      })
      .catch((e) => onNotify((e as Error).message, true))
      .finally(() => setLoadingCaps(false));
  }, [open, defaultBinding?.machine, defaultBinding?.cwd, initialPrompt, onNotify]);

  // Fecha com Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const currentMachine = useMemo(() => caps.find((m) => m.name === machine) || caps[0] || null, [caps, machine]);
  const pinnedSet = useMemo(() => new Set((currentMachine?.pinned || []).map((p) => p.toLowerCase())), [currentMachine]);

  // Lista unificada de pastas: pinadas -> projetos do Workspace na máquina -> recentes
  const folderOptions = useMemo(() => {
    const out: { path: string; tag: string; pinned: boolean }[] = [];
    const seen = new Set<string>();
    const add = (p: string, tag: string) => {
      const clean = String(p || '').trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ path: clean, tag, pinned: pinnedSet.has(key) });
    };
    for (const p of currentMachine?.pinned || []) add(p, 'Favorita');
    for (const e of entities) {
      for (const b of e.projectBindings || []) {
        if (!currentMachine || !b.machine || b.machine === currentMachine.name) {
          add(b.cwd, e.group ? `${e.group} · ${e.title}` : e.title);
        }
      }
    }
    for (const p of currentMachine?.cwds || []) add(p, 'Recente');
    const q = folderQuery.trim().toLowerCase();
    return q ? out.filter((f) => `${f.path} ${f.tag}`.toLowerCase().includes(q)) : out;
  }, [currentMachine, entities, pinnedSet, folderQuery]);

  // Modelos disponíveis para a IA selecionada na máquina atual
  const models = useMemo(() => currentMachine?.tools?.[tool]?.models || [], [currentMachine, tool]);
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === model)) setModel(models[0].id);
    if (!models.length) setModel('');
  }, [models, model]);

  async function exploreFolder(base: string, rel = '') {
    setBrowseBase(base);
    setBrowseRel(rel);
    setCwd(rel ? joinPath(base, rel.replace(/\//g, base.includes('\\') ? '\\' : '/')) : base);
    try {
      const r = await api.listFiles(base, rel, currentMachine?.name);
      setBrowseDirs((r.entries || []).filter((e) => e.type === 'dir'));
    } catch (e) {
      setBrowseDirs([]);
      onNotify((e as Error).message, true);
    }
  }

  async function togglePin(path: string, currentlyPinned: boolean) {
    try {
      const r = await api.pinProject({ machine: currentMachine?.name, cwd: path, pinned: !currentlyPinned });
      setCaps((prev) => prev.map((m) => (m.name === currentMachine?.name ? { ...m, pinned: r.pinned } : m)));
      onNotify(!currentlyPinned ? 'Pasta fixada nos favoritos.' : 'Pasta removida dos favoritos.');
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  async function launch() {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || submitting) return;
    setSubmitting(true);
    try {
      const r = await api.newSession({
        machine: currentMachine?.name || undefined,
        tool,
        model: model || undefined,
        cwd: cwd.trim() || undefined,
        prompt: cleanPrompt,
      });
      onNotify(`Sessão ${r.tool} iniciada${r.machine ? ` em ${r.machine}` : ''}!`);
      onCreated(r.id);
      onClose();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="left-drawer-bg" onClick={onClose}>
      <aside className="left-drawer" onClick={(e) => e.stopPropagation()} aria-label="Nova conversa com IA">
        <div className="left-drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Nova conversa com IA</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Escolha a máquina, a pasta do projeto e o agente</div>
          </div>
          <button className="btn btn-sm btn-icon" onClick={onClose} title="Fechar (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="left-drawer-body">
          {/* 1. Máquina */}
          {caps.length > 1 && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>1. Máquina</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {caps.map((m) => (
                  <button
                    key={m.name}
                    className={`btn btn-sm ${machine === m.name ? 'btn-primary' : ''}`}
                    disabled={!m.online}
                    onClick={() => {
                      setMachine(m.name);
                      setBrowseBase('');
                      setBrowseDirs([]);
                      setCwd(m.pinned?.[0] || m.cwds?.[0] || '');
                    }}
                  >
                    <Monitor size={12} /> {m.name}{!m.online ? ' (offline)' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 2. Pasta do projeto */}
          <div className="field" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <label style={{ margin: 0 }}>2. Pasta do projeto (CWD)</label>
              {browseBase && (
                <button className="btn btn-sm" onClick={() => { setBrowseBase(''); setBrowseRel(''); setBrowseDirs([]); }}>
                  ← Voltar à lista
                </button>
              )}
            </div>

            <input
              className="inp mono"
              style={{ marginBottom: 6, fontSize: 12 }}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="Caminho completo da pasta (ex.: D:\Projetos\meu-app)…"
            />

            {!browseBase ? (
              <>
                <input
                  className="sb-search"
                  style={{ width: '100%', marginBottom: 6 }}
                  value={folderQuery}
                  onChange={(e) => setFolderQuery(e.target.value)}
                  placeholder="Filtrar pastas favoritas, projetos e recentes…"
                />
                <div className="folder-list">
                  {loadingCaps ? (
                    <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>Carregando pastas…</div>
                  ) : folderOptions.length === 0 ? (
                    <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>Nenhuma pasta encontrada. Digite o caminho acima.</div>
                  ) : (
                    folderOptions.map((f) => {
                      const isSel = cwd.toLowerCase() === f.path.toLowerCase();
                      return (
                        <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <button
                            className={`folder-row ${isSel ? 'active' : ''}`}
                            style={{ flex: 1, minWidth: 0 }}
                            onClick={() => setCwd(f.path)}
                            title={f.path}
                          >
                            {isSel ? <FolderOpen size={14} color="var(--accent)" style={{ flexShrink: 0 }} /> : <Folder size={14} color="var(--muted)" style={{ flexShrink: 0 }} />}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div className="ell">{shortFolder(f.path)}</div>
                              <div className="ell mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{f.path}</div>
                            </div>
                            <span className="badge" style={{ fontSize: 10 }}>{f.tag}</span>
                          </button>
                          <button
                            className="btn btn-sm btn-icon"
                            style={{ border: 0, background: 'transparent' }}
                            title={f.pinned ? 'Remover dos favoritos' : 'Fixar pasta nos favoritos'}
                            onClick={() => togglePin(f.path, f.pinned)}
                          >
                            <Star size={12} fill={f.pinned ? '#e5c063' : 'none'} color={f.pinned ? '#e5c063' : 'var(--muted)'} />
                          </button>
                          <button
                            className="btn btn-sm btn-icon"
                            style={{ border: 0, background: 'transparent' }}
                            title="Explorar subpastas"
                            onClick={() => exploreFolder(f.path, '')}
                          >
                            <ChevronRight size={13} color="var(--muted)" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <div className="folder-list">
                <div style={{ padding: '4px 8px 6px', fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="mono ell" style={{ flex: 1 }}>{browseBase}{browseRel ? `/${browseRel}` : ''}</span>
                  {browseRel && (
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const parent = browseRel.split('/').slice(0, -1).join('/');
                        exploreFolder(browseBase, parent);
                      }}
                    >
                      ↑ Subir
                    </button>
                  )}
                </div>
                {browseDirs.length === 0 ? (
                  <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>Sem subpastas aqui — esta pasta já está selecionada.</div>
                ) : (
                  browseDirs.map((d) => (
                    <button
                      key={d.path}
                      className="folder-row"
                      onClick={() => exploreFolder(browseBase, d.path)}
                    >
                      <Folder size={14} color="var(--warn)" style={{ flexShrink: 0 }} />
                      <span className="ell">{d.name}</span>
                      <ChevronRight size={13} color="var(--muted)" style={{ marginLeft: 'auto' }} />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 3. Tipo de IA */}
          <div className="field" style={{ marginBottom: 0 }}>
            <label>3. Inteligência Artificial</label>
            <div className="ai-grid">
              {AI_META.map((ai) => {
                const avail = !currentMachine || !!currentMachine.tools?.[ai.id];
                const q = ai.quotaKey ? snapshot?.quotas?.[ai.quotaKey] : undefined;
                const w5 = q?.windows?.five_hour || q?.windows?.pro;
                const w7 = q?.windows?.seven_day || q?.windows?.daily;
                return (
                  <button
                    key={ai.id}
                    className={`ai-tile ${tool === ai.id ? 'active' : ''}`}
                    disabled={!avail}
                    onClick={() => setTool(ai.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span className="qdot" style={{ background: ai.color }} />
                      <strong style={{ fontSize: 13 }}>{ai.label}</strong>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {!avail
                        ? 'Indisponível nesta máquina'
                        : w5 && typeof w5.used === 'number'
                          ? <><b>{Math.round(w5.used)}%</b>{w7 && typeof w7.used === 'number' ? ` • ${Math.round(w7.used)}%` : ''}</>
                          : 'Pronta para uso'}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Modelo */}
          {models.length > 0 && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>4. Modelo</label>
              <select className="sel" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          )}

          {/* 5. Prompt inicial */}
          <div className="field" style={{ marginBottom: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <label>5. Mensagem inicial</label>
            <textarea
              className="ta"
              rows={5}
              style={{ flex: 1, minHeight: 100 }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') launch(); }}
              placeholder="Descreva o objetivo da conversa (Ctrl+Enter para iniciar)…"
              autoFocus
            />
          </div>
        </div>

        <div className="left-drawer-foot">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={submitting || !prompt.trim()}
            onClick={launch}
          >
            <Send size={14} /> {submitting ? 'Iniciando sessão…' : `Iniciar com ${tool}`}
          </button>
        </div>
      </aside>
    </div>
  );
}
