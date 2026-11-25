import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ExternalLink,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, EmptyState, Field, ModalFrame, StatusDot } from '../ui';
import type { ProjectRunConfig, ProjectRunStatus, RunProcessSpec, RunProfile } from '../types';

interface Props {
  cwd: string;
  machine?: string;
  projectTitle?: string;
  refreshKey?: number;
  onNotify: (msg: string, err?: boolean) => void;
}

const KIND_LABELS: Record<RunProfile['kind'], string> = {
  compound: 'Composto (Front + Back)',
  web: 'Web / Servidor',
  gui: 'Jogo / App Gráfico (GUI)',
  service: 'Serviço / Backend',
  script: 'Script / Executável',
};

function makeEmptyProfile(idx: number): RunProfile {
  return {
    id: `perfil-${Date.now().toString(36)}-${idx}`,
    name: `Novo perfil ${idx}`,
    kind: 'service',
    processes: [{ id: 'main', name: 'App', cmd: '' }],
  };
}

export function ProjectRunControl({ cwd, machine = '', projectTitle = '', refreshKey = 0, onNotify }: Props) {
  const [runCfg, setRunCfg] = useState<ProjectRunConfig | null>(null);
  const [detectedCfg, setDetectedCfg] = useState<ProjectRunConfig | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [status, setStatus] = useState<ProjectRunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiConfiguring, setAiConfiguring] = useState(false);

  // Modais
  const [logsOpen, setLogsOpen] = useState(false);
  const [activeProcId, setActiveProcId] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [draftCfg, setDraftCfg] = useState<ProjectRunConfig | null>(null);
  const [editProfileIdx, setEditProfileIdx] = useState(0);
  const [savingCfg, setSavingCfg] = useState(false);

  const logEndRef = useRef<HTMLDivElement | null>(null);

  async function loadAll() {
    if (!cwd) return;
    try {
      const [cfgRes, stRes] = await Promise.all([
        api.getRunConfig(cwd, machine),
        api.getRunStatus(cwd, machine).catch(() => null),
      ]);
      setRunCfg(cfgRes.config);
      setDetectedCfg(cfgRes.detected);
      setSelectedProfileId((prev) => {
        if (prev && cfgRes.config.profiles.some((p) => p.id === prev)) return prev;
        return cfgRes.config.defaultProfile || cfgRes.config.profiles[0]?.id || '';
      });
      if (stRes) setStatus(stRes);
    } catch {
      setRunCfg(null);
      setStatus(null);
    }
  }

  useEffect(() => {
    setLogsOpen(false);
    setConfigOpen(false);
    setStatus(null);
    setSelectedProfileId('');
    loadAll();
  }, [cwd, machine]);

  useEffect(() => {
    if (refreshKey > 0) loadAll();
  }, [refreshKey]);

  // Polling leve enquanto há processo rodando ou modal de logs aberto
  useEffect(() => {
    if (!cwd || (!status?.running && !logsOpen)) return;
    const timer = window.setInterval(() => {
      api.getRunStatus(cwd, machine).then((r) => setStatus(r)).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [cwd, machine, status?.running, logsOpen]);

  // Seleciona automaticamente a 1ª aba de processo no modal de logs
  useEffect(() => {
    if (!status?.processes?.length) return;
    if (!activeProcId || !status.processes.some((p) => p.id === activeProcId)) {
      setActiveProcId(status.processes[0].id);
    }
  }, [status?.processes, activeProcId]);

  useEffect(() => {
    if (logsOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ block: 'end' });
    }
  }, [logsOpen, status]);

  const profiles = runCfg?.profiles || [];
  const activeProfile = profiles.find((p) => p.id === selectedProfileId) || profiles[0] || null;
  const isRunning = !!status?.running;
  const totalCount = status?.processes?.length || 0;
  const readyCount = (status?.processes || []).filter((p) => p.status === 'running' && p.ready).length;
  const allReady = !!status?.allReady;
  const bootState = status?.bootState || (isRunning ? 'starting' : 'stopped');
  const primaryOpenUrl = allReady ? (status?.openUrl || '') : '';
  const expectsWebUrl = useMemo(() => {
    if (!status) return false;
    if (status.openUrl) return true;
    if (status.kind === 'web' || status.kind === 'compound') return true;
    return (status.processes || []).some((p) => p.expectsUrl || (p.detectedUrls && p.detectedUrls.length > 0));
  }, [status]);
  const allReachableUrls = useMemo(() => {
    if (!allReady) return [];
    const out: string[] = [];
    for (const p of status?.processes || []) {
      for (const u of p.reachableUrls || []) {
        if (!out.includes(u)) out.push(u);
      }
    }
    if (primaryOpenUrl && !out.includes(primaryOpenUrl)) out.unshift(primaryOpenUrl);
    return out;
  }, [status, allReady, primaryOpenUrl]);

  async function handleAiAutoConfigure() {
    if (!cwd || aiConfiguring) return;
    setAiConfiguring(true);
    onNotify('Configurando Play via IA e validando inicialização…');
    try {
      const r = await api.autoConfigureRun({ cwd, machine, project: projectTitle, force: true });
      setRunCfg(r.config);
      setDraftCfg(JSON.parse(JSON.stringify(r.config)));
      setEditProfileIdx(0);
      setSelectedProfileId(r.config.defaultProfile || r.config.profiles[0]?.id || '');
      if (r.bootOk) {
        onNotify(`Play configurado${r.engine ? ` (${r.engine}${r.model ? '/' + r.model : ''})` : ''} e validado sem erros!`);
      } else {
        onNotify(`Play salvo, mas houve erro ao subir: ${r.bootError || 'verifique os logs'}`, true);
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setAiConfiguring(false);
    }
  }

  function openConfigModal() {
    const base: ProjectRunConfig = runCfg && runCfg.profiles.length > 0
      ? JSON.parse(JSON.stringify(runCfg))
      : { format: 'ai-run', version: 1, defaultProfile: '', profiles: [makeEmptyProfile(1)] };
    setDraftCfg(base);
    const idx = Math.max(0, base.profiles.findIndex((p) => p.id === selectedProfileId));
    setEditProfileIdx(idx);
    setConfigOpen(true);
  }

  async function handleStart(profileIdOverride?: string) {
    const targetId = profileIdOverride || activeProfile?.id || '';
    if (!targetId) {
      openConfigModal();
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.startRun({ cwd, machine, profileId: targetId });
      setStatus(r);
      onNotify(`Iniciado: ${r.profileName || activeProfile?.name || 'projeto'}`);
      // Se não for puramente GUI, abre os logs automaticamente se for composto/web? Deixa o usuário focado, ou mostra badge Logs + URLs!
      if (r.processes.length > 0) setActiveProcId(r.processes[0].id);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(processId = '') {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.stopRun({ cwd, machine, processId });
      setStatus(r);
      onNotify(processId ? 'Processo encerrado.' : 'Execução parada.');
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveConfig() {
    if (!draftCfg || savingCfg) return;
    const cleanedProfiles = draftCfg.profiles
      .map((p) => ({
        ...p,
        name: p.name.trim(),
        processes: p.processes.filter((pr) => pr.cmd.trim()),
      }))
      .filter((p) => p.name && p.processes.length > 0);
    if (!cleanedProfiles.length) {
      onNotify('Configure ao menos 1 perfil com nome e comando.', true);
      return;
    }
    const payload: ProjectRunConfig = {
      format: 'ai-run',
      version: 1,
      defaultProfile: cleanedProfiles.some((p) => p.id === draftCfg.defaultProfile)
        ? draftCfg.defaultProfile
        : cleanedProfiles[0].id,
      profiles: cleanedProfiles,
    };
    setSavingCfg(true);
    try {
      const r = await api.saveRunConfig({ cwd, machine, config: payload });
      setRunCfg(r.config);
      setSelectedProfileId(r.config.defaultProfile || r.config.profiles[0]?.id || '');
      setConfigOpen(false);
      onNotify('Configuração de execução salva em .ai-workspace/run.json.');
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSavingCfg(false);
    }
  }

  function updateEditProfile(updater: (p: RunProfile) => RunProfile) {
    setDraftCfg((prev) => {
      if (!prev || !prev.profiles[editProfileIdx]) return prev;
      const nextProfiles = prev.profiles.map((p, idx) => (idx === editProfileIdx ? updater(p) : p));
      return { ...prev, profiles: nextProfiles };
    });
  }

  const editingProfile = draftCfg?.profiles[editProfileIdx] || null;
  const activeLogProc = (status?.processes || []).find((p) => p.id === activeProcId) || status?.processes?.[0] || null;

  return (
    <>
      <div className="run-btn-group">
        {!isRunning ? (
          <>
            {profiles.length > 1 && (
              <select
                className="run-sel"
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                title="Escolher perfil de execução"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <Button
              size="sm"
              variant="play"
              disabled={busy}
              onClick={() => handleStart()}
              title={activeProfile ? `Executar: ${activeProfile.name} (${activeProfile.processes.map((x) => x.cmd).join(' + ')})` : 'Configurar comando para rodar este projeto'}
            >
              <Play size={12} fill="currentColor" />
              {activeProfile ? 'Play' : 'Configurar Play'}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => handleStop()}
              title={`Parar ${status?.profileName || 'execução'}`}
            >
              <Square size={11} fill="currentColor" /> Stop
            </Button>
            <Button
              size="sm"
              onClick={() => setLogsOpen(true)}
              title={
                allReady
                  ? 'Projeto pronto — ver logs e URLs em tempo real'
                  : bootState === 'degraded'
                    ? 'Um ou mais processos falharam — clique para ver logs'
                    : `Subindo processos (${readyCount}/${totalCount} prontos)`
              }
            >
              <StatusDot kind={allReady ? 'working' : 'recent'} />
              Logs ({readyCount}/{totalCount})
            </Button>
            {allReady && primaryOpenUrl ? (
              <a
                href={primaryOpenUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
                style={{ textDecoration: 'none' }}
                title={`Abrir ${primaryOpenUrl}`}
              >
                <ExternalLink size={12} /> Abrir
              </a>
            ) : expectsWebUrl ? (
              <Button
                size="sm"
                disabled
                title={
                  bootState === 'degraded'
                    ? 'Projeto não subiu por completo — verifique os Logs'
                    : `Aguardando o projeto subir por completo (${readyCount}/${totalCount} prontos)…`
                }
              >
                <ExternalLink size={12} /> {bootState === 'degraded' ? 'Falhou' : 'Subindo…'}
              </Button>
            ) : null}
          </>
        )}

        {!isRunning && status && status.processes.length > 0 && (
          <Button
            size="sm"
            iconOnly
            onClick={() => setLogsOpen(true)}
            title="Ver logs da última execução"
          >
            <Terminal size={13} />
          </Button>
        )}

        <Button
          size="sm"
          iconOnly
          onClick={openConfigModal}
          title="Configurar perfis de Play (jogos, front+back, executáveis)"
          aria-label="Configurar Play"
        >
          <Settings2 size={13} />
        </Button>
      </div>

      {/* Modal de Logs ao vivo */}
      <ModalFrame
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        closeOnBackdrop
        maxWidth={820}
        height="78vh"
        title={
          <span className="ds-row">
            <StatusDot kind={isRunning ? 'working' : 'recent'} />
            Execução · {status?.profileName || activeProfile?.name || 'Projeto'}
          </span>
        }
        titleBadge={machine ? <Badge>{machine}</Badge> : undefined}
        headerActions={
          <>
            {allReachableUrls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="btn btn-sm ds-text-accent" style={{ textDecoration: 'none' }}>
                <ExternalLink size={12} /> {u.replace(/^https?:\/\//i, '')}
              </a>
            ))}
            {isRunning && !allReady && expectsWebUrl && (
              <Badge
                tone={bootState === 'degraded' ? 'neutral' : 'permission'}
                style={bootState === 'degraded' ? { color: 'var(--ds-danger)', borderColor: 'rgba(217, 91, 91, .45)' } : undefined}
              >
                {bootState === 'degraded' ? 'Subida incompleta' : `Subindo (${readyCount}/${totalCount})…`}
              </Badge>
            )}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => handleStart(status?.profileId || activeProfile?.id)}
              title="Reiniciar perfil"
            >
              <RotateCw size={12} /> Reiniciar
            </Button>
            {isRunning && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => handleStop()}>
                <Square size={11} fill="currentColor" /> Parar tudo
              </Button>
            )}
          </>
        }
      >
        {status && status.processes.length > 1 && (
          <div className="ds-row ds-wrap" style={{ flexShrink: 0 }}>
            {status.processes.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={activeLogProc?.id === p.id ? 'primary' : 'default'}
                onClick={() => setActiveProcId(p.id)}
              >
                  <span
                    className="col-dot"
                    style={{
                      background:
                        p.status === 'running'
                          ? (p.ready ? 'var(--ds-ok)' : 'var(--ds-warn)')
                          : p.exitCode && p.exitCode !== 0
                            ? 'var(--ds-danger)'
                            : 'var(--muted)',
                    }}
                  />
                  {p.name}
                  {p.status === 'running' && !p.ready && <span style={{ opacity: .75, fontSize: 10.5 }}>(subindo…)</span>}
                  {p.status !== 'running' && p.exitCode !== null && <span style={{ opacity: .75 }}>({p.exitCode})</span>}
              </Button>
            ))}
          </div>
        )}

        {activeLogProc ? (
          <div className="ds-stack ds-flex-1" style={{ gap: 6, overflow: 'hidden' }}>
            <div className="ds-row ds-text-muted" style={{ fontSize: 11.5, flexShrink: 0 }}>
              <code className="mono ell ds-flex-1">{activeLogProc.cmd}</code>
              {activeLogProc.cwd && <Badge mono>{activeLogProc.cwd}</Badge>}
              {activeLogProc.gui && <Badge>GUI</Badge>}
              {activeLogProc.pid > 0 && <span className="mono">PID {activeLogProc.pid}</span>}
              {activeLogProc.status === 'running' && status && status.processes.length > 1 && (
                <Button size="sm" variant="danger" onClick={() => handleStop(activeLogProc.id)}>
                  Parar {activeLogProc.name}
                </Button>
              )}
            </div>
            <div className="term-stream" style={{ borderRadius: 9, border: '1px solid var(--border)' }}>
              {activeLogProc.logs.map((l, idx) => (
                <div
                  key={idx}
                  style={{
                    color: l.stream === 'err' ? 'var(--ds-err-text)' : l.stream === 'sys' ? 'var(--accent)' : 'var(--ds-text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {l.text || ' '}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        ) : (
          <EmptyState>Nenhum log de execução ainda.</EmptyState>
        )}
      </ModalFrame>

      {/* Modal de Configuração de Perfis (.ai-workspace/run.json) */}
      <ModalFrame
        open={configOpen && !!draftCfg}
        onClose={() => setConfigOpen(false)}
        closeOnBackdrop={false}
        maxWidth={740}
        title="Configurar Play do Projeto"
        subtitle={
          <>Salvo em <code className="mono">.ai-workspace/run.json</code> · suporta jogos (GUI), Front+Back compostos e executáveis</>
        }
        headerActions={
          <div className="ds-row">
            <Button
              size="sm"
              disabled={aiConfiguring}
              onClick={handleAiAutoConfigure}
              title="Gerar .ai-workspace/run.json via IA e validar se o projeto sobe sem erros"
            >
              <Sparkles size={12} /> {aiConfiguring ? 'Configurando…' : 'Configurar via IA'}
            </Button>
            {detectedCfg && detectedCfg.profiles.length > 0 && (
              <Button
                size="sm"
                onClick={() => {
                  setDraftCfg(JSON.parse(JSON.stringify(detectedCfg)));
                  setEditProfileIdx(0);
                  onNotify('Perfis auto-detectados recarregados.');
                }}
                title="Restaurar perfis detectados automaticamente"
              >
                <RefreshCw size={12} /> Auto-detectar
              </Button>
            )}
          </div>
        }
        footer={
          <>
            <Button
              size="sm"
              variant="play"
              disabled={aiConfiguring || savingCfg}
              onClick={handleAiAutoConfigure}
              title="Analisa o projeto com IA, grava .ai-workspace/run.json e valida se sobe sem erros"
            >
              <Sparkles size={13} /> {aiConfiguring ? 'Configurando via IA…' : 'Configurar Play com IA'}
            </Button>
            <div className="ds-flex-1" />
            <Button size="sm" onClick={() => setConfigOpen(false)}>Cancelar</Button>
            <Button size="sm" variant="primary" disabled={savingCfg || aiConfiguring} onClick={handleSaveConfig}>
              <Save size={13} /> {savingCfg ? 'Salvando…' : 'Salvar configuração'}
            </Button>
          </>
        }
      >
        {draftCfg && (
          <>
            <div className="ds-row ds-wrap">
              {draftCfg.profiles.map((p, idx) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={idx === editProfileIdx ? 'primary' : 'default'}
                  onClick={() => setEditProfileIdx(idx)}
                >
                  {p.name || `Perfil ${idx + 1}`}
                  {draftCfg.defaultProfile === p.id && <span style={{ fontSize: 10, opacity: .8 }}>★</span>}
                </Button>
              ))}
              <Button
                size="sm"
                onClick={() => {
                  const np = makeEmptyProfile(draftCfg.profiles.length + 1);
                  setDraftCfg({ ...draftCfg, profiles: [...draftCfg.profiles, np] });
                  setEditProfileIdx(draftCfg.profiles.length);
                }}
              >
                <Plus size={12} /> Novo perfil
              </Button>
            </div>

            {editingProfile && (
              <div className="ds-stack">
                <div className="ds-grid-2">
                  <Field label="Nome do perfil">
                    <input
                      className="inp"
                      value={editingProfile.name}
                      onChange={(e) => updateEditProfile((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Ex.: Rodar Jogo (Godot), Dev (Back + Front)…"
                    />
                  </Field>
                  <Field label="Tipo">
                    <select
                      className="sel"
                      value={editingProfile.kind}
                      onChange={(e) => updateEditProfile((p) => ({ ...p, kind: e.target.value as RunProfile['kind'] }))}
                    >
                      {(Object.keys(KIND_LABELS) as RunProfile['kind'][]).map((k) => (
                        <option key={k} value={k}>{KIND_LABELS[k]}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="ds-row-between">
                  <label className="ds-row" style={{ fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={draftCfg.defaultProfile === editingProfile.id}
                      onChange={(e) => {
                        if (e.target.checked) setDraftCfg({ ...draftCfg, defaultProfile: editingProfile.id });
                      }}
                    />
                    Perfil padrão do botão Play
                  </label>
                  {draftCfg.profiles.length > 1 && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        const next = draftCfg.profiles.filter((_, idx) => idx !== editProfileIdx);
                        setDraftCfg({ ...draftCfg, profiles: next });
                        setEditProfileIdx(Math.max(0, editProfileIdx - 1));
                      }}
                    >
                      <Trash2 size={12} /> Remover perfil
                    </Button>
                  )}
                </div>

                <div className="ds-row-between">
                  <strong style={{ fontSize: 13 }}>Processos executados ({editingProfile.processes.length})</strong>
                  <Button
                    size="sm"
                    onClick={() =>
                      updateEditProfile((p) => ({
                        ...p,
                        kind: p.processes.length >= 1 ? 'compound' : p.kind,
                        processes: [
                          ...p.processes,
                          { id: `proc-${p.processes.length + 1}`, name: `Processo ${p.processes.length + 1}`, cmd: '' },
                        ],
                      }))
                    }
                  >
                    <Plus size={12} /> Adicionar processo (Front + Back)
                  </Button>
                </div>

                {editingProfile.processes.map((pr: RunProcessSpec, pIdx: number) => (
                  <div key={pIdx} className="card-item ds-m0 ds-stack" style={{ gap: 8 }}>
                    <div className="ds-row">
                      <input
                        className="inp ds-flex-1"
                        style={{ fontSize: 12.5 }}
                        value={pr.name}
                        onChange={(e) =>
                          updateEditProfile((p) => ({
                            ...p,
                            processes: p.processes.map((x, i) => (i === pIdx ? { ...x, name: e.target.value } : x)),
                          }))
                        }
                        placeholder="Nome (ex.: Backend, Frontend, Godot)"
                      />
                      <input
                        className="inp mono"
                        style={{ width: 170, fontSize: 12 }}
                        value={pr.cwd || ''}
                        onChange={(e) =>
                          updateEditProfile((p) => ({
                            ...p,
                            processes: p.processes.map((x, i) => (i === pIdx ? { ...x, cwd: e.target.value || undefined } : x)),
                          }))
                        }
                        placeholder="Subpasta (opcional)"
                      />
                      {editingProfile.processes.length > 1 && (
                        <Button
                          size="sm"
                          iconOnly
                          variant="danger"
                          onClick={() =>
                            updateEditProfile((p) => ({
                              ...p,
                              processes: p.processes.filter((_, i) => i !== pIdx),
                            }))
                          }
                          title="Remover processo"
                        >
                          <Trash2 size={12} />
                        </Button>
                      )}
                    </div>
                    <input
                      className="inp mono"
                      style={{ fontSize: 12 }}
                      value={pr.cmd}
                      onChange={(e) =>
                        updateEditProfile((p) => ({
                          ...p,
                          processes: p.processes.map((x, i) => (i === pIdx ? { ...x, cmd: e.target.value } : x)),
                        }))
                      }
                      placeholder='Comando ou executável (ex.: npm run dev, godot --path ., "C:\app\meu.exe")'
                    />
                    <div className="ds-row ds-wrap" style={{ gap: 12 }}>
                      <label className="ds-row ds-text-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!pr.gui}
                          onChange={(e) =>
                            updateEditProfile((p) => ({
                              ...p,
                              processes: p.processes.map((x, i) => (i === pIdx ? { ...x, gui: e.target.checked } : x)),
                            }))
                          }
                        />
                        App gráfico / Jogo (abre janela no desktop)
                      </label>
                      <input
                        className="inp mono ds-flex-1"
                        style={{ minWidth: 160, fontSize: 11.5, padding: '4px 8px' }}
                        value={pr.openUrl || ''}
                        onChange={(e) =>
                          updateEditProfile((p) => ({
                            ...p,
                            processes: p.processes.map((x, i) => (i === pIdx ? { ...x, openUrl: e.target.value || undefined } : x)),
                          }))
                        }
                        placeholder="URL para abrir (ex.: http://localhost:5173 ou auto)"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </ModalFrame>
    </>
  );
}
