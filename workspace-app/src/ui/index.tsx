import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { X } from 'lucide-react';
import type { CardStatus } from '../types';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'play' | 'ghost';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  iconOnly = false,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'danger'
        ? 'btn-danger'
        : variant === 'play'
          ? 'run-play-btn'
          : variant === 'ghost'
            ? 'ds-btn-ghost'
            : '',
    size === 'sm' ? 'btn-sm' : '',
    iconOnly ? 'btn-icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={cls} {...rest} />;
}

export type BadgeTone =
  | 'neutral'
  | 'working'
  | 'waiting'
  | 'permission'
  | CardStatus;

export function Badge({
  tone = 'neutral',
  mono = false,
  compact = false,
  className = '',
  title,
  style,
  children,
}: {
  tone?: BadgeTone;
  mono?: boolean;
  compact?: boolean;
  className?: string;
  title?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const cls = ['badge', tone !== 'neutral' ? tone : '', mono ? 'mono' : '', compact ? 'ds-badge-xs' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} title={title} style={style}>
      {children}
    </span>
  );
}

export function StageDot({ stage }: { stage: CardStatus }) {
  return <span className={`col-dot ${stage}`} />;
}

export function StatusDot({ kind, title }: { kind: 'working' | 'attention' | 'recent'; title?: string }) {
  return <span className={`sb-dot ${kind}`} title={title} />;
}

export function ToolIcon({ tool, size = 12 }: { tool?: string; size?: number }) {
  const t = String(tool || '').toLowerCase();
  const style: CSSProperties = { width: size, height: size, flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' };

  if (t.includes('claude')) {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="var(--ds-claude)" strokeWidth="1.7" strokeLinecap="round" style={style} aria-hidden="true">
        <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
      </svg>
    );
  }
  if (t.includes('codex') || t.includes('openai')) {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="var(--ds-codex)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
        <polygon points="8,1.8 13.4,4.9 13.4,11.1 8,14.2 2.6,11.1 2.6,4.9" />
        <circle cx="8" cy="8" r="2.1" />
      </svg>
    );
  }
  if (t.includes('gemini') || t.includes('antigravity')) {
    return (
      <svg viewBox="0 0 16 16" fill="var(--ds-gemini)" style={style} aria-hidden="true">
        <path d="M8 1.2c.6 3.5 3.3 6.2 6.8 6.8-3.5.6-6.2 3.3-6.8 6.8-.6-3.5-3.3-6.2-6.8-6.8C4.7 7.4 7.4 4.7 8 1.2Z" />
      </svg>
    );
  }
  if (t.includes('ollama')) {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="var(--ds-ollama)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
        <path d="M5.2 2.2v3.2M10.8 2.2v3.2M4.4 6.2c0-1 .8-1.8 1.8-1.8h3.6c1 0 1.8.8 1.8 1.8v3.6a3.6 3.6 0 0 1-7.2 0V6.2Z" />
        <circle cx="6.6" cy="8" r=".7" fill="var(--ds-ollama)" />
        <circle cx="9.4" cy="8" r=".7" fill="var(--ds-ollama)" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="var(--muted)" strokeWidth="1.6" strokeLinecap="round" style={style} aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

export function EmptyState({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <div className={`empty ${compact ? 'ds-empty-sm' : ''}`}>{children}</div>;
}

export function Field({
  label,
  action,
  className = '',
  children,
}: {
  label: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field ds-field ${className}`.trim()}>
      {action ? (
        <div className="ds-row-between ds-mb-1">
          <label className="ds-m0">{label}</label>
          {action}
        </div>
      ) : (
        <label>{label}</label>
      )}
      {children}
    </div>
  );
}

export function KpiBox({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="ds-kpi-box">
      <div className="ds-kpi-lbl">{label}</div>
      <div className={`ds-kpi-val ${accent ? 'ds-text-accent' : ''}`}>{value}</div>
      {sub && <div className="ds-kpi-sub">{sub}</div>}
    </div>
  );
}

export function MetricBar({ pct, color }: { pct: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div className="ds-progress-track">
      <div className="ds-progress-fill" style={{ width: `${clamped}%`, background: color }} />
    </div>
  );
}

export function ModalFrame({
  open,
  onClose,
  closeOnBackdrop = false,
  maxWidth = 640,
  height,
  title,
  subtitle,
  titleBadge,
  headerActions,
  footer,
  className = '',
  closeDisabled = false,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  maxWidth?: number;
  height?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  titleBadge?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="modal-bg"
      onClick={closeOnBackdrop && onClose && !closeDisabled ? onClose : undefined}
    >
      <div
        className={`modal ds-modal-shell ${className}`.trim()}
        style={{ maxWidth, ...(height ? { height } : {}) }}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || headerActions || onClose) && (
          <div className="ds-modal-head">
            <div className="ds-modal-title-wrap">
              <div className="ds-row ds-wrap">
                {title && <h3 className="ds-modal-title">{title}</h3>}
                {titleBadge}
              </div>
              {subtitle && <div className="ds-modal-sub">{subtitle}</div>}
            </div>
            <div className="ds-row ds-wrap">
              {headerActions}
              {onClose && (
                <Button size="sm" iconOnly disabled={closeDisabled} onClick={onClose} title="Fechar (Esc)" aria-label="Fechar">
                  <X size={15} />
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="ds-modal-body">{children}</div>
        {footer && <div className="ds-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function DrawerFrame({
  open,
  side = 'left',
  title,
  subtitle,
  leading,
  subHeader,
  footer,
  ariaLabel,
  onClose,
  closeOnBackdrop = true,
  children,
}: {
  open: boolean;
  side?: 'left' | 'right';
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  subHeader?: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className={`side-drawer-bg ${side === 'right' ? 'right' : ''}`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <aside
        className={`side-drawer ${side === 'right' ? 'right' : ''}`}
        onClick={(e) => e.stopPropagation()}
        aria-label={ariaLabel}
      >
        <div className="side-drawer-head">
          {leading}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 className="ds-modal-title">{title}</h3>
            {subtitle && <div className="ds-modal-sub">{subtitle}</div>}
          </div>
          <Button size="sm" iconOnly onClick={onClose} title="Fechar (Esc)" aria-label="Fechar">
            <X size={16} />
          </Button>
        </div>
        {subHeader}
        <div className="side-drawer-body">{children}</div>
        {footer && <div className="side-drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}
