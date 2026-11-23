import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Brain,
  FileText,
  FolderGit2,
  FolderKanban,
  GitFork,
  LayoutDashboard,
  Plus,
  Search,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api, withToken } from './api';
import { CardEditor } from './components/CardEditor';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { FilesAndGit } from './components/FilesAndGit';
import { LiveHudPane } from './components/LiveHudPane';
import { MemoryPanel } from './components/MemoryPanel';
import { NotesAndReports } from './components/NotesAndReports';
import type { MachineCaps, Snapshot, WorkspaceEntity, WorkspaceIndex } from './types';

type Selection =
  | { kind: 'entity'; id: string }
  | { kind: 'doc'; area: 'context' | 'knowledge' | 'skills' | 'handoffs'; name: string }
  | null;

type EntityTab = 'step' | 'memory' | 'files';

function quotaPct(q?: { windows?: Record<string, { used: number }> }): string | null {
  if (!q?.windows) return null;
  const w = q.windows.five_hour || q.windows.pro || q.windows.daily || Object.values(q.windows)[0];
  return w && typeof w.used === 'number' ? `${Math.round(w.used)}%` : null;
}

export function App() {
  const [ws, setWs] = useState<WorkspaceIndex | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [entityTab, setEntityTab] = useState<EntityTab>('step');
  const [stepIdx, setStepIdx] = useState(0);
  const [search, setSearch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');

  // Modal + Novo Projeto
  const [newModal, setNewModal] = useState(false);
  const [caps, setCaps] = useState<MachineCaps[]>([]);
  const [npTitle, setNpTitle] = useState('');
  const [npDesc, setNpDesc] = useState('');
  const [npTemplate, setNpTemplate] = useState('board');
  const [npMachine, setNpMachine] = useState('');
  const [npCwd, setNpCwd] = useState('');

  // Toast
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const loadWorkspace = useCallback(async () => {
    try {
      const idx = await api.getWorkspaceIndex();
      setWs(idx);
      setSelection((prev) => prev || (idx.entities[0] ? { kind: 'entity', id: idx.entities[0].id } : null));
    } catch (e) {
      notify((e as Error).message, true);
    }
  }, [notify]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // Long-polling do snapshot ao vivo do AI HUD
  const versionRef = useRef<string | undefined>(undefined);
  const pollNowRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let retryTimer: number | null = null;
    async function loop(immediate = false) {
      if (!alive) return;
      try {
        const s = await api.getSnapshot(immediate ? undefined : versionRef.current);
        if (!alive) return;
        setSnap(s);
        setOnline(true);
        versionRef.current = s.version;
        loop(false);
      } catch {
        if (!alive) return;
        setOnline(false);
        versionRef.current = undefined;
        retryTimer = window.setTimeout(() => loop(true), 4000);
      }
    }
    pollNowRef.current = () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      loop(true);
    };
    loop(true);
    return () => {
      alive = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);

  // Atalho global Ctrl+K para paleta de comandos
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function openNewModal() {
    setNewModal(true);
    try {
      const c = await api.getCapabilities();
      setCaps(c.machines || []);
      const first = c.machines.find((m) => m.online) || c.machines[0];
      if (first) {
        setNpMachine(first.name);
        setNpCwd(first.cwds[0] || '');
      }
    } catch {}
  }

  async function handleCreateEntity() {
    if (!npTitle.trim()) return notify('Informe o nome do projeto.', true);
    try {
      const bindings = npMachine && npCwd.trim() ? [{ machine: npMachine, cwd: npCwd.trim() }] : [];
      const r = await api.createEntity({
        title: npTitle.trim(),
        description: npDesc.trim(),
        template: npTemplate,
        projectBindings: bindings,
      });
      setNewModal(false);
      setNpTitle('');
      setNpDesc('');
      await loadWorkspace();
      setSelection({ kind: 'entity', id: r.entity.id });
      setEntityTab('step');
      setStepIdx(0);
      notify(`Projeto "${r.entity.title}" criado.`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function createGlobalDoc(area: 'context' | 'knowledge' | 'skills') {
    const raw = window.prompt(`Nome do novo arquivo em ${area}/ (ex.: regras.md):`);
    if (!raw || !raw.trim()) return;
    const name = raw.trim().endsWith('.md') ? raw.trim() : `${raw.trim()}.md`;
    try {
      await api.saveGlobalDoc({ area, name, content: `# ${name.replace(/\.md$/i, '')}\n\n` });
      await loadWorkspace();
      setSelection({ kind: 'doc', area, name });
      notify(`Criado ${area}/${name}.`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  const selectedEntity: WorkspaceEntity | null =
    selection?.kind === 'entity' && ws ? ws.entities.find((e) => e.id === selection.id) || null : null;
  const activeBinding = selectedEntity?.projectBindings?.[0] || null;
  const activeStep = selectedEntity?.steps?.[stepIdx] || selectedEntity?.steps?.[0] || null;

  const filteredEntities = useMemo(() => {
    if (!ws) return [];
    const q = search.trim().toLowerCase();
    const list = q
      ? ws.entities.filter((e) => `${e.title} ${e.description || ''} ${e.category || ''}`.toLowerCase().includes(q))
      : ws.entities;
    return list.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [ws, search]);

  const paletteActions: PaletteAction[] = useMemo(() => {
    const acts: PaletteAction[] = [
      { id: 'act-new', group: 'Ação', label: 'Criar novo projeto no Workspace', run: openNewModal },
      { id: 'act-hud', group: 'Navegação', label: 'Abrir AI HUD Clássico (/)', run: () => { window.location.href = withToken('/'); } },
    ];
    for (const e of ws?.entities || []) {
      acts.push({
        id: `ent-${e.id}`,
        group: 'Projeto',
        label: e.title,
        hint: e.projectBindings?.[0]?.cwd,
        run: () => { setSelection({ kind: 'entity', id: e.id }); setEntityTab('step'); setStepIdx(0); },
      });
      acts.push({
        id: `mem-${e.id}`,
        group: 'Memória',
        label: `Memória & Dreaming — ${e.title}`,
        run: () => { setSelection({ kind: 'entity', id: e.id }); setEntityTab('memory'); },
      });
    }
    for (const area of ['context', 'knowledge', 'skills', 'handoffs'] as const) {
      for (const f of ws?.[area] || []) {
        acts.push({
          id: `doc-${area}-${f.name}`,
          group: area,
          label: f.name,
          run: () => setSelection({ kind: 'doc', area, name: f.name }),
        });
      }
    }
    return acts;
  }, [ws]);

  const cPct = quotaPct(snap?.quotas?.claude);
  const xPct = quotaPct(snap?.quotas?.codex);
  const gPct = quotaPct(snap?.quotas?.gemini);

  return (
    <div className="ws-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          AI Workspace
        </div>
        <a className="pill-link" href={withToken('/')}>
          <LayoutDashboard size={13} /> HUD Clássico
        </a>
        <button className="cmd-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={13} /> Buscar ou ir para… <span className="kbd">Ctrl+K</span>
        </button>

        <div className="quota-strip">
          {cPct && <span className="qchip"><span className="qdot" style={{ background: 'var(--claude)' }} />Claude <b>{cPct}</b></span>}
          {xPct && <span className="qchip"><span className="qdot" style={{ background: 'var(--codex)' }} />Codex <b>{xPct}</b></span>}
          {gPct && <span className="qchip"><span className="qdot" style={{ background: 'var(--gemini)' }} />Gemini <b>{gPct}</b></span>}
          <span className={`status-pill ${online ? '' : 'off'}`}>
            {online ? <Wifi size={13} /> : <WifiOff size={13} />}
            {online ? 'ao vivo' : 'reconectando…'}
          </span>
        </div>
      </header>

      <div className="ws-body">
        {/* Left Sidebar */}
        <nav className="sidebar">
          <div className="sb-head">
            <input
              className="sb-search"
              placeholder="Filtrar projetos…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn btn-primary btn-sm btn-icon" title="Novo projeto" onClick={openNewModal}>
              <Plus size={15} />
            </button>
          </div>

          <div className="sb-scroll">
            <div className="sb-sec">
              <span>Projetos ({filteredEntities.length})</span>
            </div>
            {filteredEntities.map((e) => (
              <button
                key={e.id}
                className={`sb-item ${selection?.kind === 'entity' && selection.id === e.id ? 'active' : ''}`}
                onClick={() => { setSelection({ kind: 'entity', id: e.id }); setEntityTab('step'); setStepIdx(0); }}
              >
                <FolderKanban size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
                <span className="ell">{e.title}</span>
              </button>
            ))}
            {!filteredEntities.length && (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 8px' }}>
                Nenhum projeto ainda. Clique em <b>+</b> para criar o primeiro!
              </div>
            )}

            {([
              ['context', 'Contexto', BookOpen],
              ['knowledge', 'Conhecimento', Brain],
              ['skills', 'Skills', Sparkles],
            ] as const).map(([area, label, Icon]) => (
              <div key={area}>
                <div className="sb-sec">
                  <span>{label}</span>
                  <button className="btn btn-sm btn-icon" style={{ padding: 2 }} title={`Novo arquivo em ${area}/`} onClick={() => createGlobalDoc(area)}>
                    <Plus size={12} />
                  </button>
                </div>
                {(ws?.[area] || []).map((f) => (
                  <button
                    key={f.name}
                    className={`sb-item ${selection?.kind === 'doc' && selection.area === area && selection.name === f.name ? 'active' : ''}`}
                    onClick={() => setSelection({ kind: 'doc', area, name: f.name })}
                  >
                    <Icon size={13} color="var(--muted)" style={{ flexShrink: 0 }} />
                    <span className="ell">{f.name}</span>
                  </button>
                ))}
              </div>
            ))}

            <div className="sb-sec"><span>Handoffs ({ws?.handoffs?.length || 0})</span></div>
            {(ws?.handoffs || []).slice(0, 10).map((f) => (
              <button
                key={f.name}
                className={`sb-item ${selection?.kind === 'doc' && selection.area === 'handoffs' && selection.name === f.name ? 'active' : ''}`}
                onClick={() => setSelection({ kind: 'doc', area: 'handoffs', name: f.name })}
              >
                <GitFork size={13} color="var(--muted)" style={{ flexShrink: 0 }} />
                <span className="ell">{f.name}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Center Stage */}
        <main className="center">
          {selectedEntity ? (
            <>
              <div className="stage-head">
                <div className="stage-title-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 className="stage-title ell">{selectedEntity.title}</h1>
                    {selectedEntity.description && <p className="stage-desc ell">{selectedEntity.description}</p>}
                  </div>
                  {activeBinding && (
                    <span className="badge mono">{activeBinding.machine}: {activeBinding.cwd}</span>
                  )}
                </div>

                <div className="tabs">
                  {selectedEntity.steps.map((st, idx) => (
                    <button
                      key={st.path}
                      className={`tab ${entityTab === 'step' && stepIdx === idx ? 'active' : ''}`}
                      onClick={() => { setEntityTab('step'); setStepIdx(idx); }}
                    >
                      <FileText size={14} /> {st.name}
                    </button>
                  ))}
                  <button
                    className={`tab ${entityTab === 'memory' ? 'active' : ''}`}
                    onClick={() => setEntityTab('memory')}
                  >
                    <Brain size={14} /> Memória & Dreaming
                  </button>
                  {activeBinding && (
                    <button
                      className={`tab ${entityTab === 'files' ? 'active' : ''}`}
                      onClick={() => setEntityTab('files')}
                    >
                      <FolderGit2 size={14} /> Arquivos & Git
                    </button>
                  )}
                </div>
              </div>

              <div className="stage-content">
                {entityTab === 'step' && activeStep ? (
                  activeStep.viewer === 'card' || activeStep.path.endsWith('.card.json') ? (
                    <CardEditor
                      entityId={selectedEntity.id}
                      filePath={activeStep.path}
                      onNotify={notify}
                      onSendPrompt={(p) => setDraftPrompt(p)}
                    />
                  ) : (
                    <NotesAndReports
                      mode="entity"
                      entityId={selectedEntity.id}
                      filePath={activeStep.path}
                      viewer={activeStep.viewer === 'html' || activeStep.path.endsWith('.html') ? 'html' : 'markdown'}
                      onNotify={notify}
                    />
                  )
                ) : entityTab === 'memory' ? (
                  <MemoryPanel
                    project={selectedEntity.id}
                    cwd={activeBinding?.cwd}
                    onNotify={notify}
                  />
                ) : entityTab === 'files' && activeBinding ? (
                  <FilesAndGit
                    cwd={activeBinding.cwd}
                    machine={activeBinding.machine}
                    onNotify={notify}
                  />
                ) : null}
              </div>
            </>
          ) : selection?.kind === 'doc' ? (
            <>
              <div className="stage-head">
                <div className="stage-title-row">
                  <div>
                    <h1 className="stage-title">{selection.name}</h1>
                    <p className="stage-desc">Base global · {selection.area}/</p>
                  </div>
                </div>
              </div>
              <div className="stage-content">
                <NotesAndReports mode="global" area={selection.area} docName={selection.name} onNotify={notify} />
              </div>
            </>
          ) : (
            <div className="stage-content">
              <div className="empty" style={{ marginTop: 60 }}>
                <h2 style={{ margin: '0 0 8px', color: 'var(--text)' }}>Bem-vindo ao AI Workspace</h2>
                <p style={{ maxWidth: 460, margin: '0 auto 18px' }}>
                  Organize seus projetos em quadros editáveis (Board / Research / Gallery), consolide conhecimento entre Claude, Codex, Gemini e Ollama com Dreaming e acompanhe sessões ao vivo lado a lado.
                </p>
                <button className="btn btn-primary" onClick={openNewModal}>
                  <Plus size={15} /> Criar primeiro projeto
                </button>
              </div>
            </div>
          )}
        </main>

        {/* Right Live AI HUD Panel */}
        <LiveHudPane
          snapshot={snap}
          projectTitle={selectedEntity?.title}
          binding={activeBinding}
          draftPrompt={draftPrompt}
          onDraftConsumed={() => setDraftPrompt('')}
          onNotify={notify}
          onPollNow={() => pollNowRef.current()}
        />
      </div>

      {/* Modal: Novo Projeto */}
      {newModal && (
        <div className="modal-bg" onClick={() => setNewModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Novo projeto no AI Workspace</h3>
            <div className="field">
              <label>Nome do projeto</label>
              <input className="inp" autoFocus value={npTitle} onChange={(e) => setNpTitle(e.target.value)} placeholder="Ex.: AI HUD v2" />
            </div>
            <div className="field">
              <label>Descrição curta</label>
              <input className="inp" value={npDesc} onChange={(e) => setNpDesc(e.target.value)} placeholder="Objetivo principal do projeto…" />
            </div>
            <div className="field">
              <label>Visão inicial do card</label>
              <select className="sel" value={npTemplate} onChange={(e) => setNpTemplate(e.target.value)}>
                <option value="board">Board (Kanban: Ideia / Em andamento / Revisão / Concluído)</option>
                <option value="research">Research (Lista rica com notas e links)</option>
                <option value="gallery">Gallery (Grade visual com imagens e prompts)</option>
              </select>
            </div>
            <div className="field">
              <label>Vincular a uma pasta de código (opcional)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  className="sel"
                  style={{ width: 170 }}
                  value={npMachine}
                  onChange={(e) => {
                    setNpMachine(e.target.value);
                    const m = caps.find((x) => x.name === e.target.value);
                    if (m?.cwds?.[0]) setNpCwd(m.cwds[0]);
                  }}
                >
                  <option value="">Sem vínculo</option>
                  {caps.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
                <input
                  className="inp mono"
                  value={npCwd}
                  onChange={(e) => setNpCwd(e.target.value)}
                  placeholder="Ex.: d:\Projetos\ai-hud"
                />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn" onClick={() => setNewModal(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCreateEntity}>Criar projeto</button>
            </div>
          </div>
        </div>
      )}

      <CommandPalette open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}
