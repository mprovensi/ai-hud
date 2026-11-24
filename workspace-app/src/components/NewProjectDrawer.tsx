import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderKanban, FolderLock, FolderOpen, FolderPlus, Layers, Plus, Save, X } from 'lucide-react';
import { api } from '../api';
import { FolderPicker, orderMachines, shortFolderName } from './FolderPicker';
import { Button, DrawerFrame } from '../ui';
import type { FsEntry, MachineCaps, WorkspaceEntity, WorkspaceGroupMeta } from '../types';

export type ProjectDrawerMode = 'project' | 'group';

interface Props {
  open: boolean;
  initialMode: ProjectDrawerMode;
  presetGroup?: string;
  editEntity?: WorkspaceEntity | null;
  editGroup?: string | null;
  groups: string[];
  groupMeta: Record<string, WorkspaceGroupMeta>;
  entities: WorkspaceEntity[];
  onClose: () => void;
  onProjectSaved: (entity: WorkspaceEntity, isEdit: boolean) => void;
  onGroupSaved: (groupName: string, renamedFrom?: string) => void;
  onNotify: (msg: string, err?: boolean) => void;
}

function joinSubPath(base: string, rel: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  const cleanRel = rel.replace(/[\\/]+/g, sep).replace(new RegExp(`^\\${sep}+`), '');
  return `${base.replace(/[\\/]+$/, '')}${sep}${cleanRel}`;
}

function slugifySubfolder(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'novo-projeto';
}

