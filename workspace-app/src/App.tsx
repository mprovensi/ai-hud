import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
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
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api, withToken } from './api';
import { CardEditor } from './components/CardEditor';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { FilesAndGit } from './components/FilesAndGit';
import { LiveHudPane, type CardExecIntent } from './components/LiveHudPane';
import { MemoryPanel } from './components/MemoryPanel';
import { NewProjectDrawer, type ProjectDrawerMode } from './components/NewProjectDrawer';
import { NewSessionDrawer } from './components/NewSessionDrawer';
import { NotesAndReports } from './components/NotesAndReports';
import { ProjectDocsPane } from './components/ProjectDocsPane';
import { QuotaDrawer, type QuotaProvider } from './components/QuotaDrawer';
import { TerminalPane } from './components/TerminalPane';
import { WorkspaceHome } from './components/WorkspaceHome';
import type { Snapshot, WorkspaceEntity, WorkspaceIndex, WorkspaceSyncStatus } from './types';

type Selection =
  | { kind: 'entity'; id: string }
  | { kind: 'doc'; area: 'context' | 'knowledge' | 'skills' | 'handoffs'; name: string }
  | null;

type EntityTab = 'step' | 'docs' | 'memory' | 'files' | 'terminal';

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
  const [activeProjectDoc, setActiveProjectDoc] = useState('');
  const [boardReloadKey, setBoardReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [pendingCardExec, setPendingCardExec] = useState<CardExecIntent | null>(null);
  const [runningCardExec, setRunningCardExec] = useState<(CardExecIntent & {
    sessionId: string;
    startedAt: number;
    seenWorking: boolean;
  }) | null>(null);
  const [focusSessionId, setFocusSessionId] = useState('');
  const [syncSt, setSyncSt] = useState<WorkspaceSyncStatus | null>(null);
  const [syncingNow, setSyncingNow] = useState(false);

  // Englobadores colapsáveis na sidebar
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Gaveta lateral direita em altura total para Nova Conversa
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatPrompt, setNewChatPrompt] = useState('');
  const [newChatLocked, setNewChatLocked] = useState(false);

  // Gaveta lateral direita com detalhes de uso da assinatura de IA
  const [quotaProvider, setQuotaProvider] = useState<QuotaProvider | null>(null);

  // Gaveta lateral esquerda em altura total para Criar / Editar Projeto ou Workspace
  const [projectDrawer, setProjectDrawer] = useState<{
    open: boolean;
    mode: ProjectDrawerMode;
    presetGroup: string;
    editEntity: WorkspaceEntity | null;
    editGroup: string | null;
  }>({
    open: false,
    mode: 'project',
    presetGroup: '',
    editEntity: null,
    editGroup: null,
  });

  // Menuzinho flutuante dos três pontinhos (...) na sidebar
  const [itemMenu, setItemMenu] = useState<
    | { kind: 'entity'; entity: WorkspaceEntity; x: number; y: number }
    | { kind: 'group'; name: string; count: number; x: number; y: number }
    | null
  >(null);

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

  // Modal de confirmação para apagar projeto ou englobador (workspace)
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: 'entity'; id: string; title: string; cwd?: string }
    | { kind: 'group'; name: string; count: number }
    | null
  >(null);
  const [deleting, setDeleting] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // Item 4: Quando a sessão vinculada a um card executado conclui sem erro, avança o card automaticamente para a próxima fase
  const attachCardExecToSession = useCallback((sessionId: string) => {
    setPendingCardExec((cur) => {
      if (cur && cur.nextStatus && sessionId) {
        setRunningCardExec({
          ...cur,
          sessionId,
          startedAt: Date.now(),
          seenWorking: false,
        });
      }
      return null;
    });
  }, []);

  useEffect(() => {
    if (!runningCardExec || !snap) return;
    const all = [...(snap.active || []), ...(snap.recent || [])];
    const s = all.find((x) => x.id === runningCardExec.sessionId);
    if (!s) return;

    if (s.state === 'working') {
      if (!runningCardExec.seenWorking) {
        setRunningCardExec((prev) => (prev ? { ...prev, seenWorking: true } : null));
      }
      return;
    }

    const finishedAfterStart = (s.end || 0) > runningCardExec.startedAt - 1000;
    if ((runningCardExec.seenWorking || finishedAfterStart) && (s.state === 'waiting' || s.state === 'idle')) {
      const exec = runningCardExec;
      setRunningCardExec(null);
      const failedReply = typeof s.lastReply === 'string' && /^\s*⚠/.test(s.lastReply);
      if (failedReply || !exec.nextStatus) return;

      (async () => {
        try {
          const detail = await api.getSession(exec.sessionId).catch(() => null);
          if (detail && detail.testRun && detail.testRun.ok === false) return;
          const b = await api.getProjectBoard(exec.entityId);
          if (!b.content || b.offlineFallback) return;
          const target = b.content.items.find((it) => it.id === exec.itemId);
          if (!target || (target.status || 'idea') !== exec.currentStatus) return;
          const nextCard = {
            ...b.content,
            items: b.content.items.map((it) => (
              it.id === exec.itemId
                ? { ...it, status: exec.nextStatus!, updatedAt: Date.now() }
                : it
            )),
          };
          await api.saveProjectBoard({ entityId: exec.entityId, content: nextCard, baseHash: b.hash });
          if (exec.nextStatus === 'done' && target.docRef) {
            await api.syncDocCheckbox({ entityId: exec.entityId, docRef: target.docRef, title: target.title, done: true }).catch(() => {});
          }
          setBoardReloadKey((k) => k + 1);
          notify(`"${exec.title}" movido automaticamente para ${exec.nextLabel}.`);
        } catch {}
      })();
    }
  }, [runningCardExec, snap, notify]);

  const loadWorkspace = useCallback(async () => {
    try {
      const idx = await api.getWorkspaceIndex();
      setWs(idx);
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

  const openNewModal = useCallback((presetGroup = '') => {
    setProjectDrawer({ open: true, mode: 'project', presetGroup, editEntity: null, editGroup: null });
  }, []);

  const openNewGroup = useCallback(() => {
    setProjectDrawer({ open: true, mode: 'group', presetGroup: '', editEntity: null, editGroup: null });
  }, []);

  const openEditEntity = useCallback((entity: WorkspaceEntity) => {
    setProjectDrawer({ open: true, mode: 'project', presetGroup: entity.group || '', editEntity: entity, editGroup: null });
  }, []);

  const openEditGroup = useCallback((groupName: string) => {
    setProjectDrawer({ open: true, mode: 'group', presetGroup: '', editEntity: null, editGroup: groupName });
  }, []);

  useEffect(() => {
    if (!itemMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setItemMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [itemMenu]);

  async function executeConfirmDelete() {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    try {
      if (confirmDelete.kind === 'entity') {
        await api.deleteEntity(confirmDelete.id);
        if (selection?.kind === 'entity' && selection.id === confirmDelete.id) {
          setSelection(null);
        }
        await loadWorkspace();
        notify(`Projeto "${confirmDelete.title}" removido do Workspace.`);
      } else {
        await api.saveGroup({ name: confirmDelete.name, remove: true });
        await loadWorkspace();
        notify(`Workspace "${confirmDelete.name}" removido.`);
      }
      setConfirmDelete(null);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setDeleting(false);
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
      sections.push({ name: '', label: sections.length ? 'Geral (sem workspace)' : 'Projetos', items: ungrouped });
    }
    return sections;
  }, [allGroups, filteredEntities, search]);

  const paletteActions: PaletteAction[] = useMemo(() => {
    const acts: PaletteAction[] = [
      { id: 'act-home', group: 'Navegação', label: 'Voltar para Início (Dashboard do Workspace)', run: () => setSelection(null) },
      { id: 'act-chat', group: 'Ação', label: 'Nova conversa com IA (escolher pasta e IA)', run: () => { setNewChatPrompt(''); setNewChatLocked(false); setNewChatOpen(true); } },
      { id: 'act-new', group: 'Ação', label: 'Criar novo projeto no Workspace', run: () => openNewModal('') },
      { id: 'act-grp', group: 'Ação', label: 'Criar workspace (ex.: TRT, Jogos)', run: openNewGroup },
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
        <button className="brand" onClick={() => setSelection(null)} title="Voltar para a tela inicial do AI Workspace">
          <span className="brand-dot" />
          AI Workspace
        </button>
        <a className="pill-link" href={withToken('/')}>
          <LayoutDashboard size={13} /> HUD Clássico
        </a>
        <button className="cmd-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={13} /> Buscar ou ir para… <span className="kbd">Ctrl+K</span>
        </button>

        {/* Item 5: Indicadores de uso 5h (negrito) • semanal (normal) — clicáveis para abrir detalhes */}
        <div className="quota-strip">
          {cQ && (
            <button
              className="qchip"
              onClick={() => setQuotaProvider('claude')}
              title="Claude: 5h (negrito) • semanal (normal) — clique para ver detalhes"
            >
              <span className="qdot" style={{ background: 'var(--claude)' }} />
              Claude <b>{cQ.primary}</b>
              {cQ.secondary && <><span className="q-sep">•</span><span className="q-sec">{cQ.secondary}</span></>}
            </button>
          )}
          {xQ && (
            <button
              className="qchip"
              onClick={() => setQuotaProvider('codex')}
              title="Codex: 5h (negrito) • semanal (normal) — clique para ver detalhes"
            >
              <span className="qdot" style={{ background: 'var(--codex)' }} />
              Codex <b>{xQ.primary}</b>
              {xQ.secondary && <><span className="q-sep">•</span><span className="q-sec">{xQ.secondary}</span></>}
            </button>
          )}
          {gQ && (
            <button
              className="qchip"
              onClick={() => setQuotaProvider('gemini')}
              title="Gemini: 5h/pro (negrito) • diária/semanal (normal) — clique para ver detalhes"
            >
              <span className="qdot" style={{ background: 'var(--gemini)' }} />
              Gemini <b>{gQ.primary}</b>
              {gQ.secondary && <><span className="q-sep">•</span><span className="q-sec">{gQ.secondary}</span></>}
            </button>
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
            <button className="btn btn-sm btn-icon" title="Novo workspace (ex.: TRT, Jogos)" onClick={openNewGroup}>
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
                    {sec.name && (
                      <button
                        className={`sb-more ${itemMenu?.kind === 'group' && itemMenu.name === sec.name ? 'open' : ''}`}
                        title={`Opções do workspace "${sec.name}"`}
                        aria-label={`Opções do workspace ${sec.name}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          const rect = ev.currentTarget.getBoundingClientRect();
                          setItemMenu({
                            kind: 'group',
                            name: sec.name,
                            count: sec.items.length,
                            x: Math.min(rect.left, window.innerWidth - 170),
                            y: Math.min(rect.bottom + 4, window.innerHeight - 96),
                          });
                        }}
                      >
                        <MoreVertical size={14} />
                      </button>
                    )}
                    <button
                      className="btn btn-sm btn-icon"
                      style={{ padding: 2, border: 0, background: 'transparent' }}
                      title={`Novo projeto em ${sec.label}`}
                      onClick={() => openNewModal(sec.name)}
                    >
                      <Plus size={13} color="var(--muted)" />
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
                            <div key={e.id} className="sb-row">
                              <button
                                className={`sb-item ${active ? 'active' : ''}`}
                                onClick={() => { setSelection({ kind: 'entity', id: e.id }); setEntityTab('step'); setStepIdx(0); }}
                              >
                                <FolderKanban size={14} color={active ? 'var(--accent)' : 'var(--muted)'} style={{ flexShrink: 0 }} />
                                <span className="ell">{e.title}</span>
                                {e.projectBindings?.[0] && (
                                  <span className="meta">{e.projectBindings[0].machine}</span>
                                )}
                              </button>
                              <button
                                className={`sb-more ${itemMenu?.kind === 'entity' && itemMenu.entity.id === e.id ? 'open' : ''}`}
                                title={`Opções de "${e.title}"`}
                                aria-label={`Opções do projeto ${e.title}`}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  const rect = ev.currentTarget.getBoundingClientRect();
                                  setItemMenu({
                                    kind: 'entity',
                                    entity: e,
                                    x: Math.min(rect.left, window.innerWidth - 170),
                                    y: Math.min(rect.bottom + 4, window.innerHeight - 96),
                                  });
                                }}
                              >
                                <MoreVertical size={14} />
                              </button>
                            </div>
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
                  <button className="btn btn-sm btn-icon" onClick={() => setSelection(null)} aria-label="Voltar" title="Voltar">
                    <ArrowLeft size={14} />
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 className="stage-title ell">{selectedEntity.title}</h1>
                    {selectedEntity.description && <p className="stage-desc ell">{selectedEntity.description}</p>}
                  </div>
                  {activeBinding && (
                    <span className="badge mono">{activeBinding.machine}: {activeBinding.cwd}</span>
                  )}
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => { setNewChatPrompt(''); setNewChatLocked(true); setNewChatOpen(true); }}
                    title="Abrir nova conversa neste projeto"
                  >
                    <Plus size={13} /> Nova conversa
                  </button>
                </div>

                <div className="tabs">
                  {selectedEntity.steps.map((st, idx) => {
                    // Em projetos com pasta vinculada, substitui a aba genérica "Notas" (notes.md) por "Docs & Specs"
                    if (activeBinding && st.path === 'notes.md') return null;
                    return (
                      <button
                        key={st.path}
                        className={`tab ${entityTab === 'step' && stepIdx === idx ? 'active' : ''}`}
                        onClick={() => { setEntityTab('step'); setStepIdx(idx); }}
                      >
                        <FileText size={14} /> {st.name}
                      </button>
                    );
                  })}
                  {activeBinding && (
                    <button
                      className={`tab ${entityTab === 'docs' ? 'active' : ''}`}
                      onClick={() => setEntityTab('docs')}
                    >
                      <BookOpen size={14} /> Docs & Specs
                    </button>
                  )}
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

              <div className={`stage-content ${entityTab === 'step' && activeStep && (activeStep.viewer === 'card' || activeStep.path.endsWith('.card.json')) ? 'stage-board' : ''}`}>
                {entityTab === 'step' && activeStep ? (
                  activeStep.viewer === 'card' || activeStep.path.endsWith('.card.json') ? (
                    <CardEditor
                      entityId={selectedEntity.id}
                      filePath={activeStep.path}
                      hasProjectCwd={!!activeBinding}
                      reloadKey={boardReloadKey}
                      snapshotVersion={snap?.version}
                      onNotify={notify}
                      onSendPrompt={(p) => { setPendingCardExec(null); setDraftPrompt(p); }}
                      onExecuteItem={(intent) => { setPendingCardExec(intent); setDraftPrompt(intent.prompt); }}
                      onOpenDoc={(p) => { setActiveProjectDoc(p); setEntityTab('docs'); }}
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
                ) : entityTab === 'docs' && activeBinding ? (
                  <ProjectDocsPane
                    entityId={selectedEntity.id}
                    initialDocPath={activeProjectDoc}
                    onNotify={notify}
                    onSendPrompt={(p) => setDraftPrompt(p)}
                    onBoardChanged={() => setBoardReloadKey((k) => k + 1)}
                  />
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
                  <button className="btn btn-sm btn-icon" onClick={() => setSelection(null)} aria-label="Voltar" title="Voltar">
                    <ArrowLeft size={14} />
                  </button>
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
              <WorkspaceHome
                ws={ws}
                snap={snap}
                groupsCount={allGroups.length}
                onOpenEntity={(id, tab = 'step') => {
                  setSelection({ kind: 'entity', id });
                  setEntityTab(tab);
                  setStepIdx(0);
                }}
                onNewProject={(g = '') => openNewModal(g)}
                onNewGroup={openNewGroup}
                onNewConversation={() => { setNewChatPrompt(''); setNewChatLocked(false); setNewChatOpen(true); }}
              />
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
          focusSessionId={focusSessionId}
          onFocusSessionConsumed={() => setFocusSessionId('')}
          draftPrompt={draftPrompt}
          onDraftConsumed={() => setDraftPrompt('')}
          pendingCardExec={pendingCardExec}
          onCancelCardExec={() => setPendingCardExec(null)}
          onCardExecAttached={attachCardExecToSession}
          onOpenNewSession={(initial) => {
            setNewChatPrompt(initial || '');
            setNewChatLocked(false);
            setNewChatOpen(true);
          }}
          onNotify={notify}
          onPollNow={() => pollNowRef.current()}
          width={rightW}
        />
      </div>

      {/* Gaveta lateral esquerda: Criar / Editar Projeto ou Workspace */}
      <NewProjectDrawer
        open={projectDrawer.open}
        initialMode={projectDrawer.mode}
        presetGroup={projectDrawer.presetGroup}
        editEntity={projectDrawer.editEntity}
        editGroup={projectDrawer.editGroup}
        groups={allGroups}
        groupMeta={ws?.groupMeta || {}}
        entities={ws?.entities || []}
        onClose={() => setProjectDrawer((prev) => ({ ...prev, open: false, editEntity: null, editGroup: null }))}
        onProjectSaved={async (entity, isEdit) => {
          await loadWorkspace();
          if (!isEdit) {
            setSelection({ kind: 'entity', id: entity.id });
            setEntityTab('step');
            setStepIdx(0);
          }
          notify(isEdit ? `Projeto "${entity.title}" atualizado.` : `Projeto "${entity.title}" criado.`);
        }}
        onGroupSaved={async (name, renamedFrom) => {
          await loadWorkspace();
          notify(renamedFrom ? `Workspace renomeado para "${name}".` : `Workspace "${name}" criado.`);
        }}
        onNotify={notify}
      />

      {/* Menuzinho (...) da sidebar para Editar / Excluir Projeto ou Workspace */}
      {itemMenu && (
        <div className="ctx-menu-bg" onClick={() => setItemMenu(null)}>
          <div
            className="ctx-menu"
            style={{ left: itemMenu.x, top: itemMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-menu-item"
              onClick={() => {
                const cur = itemMenu;
                setItemMenu(null);
                if (cur.kind === 'entity') openEditEntity(cur.entity);
                else openEditGroup(cur.name);
              }}
            >
              <Pencil size={13} /> Editar
            </button>
            <button
              className="ctx-menu-item danger"
              onClick={() => {
                const cur = itemMenu;
                setItemMenu(null);
                if (cur.kind === 'entity') {
                  setConfirmDelete({
                    kind: 'entity',
                    id: cur.entity.id,
                    title: cur.entity.title,
                    cwd: cur.entity.projectBindings?.[0]?.cwd,
                  });
                } else {
                  setConfirmDelete({ kind: 'group', name: cur.name, count: cur.count });
                }
              }}
            >
              <Trash2 size={13} /> Excluir
            </button>
          </div>
        </div>
      )}

      {/* Gaveta lateral direita: Nova Conversa com IA */}
      <NewSessionDrawer
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        defaultBinding={activeBinding}
        lockedProject={
          newChatLocked && selectedEntity
            ? {
                title: selectedEntity.title,
                machine: activeBinding?.machine || '',
                cwd: activeBinding?.cwd || '',
              }
            : null
        }
        entities={ws?.entities || []}
        snapshot={snap}
        initialPrompt={newChatPrompt}
        onCreated={(newSessionId) => {
          if (newSessionId) {
            setFocusSessionId(newSessionId);
            attachCardExecToSession(newSessionId);
          }
          pollNowRef.current();
        }}
        onNotify={notify}
      />

      {/* Gaveta lateral direita: Detalhes de uso da assinatura de IA */}
      <QuotaDrawer
        provider={quotaProvider}
        snapshot={snap}
        onChangeProvider={setQuotaProvider}
        onClose={() => setQuotaProvider(null)}
        onPollNow={() => pollNowRef.current()}
        onNotify={notify}
      />

      <CommandPalette open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} />

      {/* Modal de confirmação de exclusão (Projeto ou Englobador) */}
      {confirmDelete && (
        <div className="modal-bg" onClick={() => !deleting && setConfirmDelete(null)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f6b3b3' }}>
              <Trash2 size={17} />
              {confirmDelete.kind === 'entity' ? 'Apagar projeto?' : 'Apagar workspace?'}
            </h3>
            {confirmDelete.kind === 'entity' ? (
              <p style={{ margin: '0 0 10px', fontSize: 13.5, lineHeight: 1.5, color: '#d5dbe7' }}>
                Tem certeza que deseja remover o projeto <b>{confirmDelete.title}</b> do AI Workspace?
                <br />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Os cards e notas serão movidos para backup interno (<code>.ai-workspace/backups/deleted/</code>).
                  {confirmDelete.cwd ? <> A pasta de código (<code className="mono">{confirmDelete.cwd}</code>) <b>não</b> será apagada.</> : null}
                </span>
              </p>
            ) : (
              <p style={{ margin: '0 0 10px', fontSize: 13.5, lineHeight: 1.5, color: '#d5dbe7' }}>
                Tem certeza que deseja apagar o workspace <b>{confirmDelete.name}</b>?
                <br />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {confirmDelete.count > 0
                    ? `Os ${confirmDelete.count} projeto(s) dentro dele não serão apagados — passarão para "Geral (sem workspace)".`
                    : 'Este workspace está vazio e será removido da lista.'}
                </span>
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn" disabled={deleting} onClick={() => setConfirmDelete(null)}>
                Cancelar
              </button>
              <button className="btn btn-danger" disabled={deleting} onClick={executeConfirmDelete}>
                <Trash2 size={13} /> {deleting ? 'Apagando…' : 'Confirmar exclusão'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}
