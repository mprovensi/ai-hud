import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { api } from '../api';
import type { BurnSeries, Snapshot } from '../types';

export type QuotaProvider = 'claude' | 'codex' | 'gemini';

interface Props {
  provider: QuotaProvider | null;
  snapshot: Snapshot | null;
  onChangeProvider: (p: QuotaProvider) => void;
  onClose: () => void;
  onPollNow: () => void;
  onNotify: (msg: string, err?: boolean) => void;
}

const PROVIDERS: { key: QuotaProvider; label: string; toolName: string; color: string }[] = [
  { key: 'claude', label: 'Claude', toolName: 'Claude Code', color: 'var(--claude)' },
  { key: 'codex', label: 'Codex', toolName: 'Codex', color: 'var(--codex)' },
  { key: 'gemini', label: 'Gemini', toolName: 'Gemini', color: 'var(--gemini)' },
];

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Janela de 5 horas',
  seven_day: 'Janela semanal (7 dias)',
  pro: 'Modelos Pro',
  flash: 'Modelos Flash',
  daily: 'Janela diária',
  sonnet: 'Sonnet semanal',
  opus: 'Opus semanal',
};

function levelColor(pct: number): string {
  if (pct >= 80) return 'var(--danger)';
  if (pct >= 55) return 'var(--warn)';
  return 'var(--ok)';
}

function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtUsd(v: number): string {
  const n = Number(v) || 0;
  if (n > 0 && n < 0.01) return '< US$ 0,01';
  return `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtBrl(usd: number, rate: number): string {
  const n = (Number(usd) || 0) * (Number(rate) || 5.8);
  if (n > 0 && n < 0.01) return '< R$ 0,01';
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `${h}h${m ? String(m).padStart(2, '0') : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtReset(resetsAt: string | number | undefined, now: number): string {
  if (!resetsAt) return '';
  const ts = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt);
  if (!Number.isFinite(ts)) return '';
  const diff = ts - now;
  const hhmm = new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (diff <= 0) return `reinicia agora (${hhmm})`;
  return `reinicia em ${fmtDuration(diff)} (${hhmm})`;
}

function BurnMiniChart({ burn, color }: { burn: BurnSeries; color: string }) {
  const pts = burn.points || [];
  if (pts.length < 2 || !burn.start || !burn.end || burn.end <= burn.start) return null;
  const w = 360;
  const h = 100;
  const span = burn.end - burn.start;
  const toX = (t: number) => Math.max(0, Math.min(w, ((t - burn.start!) / span) * w));
  const toY = (u: number) => h - Math.max(0, Math.min(100, u)) * (h / 100);
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.t).toFixed(1)},${toY(p.used).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const projY = typeof burn.projected === 'number' ? toY(Math.min(100, burn.projected)) : null;

  return (
    <div className="card-item" style={{ marginBottom: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
        <strong>Ritmo da janela</strong>
        <span style={{ color: 'var(--muted)' }}>
          {typeof burn.runsOutIn === 'number' && burn.runsOutIn > 0
            ? `esgota em ~${fmtDuration(burn.runsOutIn)}`
            : typeof burn.projected === 'number'
              ? `projeção: ${Math.round(burn.projected)}%`
              : ''}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 96, display: 'block', background: '#0e1015', borderRadius: 6 }}>
        <line x1="0" y1={h * 0.2} x2={w} y2={h * 0.2} stroke="#262a35" strokeDasharray="3 3" />
        <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke="#262a35" strokeDasharray="3 3" />
        <line x1="0" y1={h * 0.8} x2={w} y2={h * 0.8} stroke="#262a35" strokeDasharray="3 3" />
        <path d={d} fill="none" stroke={color} strokeWidth="2.2" />
        {projY !== null && (
          <line
            x1={toX(last.t)}
            y1={toY(last.used)}
            x2={w}
            y2={projY}
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray="4 4"
            opacity="0.65"
          />
        )}
      </svg>
    </div>
  );
}

