import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  FolderGit2,
  Link2,
  Package,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Unlink,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, EmptyState } from '../ui';
import type { McpTarget, PluginCatalogItem, SkillCatalogItem, SkillsCatalogResponse, Snapshot } from '../types';

interface Props {
  snap: Snapshot | null;
  onNotify: (msg: string, err?: boolean) => void;
}

const TARGETS: { id: McpTarget; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
];

export function SkillsPane({ snap, onNotify }: Props) {
  const machines = useMemo(() => {
    const list = (snap?.machines || []).map((m) => m.name).filter(Boolean);
    return Array.from(new Set(list));
  }, [snap?.machines]);

  // Prefere a máquina desktop/Windows (ex.: MateusNote) quando acessando pela VPS
  const [machine, setMachine] = useState<string>(() => {
    const nonVps = machines.find((m) => !/vps/i.test(m));
    return nonVps || '';
  });
  const [data, setData] = useState<SkillsCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [query, setQuery] = useState('');
  const [originFilter, setOriginFilter] = useState('all');

  const load = useCallback(async (targetMachine = machine) => {
    setLoading(true);
    try {
      const r = await api.getSkillsCatalog(targetMachine);
      setData(r);
    } catch (e) {
      onNotify((e as Error).message || 'Falha ao carregar catálogo de skills.', true);
    } finally {
      setLoading(false);
    }
  }, [machine, onNotify]);

  useEffect(() => {
    load(machine);
  }, [machine, load]);

  async function toggleSkillTarget(skill: SkillCatalogItem, target: McpTarget) {
    const cur = skill.targets[target];
    if (cur.native || cur.status === 'plugin') return;
    const nextEnable = !cur.linked;
    const key = `${skill.id}:${target}`;
    setBusyKey(key);
    try {
      const r = await api.shareSkill({
        machine,
        sourceDir: skill.sourceDir,
        name: skill.name,
        targets: { [target]: nextEnable },
      });
      setData(r.catalog);
      onNotify(
        nextEnable
          ? `Skill /${skill.name} compartilhada com ${target}.`
          : `Link de /${skill.name} removido de ${target}.`,
      );
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusyKey('');
    }
  }

  async function sharePluginAll(pl: PluginCatalogItem) {
    const key = `plugin-share:${pl.id}`;
    setBusyKey(key);
    try {
      const r = await api.batchShareSkills({
        machine,
        pluginId: pl.id,
        targets: ['codex', 'antigravity'],
        enable: true,
      });
      setData(r.catalog);
      onNotify(`Skills do plugin ${pl.name} compartilhadas com Codex e Antigravity (${r.count}).`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusyKey('');
    }
  }

  async function shareOriginAll(originLabel: string) {
    const key = `origin-share:${originLabel}`;
    setBusyKey(key);
    try {
      const r = await api.batchShareSkills({
        machine,
        origin: originLabel,
        targets: ['claude', 'codex', 'antigravity'],
        enable: true,
      });
      setData(r.catalog);
      onNotify(`${r.count} skill(s) de "${originLabel}" compartilhadas com Claude, Codex e Antigravity.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusyKey('');
    }
  }

  async function updatePluginCache(pl: PluginCatalogItem) {
    const key = `plugin-update:${pl.id}`;
    setBusyKey(key);
    try {
      const r = await api.updateClaudePluginCache({ machine, pluginId: pl.id });
      setData(r.catalog);
      onNotify(`Cache do plugin ${pl.name} atualizado para v${r.version} no Claude Code!`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setBusyKey('');
    }
  }

  const origins = useMemo(() => {
    const set = new Set<string>();
    for (const s of data?.skills || []) set.add(s.origin);
    return Array.from(set);
  }, [data?.skills]);

  const workspaceOrigins = useMemo(
    () => origins.filter((o) => o.startsWith('Workspace ')),
    [origins],
  );

  const visibleSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.skills || []).filter((s) => {
      if (originFilter !== 'all' && s.origin !== originFilter) return false;
      if (!q) return true;
      return `${s.name} ${s.cmd} ${s.description} ${s.origin} ${s.plugin}`.toLowerCase().includes(q);
    });
  }, [data?.skills, query, originFilter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Barra superior: máquina + recarregar */}
      <div className="ds-row" style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
        <div className="ds-row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {machines.length > 1 && (
            <select
              className="sel"
              style={{ width: 'auto', minWidth: 160 }}
              value={machine}
              onChange={(e) => setMachine(e.target.value)}
              aria-label="Selecionar máquina"
            >
              <option value="">Servidor atual (Hub)</option>
              {machines.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
          <Button size="sm" onClick={() => load(machine)} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> Atualizar
          </Button>
          {workspaceOrigins.map((orig) => (
            <Button
              key={orig}
              size="sm"
              variant="primary"
              disabled={!!busyKey}
              onClick={() => shareOriginAll(orig)}
              title={`Criar links (junction/symlink) de todas as skills de ${orig} para Claude, Codex e Antigravity`}
            >
              <Share2 size={13} />
              {busyKey === `origin-share:${orig}` ? 'Compartilhando…' : `Compartilhar ${orig}`}
            </Button>
          ))}
        </div>
        {data?.machine && (
          <Badge tone="neutral">Máquina: {data.machine}</Badge>
        )}
      </div>

      {/* Explicação curta de como o compartilhamento funciona */}
      <div
        className="card-item"
        style={{ marginBottom: 0, padding: '10px 12px', borderColor: 'rgba(95, 184, 164, .28)', background: 'rgba(95, 184, 164, .06)' }}
      >
        <div style={{ fontSize: 12.5, color: 'var(--ds-text-soft)', lineHeight: 1.5 }}>
          Skills e plugins são compartilhados via <b>junction / symlink</b> sem duplicar arquivos — edições no repositório original (ex.: <code className="mono">D:\Projetos TRT18</code>) refletem na hora no <b>Claude Code</b>, <b>Codex CLI</b> e <b>Antigravity</b>.
        </div>
      </div>

      {loading && !data ? (
        <div className="empty">Carregando plugins e skills…</div>
      ) : !data ? (
        <EmptyState>
          Não foi possível carregar skills — verifique se a máquina selecionada está online.
        </EmptyState>
      ) : (
        <>
          {/* Seção 1: Plugins descobertos (ex.: trt18-vulnerabilidades) */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="ds-row" style={{ gap: 8 }}>
              <Package size={15} color="var(--accent)" />
              <h2 style={{ margin: 0, fontSize: 14.5 }}>Plugins ({data.plugins.length})</h2>
            </div>

            {data.plugins.length === 0 ? (
              <div className="card-item" style={{ marginBottom: 0, color: 'var(--ds-muted)', fontSize: 12.5 }}>
                Nenhum plugin Claude instalado/configurado em <code className="mono">~/.claude/settings.json</code> nesta máquina.
                {machines.length > 1 && !machine && ' Troque a máquina no seletor acima (ex.: MateusNote) para ver plugins locais.'}
              </div>
            ) : (
              data.plugins.map((pl) => (
                <div key={pl.id} className="card-item" style={{ marginBottom: 0, padding: 14 }}>
                  <div className="ds-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                    <div className="ds-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{pl.name}</strong>
                      <Badge tone="neutral">v{pl.sourceVersion || pl.cacheVersion || '?'}</Badge>
                      {pl.marketplace && <Badge tone="neutral">{pl.marketplace}</Badge>}
                      {pl.outdated && (
                        <Badge tone="waiting" style={{ gap: 4 }}>
                          <AlertTriangle size={11} /> Cache Claude v{pl.cacheVersion} desatualizado
                        </Badge>
                      )}
                      {!pl.outdated && pl.cacheVersion && (
                        <Badge tone="done" style={{ gap: 4 }}>
                          <Check size={11} /> Cache v{pl.cacheVersion} OK
                        </Badge>
                      )}
                    </div>
                    <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {pl.canUpdateCache && pl.outdated && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!!busyKey}
                          onClick={() => updatePluginCache(pl)}
                          title={`Copia ${pl.sourcePath} para o cache do Claude Code e atualiza installed_plugins.json`}
                        >
                          <RefreshCw size={12} />
                          {busyKey === `plugin-update:${pl.id}` ? 'Atualizando…' : `Atualizar cache → v${pl.sourceVersion}`}
                        </Button>
                      )}
                      {pl.skills.length > 0 && (
                        <Button
                          size="sm"
                          disabled={!!busyKey}
                          onClick={() => sharePluginAll(pl)}
                          title="Compartilha todas as skills deste plugin com Codex CLI e Antigravity via link"
                        >
                          <Share2 size={12} />
                          {busyKey === `plugin-share:${pl.id}` ? 'Linkando…' : 'Compartilhar p/ Codex & Antigravity'}
                        </Button>
                      )}
                    </div>
                  </div>

                  {pl.description && (
                    <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--ds-text-soft)', lineHeight: 1.45 }}>
                      {pl.description}
                    </p>
                  )}

                  <div className="ds-row" style={{ gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--ds-muted)' }}>
                    <span className="ds-row" style={{ gap: 4 }}>
                      <FolderGit2 size={12} />
                      <code className="mono">{pl.activePath}</code>
                    </span>
                    {pl.agents.length > 0 && (
                      <span className="ds-row" style={{ gap: 4 }}>
                        <Bot size={12} />
                        Agentes Claude: {pl.agents.map((a) => a.name).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>

          {/* Seção 2: Skills individuais com toggle por CLI */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="ds-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div className="ds-row" style={{ gap: 8 }}>
                <Sparkles size={15} color="var(--accent)" />
                <h2 style={{ margin: 0, fontSize: 14.5 }}>Skills ({visibleSkills.length})</h2>
              </div>
              <div className="ds-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative' }}>
                  <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--ds-muted)' }} />
                  <input
                    className="sb-search"
                    style={{ paddingLeft: 28, width: 210 }}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filtrar skills…"
                  />
                </div>
                <select
                  className="sel"
                  style={{ width: 'auto', minWidth: 165 }}
                  value={originFilter}
                  onChange={(e) => setOriginFilter(e.target.value)}
                  aria-label="Filtrar por origem"
                >
                  <option value="all">Todas as origens ({data.skills.length})</option>
                  {origins.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
            </div>

            {visibleSkills.length === 0 ? (
              <div className="card-item" style={{ marginBottom: 0, color: 'var(--ds-muted)', fontSize: 12.5 }}>
                Nenhuma skill encontrada para este filtro.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visibleSkills.map((sk) => (
                  <div key={sk.id} className="card-item" style={{ marginBottom: 0, padding: '11px 13px' }}>
                    <div className="ds-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: '1 1 280px' }}>
                        <div className="ds-row" style={{ gap: 7, flexWrap: 'wrap', marginBottom: 3 }}>
                          <code className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>{sk.cmd}</code>
                          <Badge tone="neutral">{sk.origin}</Badge>
                        </div>
                        {sk.description && (
                          <div style={{ fontSize: 12, color: 'var(--ds-text-soft)', lineHeight: 1.4, marginBottom: 4 }}>
                            {sk.description}
                          </div>
                        )}
                        <div className="mono ell" style={{ fontSize: 10.5, color: 'var(--ds-muted)' }} title={sk.sourceDir}>
                          {sk.sourceDir}
                        </div>
                      </div>

                      <div className="ds-row" style={{ gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
                        {TARGETS.map((t) => {
                          const st = sk.targets[t.id];
                          const isBusy = busyKey === `${sk.id}:${t.id}`;
                          const isLocked = st.native || st.status === 'plugin';
                          const isConflict = st.status === 'conflict';
                          return (
                            <button
                              key={t.id}
                              type="button"
                              className={`btn btn-sm ${st.linked ? 'btn-primary' : ''}`}
                              disabled={isLocked || isConflict || !!busyKey}
                              onClick={() => toggleSkillTarget(sk, t.id)}
                              title={
                                st.status === 'plugin'
                                  ? `Ativa no ${t.label} via plugin`
                                  : st.native
                                    ? `Pasta nativa no ${t.label} (${st.path})`
                                    : isConflict
                                      ? `Já existe uma pasta real diferente em ${st.path}`
                                      : st.linked
                                        ? `Linkada em ${st.path} — clique para remover link`
                                        : `Clique para linkar esta skill no ${t.label}`
                              }
                              style={{ fontSize: 11.5, gap: 5 }}
                            >
                              {isLocked ? (
                                <Check size={12} />
                              ) : st.linked ? (
                                <Unlink size={11} />
                              ) : (
                                <Link2 size={11} />
                              )}
                              {t.label}
                              <span style={{ opacity: 0.78, fontSize: 10.5 }}>
                                {isBusy
                                  ? '…'
                                  : st.status === 'plugin'
                                    ? '· plugin'
                                    : st.native
                                      ? '· nativo'
                                      : st.linked
                                        ? '· link'
                                        : isConflict
                                          ? '· conflito'
                                          : ''}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
