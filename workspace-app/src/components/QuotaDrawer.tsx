import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, DrawerFrame, KpiBox, MetricBar, ToolIcon } from '../ui';
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
  { key: 'claude', label: 'Claude', toolName: 'Claude Code', color: 'var(--ds-claude)' },
  { key: 'codex', label: 'Codex', toolName: 'Codex', color: 'var(--ds-codex)' },
  { key: 'gemini', label: 'Gemini', toolName: 'Gemini', color: 'var(--ds-gemini)' },
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
  if (pct >= 85) return 'var(--ds-danger)';
  if (pct >= 50) return 'var(--ds-warn)';
  return 'var(--ds-ok)';
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
    <div className="card-item ds-m0">
      <div className="ds-row-between" style={{ marginBottom: 8, fontSize: 12 }}>
        <strong>Ritmo da janela</strong>
        <span className="ds-text-muted">
          {typeof burn.runsOutIn === 'number' && burn.runsOutIn > 0
            ? `esgota em ~${fmtDuration(burn.runsOutIn)}`
            : typeof burn.projected === 'number'
              ? `projeção: ${Math.round(burn.projected)}%`
              : ''}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 96, display: 'block', background: 'var(--ds-bg)', borderRadius: 6 }}>
        <line x1="0" y1={h * 0.2} x2={w} y2={h * 0.2} stroke="var(--ds-border)" strokeDasharray="3 3" />
        <line x1="0" y1={h * 0.5} x2={w} y2={h * 0.5} stroke="var(--ds-border)" strokeDasharray="3 3" />
        <line x1="0" y1={h * 0.8} x2={w} y2={h * 0.8} stroke="var(--ds-border)" strokeDasharray="3 3" />
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
    <DrawerFrame
      open={!!provider}
      side="right"
      ariaLabel={`Detalhes de cota ${meta.label}`}
      onClose={onClose}
      leading={<ToolIcon tool={meta.toolName} size={18} />}
      title={`Uso do plano · ${meta.label}`}
      subtitle={
        <>
          {quota?.plan ? `Plano ${quota.plan}` : meta.toolName}
          {quota?.at ? ` · lido às ${new Date(quota.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </>
      }
      subHeader={
        <div style={{ padding: '10px 16px 0', flexShrink: 0 }}>
          <div className="seg" style={{ width: '100%' }}>
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                className={provider === p.key ? 'on' : ''}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 8px' }}
                onClick={() => onChangeProvider(p.key)}
              >
                <ToolIcon tool={p.toolName} size={12} /> {p.label}
              </button>
            ))}
          </div>
        </div>
      }
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" className="ds-flex-1" disabled={refreshing} onClick={doRefresh}>
            <RefreshCw size={13} /> {refreshing ? 'Atualizando…' : 'Atualizar cotas agora'}
          </Button>
        </>
      }
    >
      {quota?.error && (
        <div className="conflict-box ds-m0">
          <h4>Erro ao ler cota</h4>
          <div style={{ fontSize: 12.5 }}>{quota.error}</div>
        </div>
      )}

      {/* Janelas de cota */}
      <div className="ds-stack">
        {windows.length === 0 ? (
          <div className="card-item ds-text-muted" style={{ fontSize: 13 }}>
            Nenhuma leitura de cota disponível para {meta.label} no momento.
          </div>
        ) : (
          windows.map(([key, w]) => {
            const pct = Math.max(0, Math.min(100, Math.round(w.used || 0)));
            const col = levelColor(pct);
            const resetTxt = fmtReset(w.resetsAt, now);
            return (
              <div key={key} className="card-item ds-m0">
                <div className="ds-row-between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>{WINDOW_LABELS[key] || key}</strong>
                  <span style={{ fontSize: 16, fontWeight: 700, color: col }}>{pct}%</span>
                </div>
                <MetricBar pct={pct} color={col} />
                <div className="ds-row-between ds-text-muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                  <span>{resetTxt || '—'}</span>
                  {typeof w.pace === 'number' && <span>ritmo esperado: {Math.round(w.pace)}%</span>}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Gráfico de ritmo/projeção */}
      {burn && <BurnMiniChart burn={burn} color={meta.color} />}

      {/* Valor equivalente em API (USD / BRL) */}
      {costs && (
        <div className="card-item ds-m0">
          <div className="ds-row-between" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>Valor equivalente (API)</strong>
            <Badge compact title={`Cotação usada (${costs.fxSource || 'estimada'})`}>
              US$ 1 = R$ {fxRate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Badge>
          </div>
          <div className="ds-grid-3">
            {[
              { label: 'Hoje', b: costToday },
              { label: '7 dias', b: costWeek },
              { label: '30 dias', b: costMonth },
            ].map(({ label, b }) => (
              <KpiBox
                key={label}
                label={label}
                value={fmtUsd(b?.usd || 0)}
                sub={fmtBrl(b?.usd || 0, fxRate)}
                accent
              />
            ))}
          </div>
          {costToday && (costToday.input + costToday.output + costToday.cacheRead + costToday.cacheWrite > 0) && (
            <div className="ds-text-muted" style={{ fontSize: 10.5, marginTop: 7 }}>
              Hoje: {fmtTokens(costToday.input)} in · {fmtTokens(costToday.output)} out
              {costToday.cacheRead > 0 ? ` · ${fmtTokens(costToday.cacheRead)} cache` : ''}
            </div>
          )}
          <div className="ds-text-muted" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.4 }}>
            Estimativa baseada nos tokens reais e tabela pública de API por modelo. Em assinaturas fixas (Pro/Max/Plus), indica o valor equivalente consumido dentro do plano.
          </div>
        </div>
      )}

      {/* Resumo do dia */}
      <div className="card-item ds-m0">
        <strong style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>Atividade hoje</strong>
        <div className="ds-grid-2">
          <KpiBox label="Sessões hoje" value={sessToday} />
          <KpiBox label="Ativas agora" value={activeCount} />
          <KpiBox label="Tokens novos" value={fmtTokens(todayStats?.fresh || 0)} />
          <KpiBox label="Leitura de cache" value={fmtTokens(todayStats?.cacheRead || 0)} />
        </div>
      </div>
    </DrawerFrame>
  );
}