export function QuotaDrawer({ provider, snapshot, onChangeProvider, onClose, onPollNow, onNotify }: Props) {
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!provider) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [provider, onClose]);

  if (!provider) return null;

  const meta = PROVIDERS.find((p) => p.key === provider) || PROVIDERS[0];
  const quota = snapshot?.quotas?.[provider];
  const burn = snapshot?.burn?.[provider] || null;
  const now = snapshot?.now || Date.now();
  const windows = Object.entries(quota?.windows || {});
  const todayStats = snapshot?.today?.[meta.toolName];
  const sessToday = snapshot?.sessionsToday?.[meta.toolName] || 0;
  const activeCount = (snapshot?.active || []).filter((s) => s.tool === meta.toolName || (provider === 'gemini' && s.tool === 'Antigravity')).length;
  const costs = snapshot?.costs;
  const fxRate = costs?.usdToBrl || 5.8;
  const costToday = costs?.today?.[meta.toolName];
  const costWeek = costs?.week?.[meta.toolName];
  const costMonth = costs?.month?.[meta.toolName];

  async function doRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await api.refreshQuotas();
      onPollNow();
      onNotify('Cotas atualizadas.');
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="side-drawer-bg right" onClick={onClose}>
      <aside className="side-drawer right" onClick={(e) => e.stopPropagation()} aria-label={`Detalhes de cota ${meta.label}`}>
        <div className="side-drawer-head">
          <span className="qdot" style={{ background: meta.color, width: 10, height: 10 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Uso do plano · {meta.label}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {quota?.plan ? `Plano ${quota.plan}` : meta.toolName}
              {quota?.at ? ` · lido às ${new Date(quota.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </div>
          </div>
          <button className="btn btn-sm btn-icon" onClick={onClose} title="Fechar (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* Troca rápida entre as 3 IAs */}
        <div style={{ padding: '10px 16px 0', flexShrink: 0 }}>
          <div className="seg" style={{ width: '100%' }}>
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                className={provider === p.key ? 'on' : ''}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 8px' }}
                onClick={() => onChangeProvider(p.key)}
              >
                <span className="qdot" style={{ background: p.color }} /> {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="side-drawer-body">
          {quota?.error && (
            <div className="conflict-box" style={{ marginBottom: 0 }}>
              <h4>Erro ao ler cota</h4>
              <div style={{ fontSize: 12.5 }}>{quota.error}</div>
            </div>
          )}

          {/* Janelas de cota */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {windows.length === 0 ? (
              <div className="card-item" style={{ color: 'var(--muted)', fontSize: 13 }}>
                Nenhuma leitura de cota disponível para {meta.label} no momento.
              </div>
            ) : (
              windows.map(([key, w]) => {
                const pct = Math.max(0, Math.min(100, Math.round(w.used || 0)));
                const col = levelColor(pct);
                const resetTxt = fmtReset(w.resetsAt, now);
                return (
                  <div key={key} className="card-item" style={{ marginBottom: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>{WINDOW_LABELS[key] || key}</strong>
                      <span style={{ fontSize: 16, fontWeight: 700, color: col }}>{pct}%</span>
                    </div>
                    <div style={{ height: 10, borderRadius: 999, background: '#0e1015', overflow: 'hidden', border: '1px solid var(--border)' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: 999, transition: 'width .25s' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11.5, color: 'var(--muted)' }}>
                      <span>{resetTxt || '—'}</span>
                      {typeof w.pace === 'number' && <span>ritmo esperado: {Math.round(w.pace)}%</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Gráfico de ritmo/projeção se disponível */}
          {burn && <BurnMiniChart burn={burn} color={meta.color} />}

          {/* Valor equivalente em API (USD / BRL) */}
          {costs && (
            <div className="card-item" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>Valor equivalente (API)</strong>
                <span className="badge" style={{ fontSize: 10 }} title={`Cotação usada (${costs.fxSource || 'estimada'})`}>
                  US$ 1 = R$ {fxRate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7 }}>
                {[
                  { label: 'Hoje', b: costToday },
                  { label: '7 dias', b: costWeek },
                  { label: '30 dias', b: costMonth },
                ].map(({ label, b }) => (
                  <div key={label} style={{ padding: '7px 8px', borderRadius: 8, background: '#111318', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{label}</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 2, color: 'var(--accent)' }}>
                      {fmtUsd(b?.usd || 0)}
                    </div>
                    <div style={{ fontSize: 11, color: '#cfd6e3', marginTop: 1 }}>
                      {fmtBrl(b?.usd || 0, fxRate)}
                    </div>
                  </div>
                ))}
              </div>
              {(costToday && (costToday.input + costToday.output + costToday.cacheRead + costToday.cacheWrite > 0)) && (
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 7 }}>
                  Hoje: {fmtTokens(costToday.input)} in · {fmtTokens(costToday.output)} out
                  {costToday.cacheRead > 0 ? ` · ${fmtTokens(costToday.cacheRead)} cache` : ''}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
                Estimativa baseada nos tokens reais e tabela pública de API por modelo. Em assinaturas fixas (Pro/Max/Plus), indica o valor equivalente consumido dentro do plano.
              </div>
            </div>
          )}

          {/* Resumo do dia */}
          <div className="card-item" style={{ marginBottom: 0 }}>
            <strong style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>Atividade hoje</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ padding: 8, borderRadius: 8, background: '#111318', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Sessões hoje</div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{sessToday}</div>
              </div>
              <div style={{ padding: 8, borderRadius: 8, background: '#111318', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Ativas agora</div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{activeCount}</div>
              </div>
              <div style={{ padding: 8, borderRadius: 8, background: '#111318', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Tokens novos</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtTokens(todayStats?.fresh || 0)}</div>
              </div>
              <div style={{ padding: 8, borderRadius: 8, background: '#111318', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Leitura de cache</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtTokens(todayStats?.cacheRead || 0)}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="side-drawer-foot">
          <button className="btn" onClick={onClose}>Fechar</button>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={refreshing} onClick={doRefresh}>
            <RefreshCw size={13} /> {refreshing ? 'Atualizando…' : 'Atualizar cotas agora'}
          </button>
        </div>
      </aside>
    </div>
  );
}
