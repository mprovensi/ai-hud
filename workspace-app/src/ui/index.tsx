import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { CardStatus } from '../types';

export type ButtonVariant = 'default' | 'primary' | 'danger';
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
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : '',
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
  className = '',
  title,
  children,
}: {
  tone?: BadgeTone;
  mono?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const cls = ['badge', tone !== 'neutral' ? tone : '', mono ? 'mono' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} title={title}>
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

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ModalFrame({
  open,
  onClose,
  closeOnBackdrop = false,
  maxWidth = 640,
  className = '',
  children,
}: {
  open: boolean;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  maxWidth?: number;
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="modal-bg"
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div
        className={`modal ${className}`.trim()}
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
