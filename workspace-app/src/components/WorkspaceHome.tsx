import { useEffect, useState } from 'react';
import {
  Activity,
  Brain,
  Clock,
  FolderGit2,
  FolderKanban,
  FolderPlus,
  GitFork,
  Layers,
  MessageSquarePlus,
  Monitor,
  Plus,
  ShieldAlert,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { api } from '../api';
import type { Snapshot, WorkspaceEntity, WorkspaceIndex } from '../types';

interface Props {
  ws: WorkspaceIndex | null;
  snap: Snapshot | null;
  groups: string[];
  onOpenEntity: (id: string, tab?: 'step' | 'memory' | 'files' | 'terminal') => void;
  onOpenDoc: (area: 'context' | 'knowledge' | 'skills' | 'handoffs', name: string) => void;
  onOpenSession: (sessionId: string) => void;
  onNewProject: (presetGroup?: string) => void;
  onNewGroup: () => void;
  onNewConversation: () => void;
}

interface MemSummaryItem {
  project: string;
  slug: string;
  pendingCount: number;
  lastDreamAt?: number;
}

function countProjectSessions(e: WorkspaceEntity, snap: Snapshot | null): { active: number; attention: number } {
  if (!snap) return { active: 0, attention: 0 };
  const binding = e.projectBindings?.[0];
  const folder = binding?.cwd ? binding.cwd.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() : '';
  const title = (e.title || '').toLowerCase();
  let active = 0;
  let attention = 0;
  for (const s of snap.active || []) {
    const p = (s.project || '').toLowerCase();
    const match = (folder && (p === folder || p.includes(folder))) || (p && title.includes(p));
    if (!match) continue;
    active += 1;
    if (s.state === 'permission' || s.state === 'waiting') attention += 1;
  }
  return { active, attention };
}

export function WorkspaceHome({
  ws,
  snap,
  groups,
  onOpenEntity,
  onOpenDoc,
  onOpenSession,
  onNewProject,
  onNewGroup,
  onNewConversation,
}: Props) {
  const [memPending, setMemPending] = useState<MemSummaryItem[]>([]);

  useEffect(() => {
    api.listMemorySummary()
      .then((r) => setMemPending((r.projects || []).filter((p) => p.pendingCount > 0)))
      .catch(() => {});
  }, [ws?.entities?.length]);

  const entities = ws?.entities || [];
  const recentProjects = entities
    .slice()
    .sort((a, b) => {
      const da = String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || ''));
      if (da !== 0) return da;
      return Number(!!b.pinned) - Number(!!a.pinned);
    })
    .slice(0, 8);

  const activeSessions = snap?.active || [];
  const attentionSessions = activeSessions.filter((s) => s.state === 'permission' || s.state === 'waiting').slice(0, 4);
  const workingCount = activeSessions.filter((s) => s.state === 'working').length;
  const permCount = activeSessions.filter((s) => s.state === 'permission').length;
  const machines = snap?.machines || [];
  const onlineMachines = machines.filter((m) => m.ok).length;
  const recentHandoffs = (ws?.handoffs || []).slice(0, 4);
  const globalDocs = [
    ...(ws?.context || []).slice(0, 3).map((d) => ({ area: 'context' as const, ...d })),
    ...(ws?.knowledge || []).slice(0, 3).map((d) => ({ area: 'knowledge' as const, ...d })),
  ].slice(0, 5);

  return (
    <div className="home-wrap">
      {/* Cabeçalho + Ações rápidas */}
      <div className="home-hero">
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700 }}>Início · AI Workspace</h1>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
            Seus projetos, englobadores, memória compartilhada e sessões ativas em um só lugar.
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => onNewProject('')}>
            <Plus size={14} /> Novo projeto
          </button>
          <button className="btn" onClick={onNewGroup}>
            <FolderPlus size={14} /> Novo englobador
          </button>
          <button className="btn" onClick={onNewConversation}>
            <MessageSquarePlus size={14} /> Nova conversa
          </button>
        </div>
      </div>

      {/* KPIs rápidos */}
      <div className="home-kpis">
        <div className="home-kpi">
          <div className="home-kpi-lbl"><FolderKanban size={13} /> Projetos</div>
          <div className="home-kpi-val">{entities.length}</div>
          <div className="home-kpi-sub">{groups.length ? `${groups.length} englobador(es)` : 'sem englobadores ainda'}</div>
        </div>
        <div className="home-kpi">
          <div className="home-kpi-lbl"><Activity size={13} /> Sessões ativas</div>
          <div className="home-kpi-val">{activeSessions.length}</div>
          <div className="home-kpi-sub">
            {permCount ? `${permCount} pedindo permissão` : workingCount ? `${workingCount} trabalhando agora` : 'tudo tranquilo'}
          </div>
        </div>
        <div className="home-kpi">
          <div className="home-kpi-lbl"><Brain size={13} /> Dreaming pendente</div>
          <div className="home-kpi-val">{memPending.length}</div>
          <div className="home-kpi-sub">
            {memPending.length ? `${memPending.reduce((a, b) => a + b.pendingCount, 0)} sessões novas` : 'memória em dia'}
          </div>
        </div>
        <div className="home-kpi">
          <div className="home-kpi-lbl"><Monitor size={13} /> Máquinas</div>
          <div className="home-kpi-val">{machines.length ? `${onlineMachines}/${machines.length}` : '1/1'}</div>
          <div className="home-kpi-sub">
            {machines.length ? machines.map((m) => m.name).join(' · ') : 'servidor local'}
          </div>
        </div>
      </div>

      {/* Atenção agora (permissões / esperando sua resposta) */}
      {attentionSessions.length > 0 && (
        <section className="home-sec">
          <div className="home-sec-head">
            <h2 style={{ color: permCount ? '#f6b3b3' : 'var(--warn)' }}>
              <ShieldAlert size={14} /> Aguardando você ({attentionSessions.length})
            </h2>
          </div>
          <div className="home-attn-grid">
            {attentionSessions.map((s) => (
              <button key={s.id} className="home-attn-card" onClick={() => onOpenSession(s.id)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <strong className="ell" style={{ flex: 1, fontSize: 13 }}>{s.alias || s.project}</strong>
                  <span className={`badge ${s.state}`}>{s.state === 'permission' ? 'permissão' : 'sua vez'}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
                  {s.tool}{s.machine ? ` · ${s.machine}` : ''}
                </div>
                <div className="ell" style={{ fontSize: 12, color: '#cdd3e0' }}>
                  {s.lastReply || s.lastPrompt || s.title || 'Abrir conversa'}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Últimos projetos alterados */}
      <section className="home-sec">
        <div className="home-sec-head">
          <h2><Clock size={14} /> Últimos projetos alterados</h2>
          <button className="btn btn-sm" onClick={() => onNewProject('')}>
            <Plus size={12} /> Novo projeto
          </button>
        </div>

        {recentProjects.length === 0 ? (
          <div className="card-item" style={{ textAlign: 'center', padding: 28 }}>
            <p style={{ margin: '0 0 12px', color: 'var(--muted)' }}>
              Nenhum projeto cadastrado ainda. Crie seu primeiro projeto ou englobador (ex.: TRT, Jogos).
            </p>
            <button className="btn btn-primary" onClick={() => onNewProject('')}>
              <Plus size={14} /> Criar primeiro projeto
            </button>
          </div>
        ) : (
          <div className="home-proj-grid">
            {recentProjects.map((e) => {
              const binding = e.projectBindings?.[0];
              const counts = countProjectSessions(e, snap);
              return (
                <div key={e.id} className="home-proj-card">
                  <button className="home-proj-main" onClick={() => onOpenEntity(e.id, 'step')}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <FolderKanban size={15} color="var(--accent)" style={{ flexShrink: 0 }} />
                      <strong className="ell" style={{ flex: 1, fontSize: 14 }}>{e.title}</strong>
                      {e.group && <span className="badge" style={{ fontSize: 10 }}>📁 {e.group}</span>}
                    </div>
                    {e.description && (
                      <div className="ell" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                        {e.description}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)' }}>
                      {binding && <span className="mono ell" style={{ maxWidth: 210 }}>{binding.machine}: {binding.cwd}</span>}
                      {e.updated && <span style={{ marginLeft: 'auto' }}>{e.updated}</span>}
                    </div>
                  </button>
                  <div className="home-proj-foot">
                    {counts.active > 0 && (
                      <span className={`badge ${counts.attention ? 'waiting' : 'working'}`}>
                        {counts.active} sessão(ões)
                      </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <button className="btn btn-sm" onClick={() => onOpenEntity(e.id, 'memory')} title="Memória & Dreaming">
                      <Brain size={12} /> Memória
                    </button>
                    {binding && (
                      <>
                        <button className="btn btn-sm" onClick={() => onOpenEntity(e.id, 'files')} title="Arquivos & Git">
                          <FolderGit2 size={12} />
                        </button>
                        <button className="btn btn-sm" onClick={() => onOpenEntity(e.id, 'terminal')} title="Terminal PTY">
                          <Terminal size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Englobadores (Workspaces) + Handoffs / Docs recentes lado a lado */}
      <div className="home-bottom-grid">
        <section className="home-sec" style={{ marginBottom: 0 }}>
          <div className="home-sec-head">
            <h2><Layers size={14} /> Englobadores (Workspaces)</h2>
            <button className="btn btn-sm" onClick={onNewGroup}><Plus size={12} /> Novo</button>
          </div>
          {groups.length === 0 ? (
            <div className="card-item" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              Crie englobadores como <b>TRT</b> ou <b>Jogos</b> para organizar grupos de projetos.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {groups.map((g) => {
                const items = entities.filter((e) => e.group === g);
                return (
                  <div key={g} className="card-item" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Layers size={14} color="var(--accent)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: 13 }}>{g}</strong>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {items.length ? items.map((i) => i.title).slice(0, 3).join(', ') : 'Sem projetos ainda'}
                      </div>
                    </div>
                    <span className="badge">{items.length}</span>
                    <button className="btn btn-sm" onClick={() => onNewProject(g)} title={`Criar projeto em ${g}`}>
                      <Plus size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="home-sec" style={{ marginBottom: 0 }}>
          <div className="home-sec-head">
            <h2><GitFork size={14} /> Handoffs & Base Global</h2>
          </div>
          <div className="card-item" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentHandoffs.length === 0 && globalDocs.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Handoffs entre IAs e notas globais (`context/`, `knowledge/`) aparecerão aqui.
              </div>
            ) : (
              <>
                {recentHandoffs.map((h) => (
                  <button key={`h-${h.name}`} className="sb-item" onClick={() => onOpenDoc('handoffs', h.name)}>
                    <GitFork size={13} color="var(--warn)" style={{ flexShrink: 0 }} />
                    <span className="ell">{h.name}</span>
                    <span className="meta">handoff</span>
                  </button>
                ))}
                {globalDocs.map((d) => (
                  <button key={`d-${d.area}-${d.name}`} className="sb-item" onClick={() => onOpenDoc(d.area, d.name)}>
                    <Sparkles size={13} color="var(--accent)" style={{ flexShrink: 0 }} />
                    <span className="ell">{d.name}</span>
                    <span className="meta">{d.area}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