export function NewProjectDrawer({
  open,
  initialMode,
  presetGroup = '',
  editEntity = null,
  editGroup = null,
  groups,
  groupMeta,
  entities,
  onClose,
  onProjectSaved,
  onGroupSaved,
  onNotify,
}: Props) {
  const isEditingEntity = !!editEntity;
  const isEditingGroup = !!editGroup;
  const [mode, setMode] = useState<ProjectDrawerMode>(initialMode);
  const [caps, setCaps] = useState<MachineCaps[]>([]);
  const [loadingCaps, setLoadingCaps] = useState(false);

  // Estado de projeto
  const [machine, setMachine] = useState('');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [desc, setDesc] = useState('');
  const [group, setGroup] = useState(presetGroup);
  const [template, setTemplate] = useState('board');

  // Navegação restrita de subpastas quando o workspace escolhido possui rootCwd
  const [subRel, setSubRel] = useState('');
  const [subDirs, setSubDirs] = useState<FsEntry[]>([]);
  const [subLoading, setSubLoading] = useState(false);
  const [subQuery, setSubQuery] = useState('');
  const [newSubName, setNewSubName] = useState('');
  const [creatingSub, setCreatingSub] = useState(false);
  const [subReloadKey, setSubReloadKey] = useState(0);

  // Combobox customizado de workspace (lista ocupa 100% da largura do combobox)
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const comboRef = useRef<HTMLDivElement | null>(null);

  // Estado de workspace (com pasta raiz opcional)
  const [newGroupName, setNewGroupName] = useState('');
  const [groupNameTouched, setGroupNameTouched] = useState(false);
  const [wsMachine, setWsMachine] = useState('');
  const [wsRootCwd, setWsRootCwd] = useState('');

  const [submitting, setSubmitting] = useState(false);

  const activeGroupMeta = group.trim() ? groupMeta[group.trim()] : undefined;
  const restrictedRoot = activeGroupMeta?.rootCwd ? activeGroupMeta.rootCwd.trim() : '';
  const restrictedMachine = activeGroupMeta?.machine || machine;

  useEffect(() => {
    if (!open) return;
    setMode(editEntity ? 'project' : editGroup ? 'group' : initialMode);
    setSubRel('');
    setSubQuery('');
    setNewSubName('');
    setGroupMenuOpen(false);
    if (editEntity) {
      setTitle(editEntity.title || '');
      setTitleTouched(true);
      setDesc(editEntity.description || '');
      setGroup(editEntity.group || '');
      setTemplate('board');
    } else {
      setGroup(presetGroup || '');
      setTitle('');
      setTitleTouched(false);
      setDesc('');
      setTemplate('board');
    }

    if (editGroup) {
      const gm = groupMeta[editGroup];
      setNewGroupName(editGroup);
      setGroupNameTouched(true);
      setWsMachine(gm?.machine || '');
      setWsRootCwd(gm?.rootCwd || '');
    } else {
      setNewGroupName('');
      setGroupNameTouched(false);
      setWsMachine('');
      setWsRootCwd('');
    }

    setLoadingCaps(true);
    api.getCapabilities()
      .then((r) => {
        const list = orderMachines(r.machines || []);
        setCaps(list);
        const first = list.find((m) => m.online) || list[0];
        const gmEdit = editGroup ? groupMeta[editGroup] : undefined;
        if (first && !gmEdit?.machine) setWsMachine(first.name);

        const existingBinding = editEntity?.projectBindings?.[0];
        if (existingBinding) {
          setMachine(existingBinding.machine || first?.name || '');
          setCwd(existingBinding.cwd || '');
        } else {
          const gmPreset = presetGroup ? groupMeta[presetGroup] : undefined;
          if (gmPreset?.rootCwd) {
            setMachine(gmPreset.machine || first?.name || '');
            setCwd('');
          } else if (first) {
            setMachine(first.name);
            setCwd(editEntity ? '' : (first.pinned?.[0] || first.cwds?.[0] || ''));
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingCaps(false));
  }, [open, initialMode, presetGroup, editEntity, editGroup, groupMeta]);

  // Carrega subpastas sempre que um workspace com rootCwd estiver selecionado no modo projeto
  useEffect(() => {
    if (!open || mode !== 'project' || !restrictedRoot) {
      setSubDirs([]);
      return;
    }
    if (activeGroupMeta?.machine && activeGroupMeta.machine !== machine) {
      setMachine(activeGroupMeta.machine);
    }
    // Se o cwd atual não estiver dentro de restrictedRoot, limpa para obrigar escolha de subpasta válida
    const normRoot = restrictedRoot.replace(/[\\/]+$/, '').toLowerCase();
    const normCwd = cwd.replace(/[\\/]+$/, '').toLowerCase();
    if (normCwd && (!normCwd.startsWith(normRoot + '\\') && !normCwd.startsWith(normRoot + '/'))) {
      setCwd('');
    }

    let alive = true;
    setSubLoading(true);
    api.listFiles(restrictedRoot, subRel, activeGroupMeta?.machine || machine)
      .then((r) => {
        if (!alive) return;
        setSubDirs((r.entries || []).filter((e) => e.type === 'dir'));
      })
      .catch((e) => {
        if (!alive) return;
        setSubDirs([]);
        onNotify((e as Error).message, true);
      })
      .finally(() => { if (alive) setSubLoading(false); });
    return () => { alive = false; };
  }, [open, mode, restrictedRoot, subRel, activeGroupMeta?.machine, machine, subReloadKey]);

  useEffect(() => {
    if (!groupMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setGroupMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [groupMenuOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function handleSelectCwd(next: string) {
    setCwd(next);
    if (!titleTouched && next.trim()) {
      setTitle(shortFolderName(next));
    }
  }

  function handleSelectWsRoot(next: string) {
    setWsRootCwd(next);
    if (!groupNameTouched && next.trim()) {
      setNewGroupName(shortFolderName(next));
    }
  }

  async function handleCreateSubfolder() {
    if (!restrictedRoot || creatingSub) return;
    const raw = newSubName.trim();
    if (!raw) return onNotify('Informe o nome da nova subpasta.', true);
    const rel = subRel ? `${subRel}/${raw}` : raw;
    const targetMachine = activeGroupMeta?.machine || machine;
    setCreatingSub(true);
    try {
      const r = await api.mkdir({ cwd: restrictedRoot, name: rel, machine: targetMachine });
      setNewSubName('');
      handleSelectCwd(r.path);
      setSubReloadKey((k) => k + 1);
      onNotify(`Subpasta "${raw}" criada.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setCreatingSub(false);
    }
  }

  async function submitProject() {
    const cleanTitle = title.trim();
    if (!cleanTitle) return onNotify('Informe o nome do projeto.', true);
    if (submitting) return;
    setSubmitting(true);
    try {
      const targetMachine = restrictedRoot ? (activeGroupMeta?.machine || machine) : machine;
      let finalCwd = cwd.trim();
      // Se o workspace tem pasta raiz (ex.: VPS sem subpastas) e nenhuma subpasta foi selecionada, cria automaticamente a subpasta
      if (restrictedRoot && !finalCwd) {
        const autoFolder = newSubName.trim() || slugifySubfolder(cleanTitle);
        const rel = subRel ? `${subRel}/${autoFolder}` : autoFolder;
        const mk = await api.mkdir({ cwd: restrictedRoot, name: rel, machine: targetMachine });
        finalCwd = mk.path;
      }
      const bindings = targetMachine && finalCwd ? [{ machine: targetMachine, cwd: finalCwd }] : [];
      if (editEntity) {
        const r = await api.updateEntity({
          id: editEntity.id,
          title: cleanTitle,
          description: desc.trim(),
          group: group.trim(),
          projectBindings: bindings,
        });
        onProjectSaved(r.entity, true);
      } else {
        const r = await api.createEntity({
          title: cleanTitle,
          description: desc.trim(),
          group: group.trim(),
          template,
          projectBindings: bindings,
        });
        onProjectSaved(r.entity, false);
      }
      onClose();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitGroup() {
    const clean = newGroupName.trim();
    if (!clean) return onNotify('Informe o nome do workspace.', true);
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.saveGroup({
        ...(editGroup ? { renameFrom: editGroup } : {}),
        name: clean,
        machine: wsRootCwd.trim() ? wsMachine : '',
        rootCwd: wsRootCwd.trim(),
      });
      onGroupSaved(clean, editGroup || undefined);
      onClose();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const visibleSubDirs = subQuery.trim()
    ? subDirs.filter((d) => d.name.toLowerCase().includes(subQuery.trim().toLowerCase()))
    : subDirs;

  const groupQuery = group.trim().toLowerCase();
  const filteredGroups = groupQuery && !groups.some((g) => g.toLowerCase() === groupQuery)
    ? groups.filter((g) => g.toLowerCase().includes(groupQuery))
    : groups;
  const autoSubfolderPreview = restrictedRoot && !cwd.trim() && (newSubName.trim() || title.trim())
    ? joinSubPath(restrictedRoot, subRel ? `${subRel}/${newSubName.trim() || slugifySubfolder(title)}` : (newSubName.trim() || slugifySubfolder(title)))
    : '';

  const drawerTitle = isEditingEntity
    ? 'Editar projeto'
    : isEditingGroup
      ? 'Editar workspace'
      : mode === 'project'
        ? 'Novo projeto'
        : 'Novo workspace';

  const drawerSubtitle = mode === 'project'
    ? 'Configure o workspace, a pasta do código e os detalhes do projeto'
    : 'Agrupe projetos relacionados e, opcionalmente, defina uma pasta raiz';

  const modeSubHeader = !isEditingEntity && !isEditingGroup ? (
    <div style={{ padding: '10px 16px 0', flexShrink: 0 }}>
      <div className="seg" style={{ width: '100%' }}>
        <button
          type="button"
          className={mode === 'project' ? 'on' : ''}
          style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 10px' }}
          onClick={() => setMode('project')}
        >
          <FolderKanban size={13} /> Novo Projeto
        </button>
        <button
          type="button"
          className={mode === 'group' ? 'on' : ''}
          style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 10px' }}
          onClick={() => setMode('group')}
        >
          <Layers size={13} /> Novo Workspace
        </button>
      </div>
    </div>
  ) : undefined;

  const drawerFooter = mode === 'project' ? (
    <>
      <Button onClick={onClose}>Cancelar</Button>
      <Button
        variant="primary"
        style={{ flex: 1 }}
        disabled={submitting || !title.trim()}
        onClick={submitProject}
      >
        {isEditingEntity ? <Save size={14} /> : <Plus size={14} />}
        {submitting ? 'Salvando…' : isEditingEntity ? 'Salvar alterações' : 'Criar projeto'}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Cancelar</Button>
      <Button
        variant="primary"
        style={{ flex: 1 }}
        disabled={submitting || !newGroupName.trim()}
        onClick={submitGroup}
      >
        {isEditingGroup ? <Save size={14} /> : <Layers size={14} />}
        {submitting ? 'Salvando…' : isEditingGroup ? 'Salvar workspace' : 'Criar workspace'}
      </Button>
    </>
  );

  return (
    <DrawerFrame
      open={open}
      side="left"
      ariaLabel="Projeto ou workspace"
      title={drawerTitle}
      subtitle={drawerSubtitle}
      subHeader={modeSubHeader}
      footer={drawerFooter}
      onClose={onClose}
    >
      {mode === 'project' ? (
        <>
              {/* 1. Workspace primeiro (combobox customizado com lista na largura exata do campo) */}
              <div className="field" style={{ marginBottom: 0 }}>
                <label>1. Workspace (ex.: TRT, Jogos)</label>
                <div className="ws-combo" ref={comboRef}>
                  <input
                    className="inp"
                    style={{ paddingRight: 34 }}
                    value={group}
                    onFocus={() => setGroupMenuOpen(true)}
                    onChange={(e) => { setGroup(e.target.value); setSubRel(''); setGroupMenuOpen(true); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.stopPropagation(); setGroupMenuOpen(false); }
                    }}
                    placeholder="Escolha ou digite um workspace (opcional)…"
                    role="combobox"
                    aria-expanded={groupMenuOpen}
                    aria-autocomplete="list"
                  />
                  <button
                    type="button"
                    className="ws-combo-toggle"
                    tabIndex={-1}
                    aria-label="Abrir lista de workspaces"
                    onClick={() => setGroupMenuOpen((v) => !v)}
                  >
                    <ChevronDown size={15} />
                  </button>
                  {groupMenuOpen && (
                    <div className="ws-combo-menu" role="listbox">
                      {group.trim() && (
                        <button
                          type="button"
                          className="ws-combo-opt"
                          style={{ color: 'var(--muted)' }}
                          onClick={() => { setGroup(''); setSubRel(''); setGroupMenuOpen(false); }}
                        >
                          <X size={12} /> Sem workspace
                        </button>
                      )}
                      {filteredGroups.map((g) => {
                        const meta = groupMeta[g];
                        const isSel = group === g;
                        return (
                          <button
                            key={g}
                            type="button"
                            role="option"
                            aria-selected={isSel}
                            className={`ws-combo-opt ${isSel ? 'active' : ''}`}
                            onClick={() => { setGroup(g); setSubRel(''); setGroupMenuOpen(false); }}
                          >
                            <span style={{ flexShrink: 0 }}>{meta?.rootCwd ? '🔒' : '📁'}</span>
                            <span className="ell" style={{ flex: 1 }}>{g}</span>
                            {meta?.rootCwd && (
                              <span className="mono ell" style={{ fontSize: 10.5, color: 'var(--muted)', maxWidth: 165 }}>
                                {meta.machine ? `${meta.machine} · ` : ''}{shortFolderName(meta.rootCwd)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {group.trim() && !groups.some((g) => g.toLowerCase() === group.trim().toLowerCase()) && (
                        <button
                          type="button"
                          className="ws-combo-opt"
                          style={{ color: 'var(--accent)' }}
                          onClick={() => setGroupMenuOpen(false)}
                        >
                          <Plus size={12} /> Usar novo workspace "{group.trim()}"
                        </button>
                      )}
                      {filteredGroups.length === 0 && !group.trim() && (
                        <div style={{ padding: '7px 9px', fontSize: 12, color: 'var(--muted)' }}>
                          Nenhum workspace criado ainda. Digite um nome acima.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Pasta do projeto: restrita às subpastas se o workspace tiver rootCwd; livre caso contrário */}
              {restrictedRoot ? (
                <div className="field" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                    <label style={{ margin: 0 }}>2. Subpasta do projeto</label>
                    {subRel && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSubRel(subRel.split('/').slice(0, -1).join('/'))}
                      >
                        ↑ Subir
                      </button>
                    )}
                  </div>
                  <div
                    className="card-item"
                    style={{ marginBottom: 6, padding: '7px 10px', borderColor: 'rgba(95, 184, 164, .35)', background: 'rgba(95, 184, 164, .07)' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                      <FolderLock size={13} color="var(--accent)" />
                      <span className="mono ell" style={{ flex: 1 }}>
                        {restrictedRoot}{subRel ? `/${subRel}` : ''}
                      </span>
                      {restrictedMachine && <span className="badge" style={{ fontSize: 10 }}>{restrictedMachine}</span>}
                    </div>
                  </div>
                  {subDirs.length > 4 && (
                    <input
                      className="sb-search"
                      style={{ width: '100%', marginBottom: 6 }}
                      value={subQuery}
                      onChange={(e) => setSubQuery(e.target.value)}
                      placeholder="Filtrar subpastas…"
                    />
                  )}
                  <div className="folder-list">
                    {subLoading ? (
                      <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>Carregando subpastas…</div>
                    ) : visibleSubDirs.length === 0 ? (
                      <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>
                        Nenhuma subpasta existente aqui. Crie uma abaixo ou informe o nome do projeto para criar automaticamente.
                      </div>
                    ) : (
                      visibleSubDirs.map((d) => {
                        const fullPath = joinSubPath(restrictedRoot, d.path);
                        const isSel = cwd.toLowerCase() === fullPath.toLowerCase();
                        return (
                          <div key={d.path} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            <button
                              type="button"
                              className={`folder-row ${isSel ? 'active' : ''}`}
                              style={{ flex: 1, minWidth: 0 }}
                              onClick={() => handleSelectCwd(fullPath)}
                              title={fullPath}
                            >
                              {isSel ? <FolderOpen size={14} color="var(--accent)" style={{ flexShrink: 0 }} /> : <Folder size={14} color="var(--warn)" style={{ flexShrink: 0 }} />}
                              <span className="ell">{d.name}</span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-icon"
                              style={{ border: 0, background: 'transparent' }}
                              title="Abrir subpastas"
                              onClick={() => setSubRel(d.path)}
                            >
                              <ChevronRight size={13} color="var(--muted)" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input
                      className="inp mono"
                      style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '6px 9px' }}
                      value={newSubName}
                      disabled={creatingSub}
                      onChange={(e) => setNewSubName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleCreateSubfolder(); }
                      }}
                      placeholder="Nova subpasta (opcional, ex.: meu-app)…"
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={creatingSub || !newSubName.trim()}
                      onClick={handleCreateSubfolder}
                      title="Criar subpasta agora nesta máquina"
                    >
                      <FolderPlus size={13} /> {creatingSub ? 'Criando…' : 'Criar pasta'}
                    </button>
                  </div>
                  {cwd ? (
                    <div className="mono ell" style={{ fontSize: 11, color: 'var(--accent)', marginTop: 5 }}>
                      Selecionada: {cwd}
                    </div>
                  ) : autoSubfolderPreview ? (
                    <div className="mono ell" style={{ fontSize: 11, color: 'var(--accent)', marginTop: 5 }}>
                      Será criada ao salvar: {autoSubfolderPreview}
                    </div>
                  ) : null}
                </div>
              ) : (
                <FolderPicker
                  caps={caps}
                  loadingCaps={loadingCaps}
                  machine={machine}
                  cwd={cwd}
                  entities={entities}
                  labelMachine="2. Máquina do código"
                  labelFolder="3. Pasta do projeto (opcional)"
                  allowEmpty
                  onChangeMachine={(m, nextCwd) => { setMachine(m); handleSelectCwd(nextCwd); }}
                  onChangeCwd={handleSelectCwd}
                  onCapsUpdated={setCaps}
                  onNotify={onNotify}
                />
              )}

              <div className="field" style={{ marginBottom: 0 }}>
                <label>Nome do projeto</label>
                <input
                  className="inp"
                  value={title}
                  onChange={(e) => { setTitleTouched(true); setTitle(e.target.value); }}
                  placeholder="Ex.: PJe Automação, Astra Dodge…"
                />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>Descrição curta</label>
                <input
                  className="inp"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Objetivo principal do projeto…"
                />
              </div>

              {!isEditingEntity && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Visão inicial do card</label>
                  <select className="sel" value={template} onChange={(e) => setTemplate(e.target.value)}>
                    <option value="board">Board (Kanban: Ideia / Em andamento / Revisão / Concluído)</option>
                    <option value="research">Research (Lista rica com notas e links)</option>
                    <option value="gallery">Gallery (Grade visual com imagens e prompts)</option>
                  </select>
                </div>
              )}
        </>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>1. Nome do workspace</label>
            <input
              className="inp"
              autoFocus
              value={newGroupName}
              onChange={(e) => { setGroupNameTouched(true); setNewGroupName(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitGroup(); }}
              placeholder="Ex.: TRT, Jogos, Infraestrutura…"
            />
          </div>

          <FolderPicker
            caps={caps}
            loadingCaps={loadingCaps}
            machine={wsMachine}
            cwd={wsRootCwd}
            entities={entities}
            labelMachine="2. Máquina da pasta raiz (opcional)"
            labelFolder="Pasta raiz do workspace (opcional)"
            allowEmpty
            onChangeMachine={(m) => setWsMachine(m)}
            onChangeCwd={handleSelectWsRoot}
            onCapsUpdated={setCaps}
            onNotify={onNotify}
          />

          <div style={{ fontSize: 12, color: 'var(--ds-muted)', lineHeight: 1.5 }}>
            {wsRootCwd.trim()
              ? <>🔒 Com pasta raiz definida, projetos criados neste workspace só poderão selecionar <b>subpastas</b> de <code className="mono">{wsRootCwd.trim()}</code>.</>
              : 'Se você selecionar uma pasta raiz acima, apenas subpastas dela poderão ser escolhidas como projetos deste workspace.'}
          </div>
        </>
      )}
    </DrawerFrame>
  );
}
