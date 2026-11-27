import { useEffect, useMemo, useState } from 'react';
import { FolderLock, Send } from 'lucide-react';
import { api } from '../api';
import { FolderPicker, orderMachines } from './FolderPicker';
import { Badge, Button, DrawerFrame, ToolIcon } from '../ui';
import type { MachineCaps, Snapshot, WorkspaceEntity } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  defaultBinding?: { machine: string; cwd: string } | null;
  lockedProject?: { title: string; machine: string; cwd: string } | null;
  entities: WorkspaceEntity[];
  snapshot: Snapshot | null;
  initialPrompt?: string;
  onCreated: (sessionId?: string, meta?: { tool: string; machine: string; cwd: string }) => void;
  onNotify: (msg: string, err?: boolean) => void;
}

const AI_META: { id: string; label: string; color: string; quotaKey?: 'claude' | 'codex' | 'gemini' }[] = [
  { id: 'Claude Code', label: 'Claude Code', color: 'var(--ds-claude)', quotaKey: 'claude' },
  { id: 'Codex', label: 'Codex', color: 'var(--ds-codex)', quotaKey: 'codex' },
  { id: 'Gemini', label: 'Gemini (agy)', color: 'var(--ds-gemini)', quotaKey: 'gemini' },
  { id: 'Ollama', label: 'Ollama Local', color: 'var(--ds-ollama)' },
];

export function NewSessionDrawer({
  open,
  onClose,
  defaultBinding,
  lockedProject = null,
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
  const [tool, setTool] = useState('Claude Code');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const effectiveBinding = lockedProject
    ? { machine: lockedProject.machine, cwd: lockedProject.cwd }
    : defaultBinding;

  useEffect(() => {
    if (!open) return;
    setPrompt(initialPrompt || '');
    setLoadingCaps(true);
    api.getCapabilities()
      .then((r) => {
        const list = orderMachines(r.machines || []);
        setCaps(list);
        const preferred = (effectiveBinding?.machine && list.find((m) => m.name === effectiveBinding.machine))
          || list.find((m) => m.online)
          || list[0];
        if (preferred) {
          setMachine(lockedProject?.machine || preferred.name);
          setCwd(lockedProject?.cwd || effectiveBinding?.cwd || preferred.pinned?.[0] || preferred.cwds?.[0] || '');
          const availTool = AI_META.find((a) => preferred.tools?.[a.id])?.id || 'Claude Code';
          setTool(availTool);
        } else if (lockedProject) {
          setMachine(lockedProject.machine);
          setCwd(lockedProject.cwd);
        }
      })
      .catch((e) => onNotify((e as Error).message, true))
      .finally(() => setLoadingCaps(false));
  }, [open, lockedProject?.machine, lockedProject?.cwd, effectiveBinding?.machine, effectiveBinding?.cwd, initialPrompt, onNotify]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const currentMachine = useMemo(() => caps.find((m) => m.name === machine) || caps[0] || null, [caps, machine]);
  const models = useMemo(() => currentMachine?.tools?.[tool]?.models || [], [currentMachine, tool]);

  useEffect(() => {
    if (models.length && !models.some((m) => m.id === model)) setModel(models[0].id);
    if (!models.length) setModel('');
  }, [models, model]);

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
      onCreated(r.id || undefined, {
        tool: r.tool || tool,
        machine: r.machine || currentMachine?.name || '',
        cwd: cwd.trim(),
      });
      onClose();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <DrawerFrame
      open={open}
      side="right"
      ariaLabel="Nova conversa com IA"
      title={lockedProject ? `Nova conversa · ${lockedProject.title}` : 'Nova conversa com IA'}
      subtitle={
        lockedProject
          ? 'Projeto fixado — escolha o agente e envie a mensagem inicial'
          : 'Escolha a máquina, a pasta do projeto e o agente'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            style={{ flex: 1 }}
            disabled={submitting || !prompt.trim()}
            onClick={launch}
          >
            <Send size={14} /> {submitting ? 'Iniciando sessão…' : `Iniciar com ${tool}`}
          </Button>
        </>
      }
    >
      {lockedProject ? (
        <div
          className="card-item"
          style={{ marginBottom: 0, borderColor: 'rgba(95, 184, 164, .4)', background: 'var(--ds-accent-soft)' }}
        >
          <div className="ds-row" style={{ gap: 7, marginBottom: 4 }}>
            <FolderLock size={14} color="var(--ds-accent)" />
            <strong style={{ fontSize: 13.5 }}>{lockedProject.title}</strong>
            {lockedProject.machine && <Badge style={{ marginLeft: 'auto' }}>{lockedProject.machine}</Badge>}
          </div>
          <div className="mono ell" style={{ fontSize: 11.5, color: 'var(--ds-muted)' }} title={lockedProject.cwd}>
            {lockedProject.cwd || '(sem pasta vinculada)'}
          </div>
        </div>
      ) : (
        <FolderPicker
          caps={caps}
          loadingCaps={loadingCaps}
          machine={machine}
          cwd={cwd}
          entities={entities}
          labelMachine="1. Máquina"
          labelFolder="2. Pasta do projeto (CWD)"
          onChangeMachine={(m, nextCwd) => { setMachine(m); setCwd(nextCwd); }}
          onChangeCwd={setCwd}
          onCapsUpdated={setCaps}
          onNotify={onNotify}
        />
      )}

      <div className="field" style={{ marginBottom: 0 }}>
        <label>{lockedProject ? '1. Inteligência Artificial' : '3. Inteligência Artificial'}</label>
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
                <div className="ds-row" style={{ gap: 7 }}>
                  <ToolIcon tool={ai.id} size={13} />
                  <strong style={{ fontSize: 13 }}>{ai.label}</strong>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--ds-muted)' }}>
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

      {models.length > 0 && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>{lockedProject ? '2. Modelo' : '4. Modelo'}</label>
          <select className="sel" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      <div className="field" style={{ marginBottom: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <label>{lockedProject ? (models.length ? '3. Mensagem inicial' : '2. Mensagem inicial') : '5. Mensagem inicial'}</label>
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
    </DrawerFrame>
  );
}
