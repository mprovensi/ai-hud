import { useMemo, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, FolderSearch, Monitor, Star } from 'lucide-react';
import { api } from '../api';
import type { FsEntry, MachineCaps, WorkspaceEntity } from '../types';

interface Props {
  caps: MachineCaps[];
  loadingCaps: boolean;
  machine: string;
  cwd: string;
  entities: WorkspaceEntity[];
  labelMachine?: string;
  labelFolder?: string;
  allowEmpty?: boolean;
  onChangeMachine: (machine: string, defaultCwd: string) => void;
  onChangeCwd: (cwd: string) => void;
  onCapsUpdated: (updater: (prev: MachineCaps[]) => MachineCaps[]) => void;
  onNotify: (msg: string, err?: boolean) => void;
}

export function shortFolderName(p: string): string {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function joinPath(base: string, child: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${child}`;
}

export function FolderPicker({
  caps,
  loadingCaps,
  machine,
  cwd,
  entities,
  labelMachine = 'Máquina',
  labelFolder = 'Pasta do projeto (CWD)',
  allowEmpty = false,
  onChangeMachine,
  onChangeCwd,
  onCapsUpdated,
  onNotify,
}: Props) {
  const [folderQuery, setFolderQuery] = useState('');
  const [browseBase, setBrowseBase] = useState('');
  const [browseRel, setBrowseRel] = useState('');
  const [browseDirs, setBrowseDirs] = useState<FsEntry[]>([]);
  const [pickingNative, setPickingNative] = useState(false);

  const currentMachine = useMemo(() => caps.find((m) => m.name === machine) || caps[0] || null, [caps, machine]);
  const pinnedSet = useMemo(() => new Set((currentMachine?.pinned || []).map((p) => p.toLowerCase())), [currentMachine]);

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

  async function exploreFolder(base: string, rel = '') {
    setBrowseBase(base);
    setBrowseRel(rel);
    onChangeCwd(rel ? joinPath(base, rel.replace(/\//g, base.includes('\\') ? '\\' : '/')) : base);
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
      onCapsUpdated((prev) => prev.map((m) => (m.name === currentMachine?.name ? { ...m, pinned: r.pinned } : m)));
      onNotify(!currentlyPinned ? 'Pasta fixada nos favoritos.' : 'Pasta removida dos favoritos.');
    } catch (e) {
      onNotify((e as Error).message, true);
    }
  }

  async function openNativePicker() {
    if (pickingNative) return;
    setPickingNative(true);
    try {
      const r = await api.pickFolder({ machine: currentMachine?.name, initialDir: cwd.trim() || undefined });
      if (!r.canceled && r.path) {
        setBrowseBase('');
        setBrowseRel('');
        setBrowseDirs([]);
        onChangeCwd(r.path);
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setPickingNative(false);
    }
  }

  return (
    <>
      {caps.length > 1 && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>{labelMachine}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {caps.map((m) => (
              <button
                key={m.name}
                type="button"
                className={`btn btn-sm ${machine === m.name ? 'btn-primary' : ''}`}
                disabled={!m.online}
                onClick={() => {
                  setBrowseBase('');
                  setBrowseRel('');
                  setBrowseDirs([]);
                  onChangeMachine(m.name, m.pinned?.[0] || m.cwds?.[0] || '');
                }}
              >
                <Monitor size={12} /> {m.name}{!m.online ? ' (offline)' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field" style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
          <label style={{ margin: 0 }}>{labelFolder}</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {allowEmpty && cwd && (
              <button type="button" className="btn btn-sm" onClick={() => onChangeCwd('')}>
                Sem vínculo
              </button>
            )}
            {browseBase && (
              <button type="button" className="btn btn-sm" onClick={() => { setBrowseBase(''); setBrowseRel(''); setBrowseDirs([]); }}>
                ← Voltar à lista
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            className="inp mono"
            style={{ fontSize: 12, flex: 1, minWidth: 0 }}
            value={cwd}
            onChange={(e) => onChangeCwd(e.target.value)}
            placeholder="Caminho completo da pasta (ex.: D:\Projetos\meu-app)…"
          />
          <button
            type="button"
            className="btn btn-icon"
            style={{ width: 36, flexShrink: 0 }}
            disabled={pickingNative}
            onClick={openNativePicker}
            aria-label="Selecionar pasta no sistema"
            title="Selecionar pasta no sistema (seletor nativo)"
          >
            <FolderSearch size={15} />
          </button>
        </div>

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
                        type="button"
                        className={`folder-row ${isSel ? 'active' : ''}`}
                        style={{ flex: 1, minWidth: 0 }}
                        onClick={() => onChangeCwd(f.path)}
                        title={f.path}
                      >
                        {isSel ? <FolderOpen size={14} color="var(--accent)" style={{ flexShrink: 0 }} /> : <Folder size={14} color="var(--muted)" style={{ flexShrink: 0 }} />}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="ell">{shortFolderName(f.path)}</div>
                          <div className="ell mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{f.path}</div>
                        </div>
                        <span className="badge" style={{ fontSize: 10 }}>{f.tag}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon"
                        style={{ border: 0, background: 'transparent' }}
                        title={f.pinned ? 'Remover dos favoritos' : 'Fixar pasta nos favoritos'}
                        onClick={() => togglePin(f.path, f.pinned)}
                      >
                        <Star size={12} fill={f.pinned ? '#e5c063' : 'none'} color={f.pinned ? '#e5c063' : 'var(--muted)'} />
                      </button>
                      <button
                        type="button"
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
                  type="button"
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
                  type="button"
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
    </>
  );
}
