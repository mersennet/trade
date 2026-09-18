import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status pill. Tone carries meaning AND the text always says it (colour is
 * never the only signal): ok = live/active, warn = attention, danger = error /
 * liquidation, info = neutral highlight, muted = metadata.
 */
export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

const TONE: Record<BadgeTone, string> = {
  ok: 'bg-green/10 text-green border-green/30',
  warn: 'bg-yellow/10 text-yellow border-yellow/30',
  danger: 'bg-red/10 text-red border-red/30',
  info: 'bg-primary/10 text-primary border-primary/30',
  muted: 'bg-surface-2 text-dim border-border',
};

export default function Badge({ tone = 'muted', children, className, title, mono = true }: {
  tone?: BadgeTone; children: ReactNode; className?: string; title?: string; mono?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9.5px] font-semibold uppercase tracking-[0.14em] leading-none whitespace-nowrap',
        mono && 'font-mono', TONE[tone], className,
      )}
    >
      {children}
    </span>
  );
}
