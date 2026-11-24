import { useEffect, useState } from 'react';
import { FolderKanban, Layers, Plus, X } from 'lucide-react';
import { api } from '../api';
import { FolderPicker, shortFolderName } from './FolderPicker';
import type { MachineCaps, WorkspaceEntity } from '../types';

export type ProjectDrawerMode = 'project' | 'group';

interface Props {
  open: boolean;
  initialMode: ProjectDrawerMode;
  presetGroup?: string;
  groups: string[];
  entities: WorkspaceEntity[];
  onClose: () => void;
  onProjectCreated: (entity: WorkspaceEntity) => void;
  onGroupCreated: (groupName: string) => void;
  onNotify: (msg: string, err?: boolean) => void;
}

export function NewProjectDrawer({
  open,
  initialMode,
  presetGroup = '',
  groups,
  entities,
  onClose,
  onProjectCreated,
  onGroupCreated,
  onNotify,
}: Props) {
  const [mode, setMode] = useState<ProjectDrawerMode>(initialMode);
  const [caps, setCaps] = useState<MachineCaps[]>([]);
  const [loadingCaps, setLoadingCaps] = useState(false);
  const [machine, setMachine] = useState('');
  const [cwd, setCwd] = useState('');

  // Campos de projeto
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [desc, setDesc] = useState('');
  const [group, setGroup] = useState(presetGroup);
  const [template, setTemplate] = useState('board');

  // Campos de englobador (workspace)
  const [newGroupName, setNewGroupName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setGroup(presetGroup || '');
    setTitle('');
    setTitleTouched(false);
    setDesc('');
    setTemplate('board');
    setNewGroupName('');

    setLoadingCaps(true);
    api.getCapabilities()
      .then((r) => {
        const list = r.machines || [];
        setCaps(list);
        const first = list.find((m) => m.online) || list[0];
        if (first) {
          setMachine(first.name);
          setCwd(first.pinned?.[0] || first.cwds?.[0] || '');
        }
      })
      .catch(() => {})
      .finally(() => setLoadingCaps(false));
  }, [open, initialMode, presetGroup]);

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

  async function submitProject() {
    const cleanTitle = title.trim();
    if (!cleanTitle) return onNotify('Informe o nome do projeto.', true);
    if (submitting) return;
    setSubmitting(true);
    try {
      const bindings = machine && cwd.trim() ? [{ machine, cwd: cwd.trim() }] : [];
      const r = await api.createEntity({
        title: cleanTitle,
        description: desc.trim(),
        group: group.trim(),
        template,
        projectBindings: bindings,
      });
      onProjectCreated(r.entity);
      onClose();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitGroup() {
    const clean = newGroupName.trim();
    if (!clean) return onNotify('Informe o nome do englobador (workspace).', true);
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.saveGroup({ name: clean });
      onGroupCreated(clean);
      onClose();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="side-drawer-bg" onClick={onClose}>
      <aside className="side-drawer" onClick={(e) => e.stopPropagation()} aria-label="Criar projeto ou englobador">
        <div className="side-drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>
              {mode === 'project' ? 'Novo projeto' : 'Novo englobador (Workspace)'}
            </h3>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {mode === 'project'
                ? 'Escolha a pasta do código e organize dentro de um englobador'
                : 'Agrupe vários projetos relacionados (ex.: TRT, Jogos, Pessoal)'}
            </div>
          </div>
          <button className="btn btn-sm btn-icon" onClick={onClose} title="Fechar (Esc)">
            <X size={16} />
          </button>
        </div>

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

        {mode === 'project' ? (
          <>
            <div className="side-drawer-body">
              <FolderPicker
                caps={caps}
                loadingCaps={loadingCaps}
                machine={machine}
                cwd={cwd}
                entities={entities}
                labelMachine="1. Máquina do código"
                labelFolder="2. Pasta do projeto (opcional)"
                allowEmpty
                onChangeMachine={(m, nextCwd) => { setMachine(m); handleSelectCwd(nextCwd); }}
                onChangeCwd={handleSelectCwd}
                onCapsUpdated={setCaps}
                onNotify={onNotify}
              />

              <div className="field" style={{ marginBottom: 0 }}>
                <label>3. Englobador / Workspace (ex.: TRT, Jogos)</label>
                <input
                  className="inp"
                  list="wsDrawerGroupList"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder="Escolha ou digite um novo englobador…"
                />
                <datalist id="wsDrawerGroupList">
                  {groups.map((g) => <option key={g} value={g} />)}
                </datalist>
                {groups.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                    {groups.map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`btn btn-sm ${group === g ? 'btn-primary' : ''}`}
                        onClick={() => setGroup(group === g ? '' : g)}
                      >
                        📁 {g}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>4. Nome do projeto</label>
                <input
                  className="inp"
                  value={title}
                  onChange={(e) => { setTitleTouched(true); setTitle(e.target.value); }}
                  placeholder="Ex.: PJe Automação, Astra Dodge…"
                />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>5. Descrição curta</label>
                <input
                  className="inp"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Objetivo principal do projeto…"
                />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>6. Visão inicial do card</label>
                <select className="sel" value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="board">Board (Kanban: Ideia / Em andamento / Revisão / Concluído)</option>
                  <option value="research">Research (Lista rica com notas e links)</option>
                  <option value="gallery">Gallery (Grade visual com imagens e prompts)</option>
                </select>
              </div>
            </div>

            <div className="side-drawer-foot">
              <button className="btn" onClick={onClose}>Cancelar</button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={submitting || !title.trim()}
                onClick={submitProject}
              >
                <Plus size={14} /> {submitting ? 'Criando…' : 'Criar projeto'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="side-drawer-body">
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Nome do englobador (Workspace)</label>
                <input
                  className="inp"
                  autoFocus
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitGroup(); }}
                  placeholder="Ex.: TRT, Jogos, Infraestrutura…"
                />
              </div>

              {groups.length > 0 && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Englobadores já existentes ({groups.length})</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {groups.map((g) => (
                      <span key={g} className="badge" style={{ padding: '4px 10px', fontSize: 12 }}>📁 {g}</span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                Depois de criar o englobador, clique no botão <b>+</b> ao lado dele na barra esquerda para adicionar projetos ou mova projetos existentes usando o seletor no cabeçalho.
              </div>
            </div>

            <div className="side-drawer-foot">
              <button className="btn" onClick={onClose}>Cancelar</button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={submitting || !newGroupName.trim()}
                onClick={submitGroup}
              >
                <Layers size={14} /> {submitting ? 'Criando…' : 'Criar englobador'}
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
