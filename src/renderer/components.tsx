import type { ReactNode } from 'react';
import type { ConceptStatus, Domain } from '@shared/types';
import { STATUS_SYMBOL, STATUS_LABEL, DOMAIN_LABEL } from '@shared/types';

export function StatusDot({ status, title }: { status: ConceptStatus; title?: string }) {
  return (
    <span className={`dot ${status}`} title={title ?? STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]}>
      {STATUS_SYMBOL[status]}
    </span>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {hint && <div>{hint}</div>}
      {action && <div style={{ marginTop: 'var(--space-4)' }}>{action}</div>}
    </div>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      {message}
      {onRetry && (
        <span className="btn sm" style={{ marginLeft: 'var(--space-3)' }} onClick={onRetry}>
          重试
        </span>
      )}
    </div>
  );
}

/** 骨架屏 —— 不用 spinner，内容区高度不塌陷（PRD §8） */
export function Skeleton({ rows = 4, height = 56 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div className="skeleton" style={{ height: 28, width: '40%' }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function ProgressRing({ percent, size = 34 }: { percent: number; size?: number }) {
  const r = 15.5;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <svg className="ring" viewBox="0 0 36 36" width={size} height={size} role="img" aria-label={`完成 ${p}%`}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--surface-raised)" strokeWidth="4" />
      <circle
        cx="18" cy="18" r={r} fill="none" stroke="var(--brand)" strokeWidth="4"
        strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - p / 100)}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export const DOMAIN_ORDER: Domain[] = ['econ', 'finance', 'hotspot'];

export { DOMAIN_LABEL, STATUS_LABEL, STATUS_SYMBOL };
