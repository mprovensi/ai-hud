import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderGit2,
  FolderKanban,
  FolderPlus,
  GitFork,
  Layers,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api, withToken } from './api';
import { CardEditor } from './components/CardEditor';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { FilesAndGit } from './components/FilesAndGit';
import { LiveHudPane } from './components/LiveHudPane';
import { MemoryPanel } from './components/MemoryPanel';
import { NewSessionDrawer } from './components/NewSessionDrawer';
import { NotesAndReports } from './components/NotesAndReports';
import { TerminalPane } from './components/TerminalPane';
import type { MachineCaps, Snapshot, WorkspaceEntity, WorkspaceIndex, WorkspaceSyncStatus } from './types';

type Selection =
  | { kind: 'entity'; id: string }
  | { kind: 'doc'; area: 'context' | 'knowledge' | 'skills' | 'handoffs'; name: string }
  | null;

type EntityTab = 'step' | 'memory' | 'files' | 'terminal';

function quotaPair(q?: { windows?: Record<string, { used: number }> }): { primary: string; secondary: string | null } | null {
  if (!q?.windows) return null;
  const w = q.windows;
  const p = w.five_hour || w.pro || Object.values(w)[0];
  const s = w.seven_day || w.daily || (w.flash && w.flash !== p ? w.flash : null);
  if (!p || typeof p.used !== 'number') return null;
  return {
    primary: `${Math.round(p.used)}%`,
    secondary: s && typeof s.used === 'number' ? `${Math.round(s.used)}%` : null,
  };
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    if (Number.isFinite(n) && n >= min && n <= max) return n;
  } catch {}
  return fallback;
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
  const [syncSt, setSyncSt] = useState<WorkspaceSyncStatus | null>(null);
  const [syncingNow, setSyncingNow] = useState(false);

  // Englobadores colapsáveis na sidebar
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Gaveta lateral esquerda em altura total para Nova Conversa (padrão Mr. Mak)
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatPrompt, setNewChatPrompt] = useState('');

  // Resize das 3 colunas (esquerda | centro flex:1 | direita)
  const [leftW, setLeftW] = useState(() => readStoredWidth('ai_ws_left_w', 260, 180, 480));
  const [rightW, setRightW] = useState(() => readStoredWidth('ai_ws_right_w', 400, 300, 740));
  const [draggingCol, setDraggingCol] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    if (!draggingCol) return;
    const onMove = (e: MouseEvent) => {
      if (draggingCol === 'left') {
        const next = Math.max(180, Math.min(480, e.clientX));
        setLeftW(next);
        try { localStorage.setItem('ai_ws_left_w', String(next)); } catch {}
      } else {
        const next = Math.max(300, Math.min(740, window.innerWidth - e.clientX));
        setRightW(next);
        try { localStorage.setItem('ai_ws_right_w', String(next)); } catch {}
      }
    };
    const onUp = () => setDraggingCol(null);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingCol]);

  // Modal + Novo Projeto
  const [newModal, setNewModal] = useState(false);
  const [caps, setCaps] = useState<MachineCaps[]>([]);
  const [npTitle, setNpTitle] = useState('');
  const [npDesc, setNpDesc] = useState('');
  const [npGroup, setNpGroup] = useState('');
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

  const loadSyncStatus = useCallback(async () => {
    try {
      setSyncSt(await api.getWorkspaceSync());
    } catch {}
  }, []);

  const triggerSync = useCallback(async () => {
    if (syncingNow) return;
    let init = false;
    let remote = '';
    if (syncSt && !syncSt.isRepo) {
      if (!window.confirm('Inicializar repositório Git em data/workspace/ para sincronizar entre máquinas?')) return;
      init = true;
      remote = window.prompt('URL do repositório Git remoto (opcional — pode configurar depois):', '') || '';
    }
    setSyncingNow(true);
    try {
      const r = await api.runWorkspaceSync({ init, remote: remote.trim() || undefined });
      setSyncSt(r.status);
      notify(r.pushed ? 'Workspace sincronizado com o remoto.' : r.committed ? 'Alterações salvas no Git local.' : 'Workspace já está atualizado.');
      loadWorkspace();
    } catch (e) {
      notify((e as Error).message, true);
      loadSyncStatus();
    } finally {
      setSyncingNow(false);
    }
  }, [syncingNow, syncSt, notify, loadWorkspace, loadSyncStatus]);

  useEffect(() => {
    loadWorkspace();
    loadSyncStatus();
    const id = window.setInterval(loadSyncStatus, 60000);
    return () => window.clearInterval(id);
  }, [loadWorkspace, loadSyncStatus]);

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

  const openNewModal = useCallback(async (presetGroup = '') => {
    setNpGroup(presetGroup);
    setNewModal(true);
    try {
      const c = await api.getCapabilities();
      setCaps(c.machines || []);
      const first = c.machines.find((m) => m.online) || c.machines[0];
      if (first) {
        setNpMachine(first.name);
        setNpCwd(first.pinned?.[0] || first.cwds?.[0] || '');
      }
    } catch {}
  }, []);

  const openNewGroup = useCallback(async () => {
    const raw = window.prompt('Nome do englobador de projetos (ex.: TRT, Jogos, Pessoal):');
    if (!raw || !raw.trim()) return;
    try {
      await api.saveGroup({ name: raw.trim() });
      await loadWorkspace();
      notify(`Workspace "${raw.trim()}" criado.`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }, [loadWorkspace, notify]);

  async function handleCreateEntity() {
    if (!npTitle.trim()) return notify('Informe o nome do projeto.', true);
    try {
      const bindings = npMachine && npCwd.trim() ? [{ machine: npMachine, cwd: npCwd.trim() }] : [];
      const r = await api.createEntity({
        title: npTitle.trim(),
        description: npDesc.trim(),
        group: npGroup.trim(),
        template: npTemplate,
        projectBindings: bindings,
      });
      setNewModal(false);
      setNpTitle('');
      setNpDesc('');
      setNpGroup('');
      await loadWorkspace();
      setSelection({ kind: 'entity', id: r.entity.id });
      setEntityTab('step');
      setStepIdx(0);
      notify(`Projeto "${r.entity.title}" criado.`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  async function handleChangeEntityGroup(entity: WorkspaceEntity, nextGroup: string) {
    let target = nextGroup;
    if (nextGroup === '__new__') {
      const raw = window.prompt('Nome do novo englobador (ex.: TRT, Jogos):');
      if (!raw || !raw.trim()) return;
      target = raw.trim();
    }
    try {
      await api.updateEntity({ id: entity.id, group: target });
      await loadWorkspace();
      notify(target ? `Movido para "${target}".` : 'Removido do englobador.');
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
      ? ws.entities.filter((e) => `${e.title} ${e.description || ''} ${e.group || ''} ${e.category || ''}`.toLowerCase().includes(q))
      : ws.entities;
    return list.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [ws, search]);

  const allGroups = useMemo(() => {
    const set = new Set<string>(ws?.groups || []);
    for (const e of ws?.entities || []) if (e.group) set.add(e.group);
    return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [ws]);

  // Agrupa projetos filtrados por englobador (mantendo englobadores vazios quando sem busca)
  const groupedSections = useMemo(() => {
    const map = new Map<string, WorkspaceEntity[]>();
    if (!search.trim()) {
      for (const g of allGroups) map.set(g, []);
    }
    const ungrouped: WorkspaceEntity[] = [];
    for (const e of filteredEntities) {
      const g = (e.group || '').trim();
      if (g) {
        if (!map.has(g)) map.set(g, []);
        map.get(g)!.push(e);
      } else {
        ungrouped.push(e);
      }
    }
    const sections: { name: string; label: string; items: WorkspaceEntity[] }[] = [];
    for (const [name, items] of map.entries()) {
      sections.push({ name, label: name, items });
    }
    if (ungrouped.length || sections.length === 0) {
      sections.push({ name: '', label: sections.length ? 'Geral (sem grupo)' : 'Projetos', items: ungrouped });
    }
    return sections;
  }, [allGroups, filteredEntities, search]);

  const paletteActions: PaletteAction[] = useMemo(() => {
    const acts: PaletteAction[] = [
      { id: 'act-chat', group: 'Ação', label: 'Nova conversa com IA (escolher pasta e IA)', run: () => { setNewChatPrompt(''); setNewChatOpen(true); } },
      { id: 'act-new', group: 'Ação', label: 'Criar novo projeto no Workspace', run: () => openNewModal('') },
      { id: 'act-grp', group: 'Ação', label: 'Criar englobador de projetos (ex.: TRT, Jogos)', run: openNewGroup },
      { id: 'act-hud', group: 'Navegação', label: 'Abrir AI HUD Clássico (/)', run: () => { window.location.href = withToken('/'); } },
    ];
    for (const e of ws?.entities || []) {
      acts.push({
        id: `ent-${e.id}`,
        group: e.group || 'Projeto',
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
  }, [ws, openNewModal, openNewGroup]);

  const cQ = quotaPair(snap?.quotas?.claude);
  const xQ = quotaPair(snap?.quotas?.codex);
  const gQ = quotaPair(snap?.quotas?.gemini);

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
        <button className="btn btn-sm btn-primary" onClick={() => { setNewChatPrompt(''); setNewChatOpen(true); }} title="Abrir gaveta lateral para escolher pasta e IA">
          <Plus size={13} /> Nova conversa
        </button>
        <button className="cmd-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={13} /> Buscar ou ir para… <span className="kbd">Ctrl+K</span>
        </button>

        {/* Item 5: Indicadores de uso 5h (negrito) • semanal (normal) */}
        <div className="quota-strip">
          {cQ && (
            <span className="qchip" title="Claude: janela 5h (negrito) • semanal (normal)">
              <span className="qdot" style={{ background: 'var(--claude)' }} />
              Claude <b>{cQ.primary}</b>
              {cQ.secondary && <><span className="q-sep">•</span><span className="q-sec">{cQ.secondary}</span></>}
            </span>
          )}
          {xQ && (
            <span className="qchip" title="Codex: janela 5h (negrito) • semanal (normal)">
              <span className="qdot" style={{ background: 'var(--codex)' }} />
              Codex <b>{xQ.primary}</b>
              {xQ.secondary && <><span className="q-sep">•</span><span className="q-sec">{xQ.secondary}</span></>}
            </span>
          )}
          {gQ && (
            <span className="qchip" title="Gemini: janela 5h/pro (negrito) • diária/semanal (normal)">
              <span className="qdot" style={{ background: 'var(--gemini)' }} />
              Gemini <b>{gQ.primary}</b>
              {gQ.secondary && <><span className="q-sep">•</span><span className="q-sec">{gQ.secondary}</span></>}
            </span>
          )}
          {syncSt && (
            <button
              className={`pill-link ${syncSt.conflicts.length ? 'danger' : ''}`}
              onClick={triggerSync}
              disabled={syncingNow}
              title={syncSt.isRepo
                ? `Git Sync (${syncSt.branch})${syncSt.remote ? ` · ${syncSt.remote}` : ' · somente local'}${syncSt.lastError ? ` · Erro: ${syncSt.lastError}` : ''}`
                : 'Inicializar Git Sync do Workspace'}
              style={{
                borderColor: syncSt.conflicts.length ? 'var(--danger)' : (syncSt.dirty || syncSt.ahead || syncSt.behind) ? 'var(--warn)' : undefined,
                color: syncSt.conflicts.length ? 'var(--danger)' : undefined,
              }}
            >
              <RefreshCw size={12} className={syncingNow ? 'spin' : ''} />
              {syncingNow
                ? 'Sincronizando…'
                : !syncSt.isRepo
                  ? 'Git Sync'
                  : syncSt.conflicts.length
                    ? `Conflito (${syncSt.conflicts.length})`
                    : (syncSt.dirty || syncSt.ahead || syncSt.behind)
                      ? `Sync${syncSt.dirty ? ` ${syncSt.dirty}Δ` : ''}${syncSt.ahead ? ` ↑${syncSt.ahead}` : ''}${syncSt.behind ? ` ↓${syncSt.behind}` : ''}`
                      : 'Sync OK'}
            </button>
          )}
          <span className={`status-pill ${online ? '' : 'off'}`}>
            {online ? <Wifi size={13} /> : <WifiOff size={13} />}
            {online ? 'ao vivo' : 'reconectando…'}
          </span>
        </div>
      </header>

      <div className="ws-body">
        {/* Left Sidebar (Resizable) */}
        <nav className="sidebar" style={{ width: leftW }}>
          <div className="sb-head">
            <input
              className="sb-search"
              placeholder="Filtrar projetos…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="btn btn-sm btn-icon" title="Novo englobador (ex.: TRT, Jogos)" onClick={openNewGroup}>
              <FolderPlus size={14} />
            </button>
            <button className="btn btn-primary btn-sm btn-icon" title="Novo projeto" onClick={() => openNewModal('')}>
              <Plus size={15} />
            </button>
          </div>

          <div className="sb-scroll">
            {/* Item 1: Projetos agrupados por Englobador (Workspace) */}
            {groupedSections.map((sec) => {
              const isCol = !!collapsedGroups[sec.name || '__ungrouped'];
              return (
                <div key={sec.name || '__ungrouped'} className="ws-group">
                  <div className="ws-group-head">
                    <button
                      style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 0, textAlign: 'left', color: 'inherit' }}
                      onClick={() => setCollapsedGroups((prev) => ({ ...prev, [sec.name || '__ungrouped']: !prev[sec.name || '__ungrouped'] }))}
                    >
                      {isCol ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <Layers size={12} color="var(--accent)" style={{ flexShrink: 0 }} />
                      <span className="ell">{sec.label}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', marginLeft: 3 }}>({sec.items.length})</span>
                    </button>
                    <button
                      className="btn btn-sm btn-icon"
                      style={{ padding: 2, border: 0, background: 'transparent' }}
                      title={`Novo projeto em ${sec.label}`}
                      onClick={() => openNewModal(sec.name)}
                    >
                      <Plus size={12} color="var(--muted)" />
                    </button>
                  </div>

                  {!isCol && (
                    <div className="ws-group-body">
                      {sec.items.length === 0 ? (
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '3px 8px 6px' }}>
                          Nenhum projeto aqui ainda.
                        </div>
                      ) : (
                        sec.items.map((e) => {
                          const active = selection?.kind === 'entity' && selection.id === e.id;
                          return (
                            <button
                              key={e.id}
                              className={`sb-item ${active ? 'active' : ''}`}
                              onClick={() => { setSelection({ kind: 'entity', id: e.id }); setEntityTab('step'); setStepIdx(0); }}
                            >
                              <FolderKanban size={14} color={active ? 'var(--accent)' : 'var(--muted)'} style={{ flexShrink: 0 }} />
                              <span className="ell">{e.title}</span>
                              {e.projectBindings?.[0] && (
                                <span className="meta">{e.projectBindings[0].machine}</span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {([
              ['context', 'Contexto Global', BookOpen],
              ['knowledge', 'Conhecimento', FileText],
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

        {/* Item 6: Left ↔ Center Resizer */}
        <div
          className={`col-resizer ${draggingCol === 'left' ? 'dragging' : ''}`}
          onMouseDown={() => setDraggingCol('left')}
          title="Arraste para redimensionar a lista de projetos"
        />

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
                  <select
                    className="sel"
                    style={{ width: 'auto', minWidth: 140, maxWidth: 200, padding: '4px 8px', fontSize: 12 }}
                    title="Englobador (Workspace) deste projeto"
                    value={selectedEntity.group || ''}
                    onChange={(e) => handleChangeEntityGroup(selectedEntity, e.target.value)}
                  >
                    <option value="">Sem englobador</option>
                    {allGroups.map((g) => <option key={g} value={g}>📁 {g}</option>)}
                    <option value="__new__">+ Novo englobador…</option>
                  </select>
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
                    <>
                      <button
                        className={`tab ${entityTab === 'files' ? 'active' : ''}`}
                        onClick={() => setEntityTab('files')}
                      >
                        <FolderGit2 size={14} /> Arquivos & Git
                      </button>
                      <button
                        className={`tab ${entityTab === 'terminal' ? 'active' : ''}`}
                        onClick={() => setEntityTab('terminal')}
                      >
                        <Terminal size={14} /> Terminal
                      </button>
                    </>
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
                ) : entityTab === 'terminal' && activeBinding ? (
                  <TerminalPane
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
                  Organize seus projetos em englobadores (ex.: TRT, Jogos), quadros editáveis, memória compartilhada entre as 4 IAs e sessões ao vivo lado a lado.
                </p>
                <button className="btn btn-primary" onClick={() => openNewModal('')}>
                  <Plus size={15} /> Criar primeiro projeto
                </button>
              </div>
            </div>
          )}
        </main>

        {/* Item 6: Center ↔ Right Resizer */}
        <div
          className={`col-resizer ${draggingCol === 'right' ? 'dragging' : ''}`}
          onMouseDown={() => setDraggingCol('right')}
          title="Arraste para redimensionar a lista de sessões"
        />

        {/* Right Live AI HUD Panel (Resizable) */}
        <LiveHudPane
          snapshot={snap}
          projectId={selectedEntity?.id}
          projectTitle={selectedEntity?.title}
          binding={activeBinding}
          draftPrompt={draftPrompt}
          onDraftConsumed={() => setDraftPrompt('')}
          onOpenNewSession={(initial) => {
            setNewChatPrompt(initial || '');
            setNewChatOpen(true);
          }}
          onNotify={notify}
          onPollNow={() => pollNowRef.current()}
          width={rightW}
        />
      </div>

      {/* Item 2: Gaveta lateral esquerda em altura total para Nova Conversa (Pasta + IA) */}
      <NewSessionDrawer
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        defaultBinding={activeBinding}
        entities={ws?.entities || []}
        snapshot={snap}
        initialPrompt={newChatPrompt}
        onCreated={() => pollNowRef.current()}
        onNotify={notify}
      />

      {/* Modal: Novo Projeto */}
      {newModal && (
        <div className="modal-bg" onClick={() => setNewModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Novo projeto no AI Workspace</h3>
            <div className="field">
              <label>Englobador / Workspace (ex.: TRT, Jogos)</label>
              <input
                className="inp"
                list="wsGroupOptions"
                value={npGroup}
                onChange={(e) => setNpGroup(e.target.value)}
                placeholder="Ex.: TRT, Jogos (ou deixe em branco)"
              />
              <datalist id="wsGroupOptions">
                {allGroups.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div className="field">
              <label>Nome do projeto</label>
              <input className="inp" autoFocus value={npTitle} onChange={(e) => setNpTitle(e.target.value)} placeholder="Ex.: PJe Automação" />
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
