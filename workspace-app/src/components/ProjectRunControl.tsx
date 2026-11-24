import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ExternalLink,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Settings2,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { ProjectRunConfig, ProjectRunStatus, RunProcessSpec, RunProfile } from '../types';

interface Props {
  cwd: string;
  machine?: string;
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

export function ProjectRunControl({ cwd, machine = '', onNotify }: Props) {
  const [runCfg, setRunCfg] = useState<ProjectRunConfig | null>(null);
  const [detectedCfg, setDetectedCfg] = useState<ProjectRunConfig | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [status, setStatus] = useState<ProjectRunStatus | null>(null);
  const [busy, setBusy] = useState(false);

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
  const runningCount = (status?.processes || []).filter((p) => p.status === 'running').length;
  const allUrls = useMemo(() => {
    const out: string[] = [];
    for (const p of status?.processes || []) {
      for (const u of p.detectedUrls || []) {
        if (!out.includes(u)) out.push(u);
      }
    }
    return out;
  }, [status]);

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
            <button
              className="btn btn-sm run-play-btn"
              disabled={busy}
              onClick={() => handleStart()}
              title={activeProfile ? `Executar: ${activeProfile.name} (${activeProfile.processes.map((x) => x.cmd).join(' + ')})` : 'Configurar comando para rodar este projeto'}
            >
              <Play size={12} fill="currentColor" />
              {activeProfile ? 'Play' : 'Configurar Play'}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => handleStop()}
              title={`Parar ${status?.profileName || 'execução'}`}
            >
              <Square size={11} fill="currentColor" /> Stop
            </button>
            <button
              className="btn btn-sm"
              onClick={() => setLogsOpen(true)}
              title="Ver logs e URLs em tempo real"
            >
              <span className="sb-dot working" />
              Logs ({runningCount}/{status?.processes.length || 0})
            </button>
            {allUrls[0] && (
              <a
                href={allUrls[0]}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
                style={{ textDecoration: 'none' }}
                title={`Abrir ${allUrls[0]}`}
              >
                <ExternalLink size={12} /> Abrir
              </a>
            )}
          </>
        )}

        {!isRunning && status && status.processes.length > 0 && (
          <button
            className="btn btn-sm btn-icon"
            onClick={() => setLogsOpen(true)}
            title="Ver logs da última execução"
          >
            <Terminal size={13} />
          </button>
        )}

        <button
          className="btn btn-sm btn-icon"
          onClick={openConfigModal}
          title="Configurar perfis de Play (jogos, front+back, executáveis)"
          aria-label="Configurar Play"
        >
          <Settings2 size={13} />
        </button>
      </div>

      {/* Modal de Logs ao vivo */}
      {logsOpen && (
        <div className="modal-bg" onClick={() => setLogsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 820, height: '78vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexShrink: 0, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={`sb-dot ${isRunning ? 'working' : 'recent'}`} />
                <h3 style={{ margin: 0, fontSize: 15 }}>
                  Execução · {status?.profileName || activeProfile?.name || 'Projeto'}
                </h3>
                {machine && <span className="badge">{machine}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {allUrls.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: 'none', color: 'var(--accent)' }}>
                    <ExternalLink size={12} /> {u.replace(/^https?:\/\//i, '')}
                  </a>
                ))}
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => handleStart(status?.profileId || activeProfile?.id)}
                  title="Reiniciar perfil"
                >
                  <RotateCw size={12} /> Reiniciar
                </button>
                {isRunning && (
                  <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => handleStop()}>
                    <Square size={11} fill="currentColor" /> Parar tudo
                  </button>
                )}
                <button className="btn btn-sm btn-icon" onClick={() => setLogsOpen(false)} title="Fechar">
                  <X size={15} />
                </button>
              </div>
            </div>

            {status && status.processes.length > 1 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                {status.processes.map((p) => (
                  <button
                    key={p.id}
                    className={`btn btn-sm ${activeLogProc?.id === p.id ? 'btn-primary' : ''}`}
                    onClick={() => setActiveProcId(p.id)}
                  >
                    <span
                      className="col-dot"
                      style={{
                        background: p.status === 'running' ? 'var(--ok)' : p.exitCode && p.exitCode !== 0 ? 'var(--danger)' : 'var(--muted)',
                      }}
                    />
                    {p.name}
                    {p.status !== 'running' && p.exitCode !== null && <span style={{ opacity: .75 }}>({p.exitCode})</span>}
                  </button>
                ))}
              </div>
            )}

            {activeLogProc ? (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>
                  <code className="mono ell" style={{ flex: 1 }}>{activeLogProc.cmd}</code>
                  {activeLogProc.cwd && <span className="badge mono">{activeLogProc.cwd}</span>}
                  {activeLogProc.gui && <span className="badge">GUI</span>}
                  {activeLogProc.pid > 0 && <span className="mono">PID {activeLogProc.pid}</span>}
                  {activeLogProc.status === 'running' && status && status.processes.length > 1 && (
                    <button className="btn btn-sm btn-danger" onClick={() => handleStop(activeLogProc.id)}>
                      Parar {activeLogProc.name}
                    </button>
                  )}
                </div>
                <div className="term-stream" style={{ borderRadius: 9, border: '1px solid var(--border)' }}>
                  {activeLogProc.logs.map((l, idx) => (
                    <div
                      key={idx}
                      style={{
                        color: l.stream === 'err' ? '#f49b9b' : l.stream === 'sys' ? 'var(--accent)' : '#dbe1ec',
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
              <div className="empty">Nenhum log de execução ainda.</div>
            )}
          </div>
        </div>
      )}

      {/* Modal de Configuração de Perfis (.ai-workspace/run.json) */}
      {configOpen && draftCfg && (
        <div className="modal-bg">
          <div className="modal" style={{ maxWidth: 740, maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>Configurar Play do Projeto</h3>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  Salvo em <code className="mono">.ai-workspace/run.json</code> · suporta jogos (GUI), Front+Back compostos e executáveis
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {detectedCfg && detectedCfg.profiles.length > 0 && (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setDraftCfg(JSON.parse(JSON.stringify(detectedCfg)));
                      setEditProfileIdx(0);
                      onNotify('Perfis auto-detectados recarregados.');
                    }}
                    title="Restaurar perfis detectados automaticamente"
                  >
                    <RefreshCw size={12} /> Auto-detectar
                  </button>
                )}
                <button className="btn btn-sm btn-icon" onClick={() => setConfigOpen(false)} title="Fechar">
                  <X size={15} />
                </button>
              </div>
            </div>

            {/* Seletor de perfis */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, flexShrink: 0 }}>
              {draftCfg.profiles.map((p, idx) => (
                <button
                  key={p.id}
                  className={`btn btn-sm ${idx === editProfileIdx ? 'btn-primary' : ''}`}
                  onClick={() => setEditProfileIdx(idx)}
                >
                  {p.name || `Perfil ${idx + 1}`}
                  {draftCfg.defaultProfile === p.id && <span style={{ fontSize: 10, opacity: .8 }}>★</span>}
                </button>
              ))}
              <button
                className="btn btn-sm"
                onClick={() => {
                  const np = makeEmptyProfile(draftCfg.profiles.length + 1);
                  setDraftCfg({ ...draftCfg, profiles: [...draftCfg.profiles, np] });
                  setEditProfileIdx(draftCfg.profiles.length);
                }}
              >
                <Plus size={12} /> Novo perfil
              </button>
            </div>

            {editingProfile && (
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 11, paddingRight: 4 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Nome do perfil</label>
                    <input
                      className="inp"
                      value={editingProfile.name}
                      onChange={(e) => updateEditProfile((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Ex.: Rodar Jogo (Godot), Dev (Back + Front)…"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Tipo</label>
                    <select
                      className="sel"
                      value={editingProfile.kind}
                      onChange={(e) => updateEditProfile((p) => ({ ...p, kind: e.target.value as RunProfile['kind'] }))}
                    >
                      {(Object.keys(KIND_LABELS) as RunProfile['kind'][]).map((k) => (
                        <option key={k} value={k}>{KIND_LABELS[k]}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
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
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        const next = draftCfg.profiles.filter((_, idx) => idx !== editProfileIdx);
                        setDraftCfg({ ...draftCfg, profiles: next });
                        setEditProfileIdx(Math.max(0, editProfileIdx - 1));
                      }}
                    >
                      <Trash2 size={12} /> Remover perfil
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <strong style={{ fontSize: 13 }}>Processos executados ({editingProfile.processes.length})</strong>
                  <button
                    className="btn btn-sm"
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
                  </button>
                </div>

                {editingProfile.processes.map((pr: RunProcessSpec, pIdx: number) => (
                  <div key={pIdx} className="card-item" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        className="inp"
                        style={{ flex: 1, fontSize: 12.5 }}
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
                        <button
                          className="btn btn-sm btn-icon btn-danger"
                          onClick={() =>
                            updateEditProfile((p) => ({
                              ...p,
                              processes: p.processes.filter((_, i) => i !== pIdx),
                            }))
                          }
                          title="Remover processo"
                        >
                          <Trash2 size={12} />
                        </button>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer' }}>
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
                        className="inp mono"
                        style={{ flex: 1, minWidth: 160, fontSize: 11.5, padding: '4px 8px' }}
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

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
              <button className="btn btn-sm" onClick={() => setConfigOpen(false)}>Cancelar</button>
              <button className="btn btn-sm btn-primary" disabled={savingCfg} onClick={handleSaveConfig}>
                <Save size={13} /> {savingCfg ? 'Salvando…' : 'Salvar configuração'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
