import { cn } from '@/lib/utils';

/* Dimmed five-bar brand mark used in empty states (matches the Mersennet logo). */
export function FiveBars({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <rect x="1" y="12" width="3" height="8" rx="0.75" />
      <rect x="6" y="8" width="3" height="12" rx="0.75" />
      <rect x="11" y="4" width="3" height="16" rx="0.75" />
      <rect x="16" y="8" width="3" height="12" rx="0.75" />
      <rect x="21" y="12" width="3" height="8" rx="0.75" />
    </svg>
  );
}

/* Terminal-flavored empty state: dimmed five-bar mark, micro-label, action hint. */
export default function EmptyState({
  label,
  hint,
  className,
  compact = false,
}: {
  label: string;
  hint?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex items-center justify-center h-full w-full', compact ? 'py-6' : 'py-8', className)}>
      <div className="text-center px-4">
        <FiveBars size={compact ? 18 : 24} className="mx-auto mb-2 text-dim/30" />
        <p className="text-[11px] uppercase tracking-wider text-dim font-mono">{label}</p>
        {hint && <p className="text-[11px] text-dim/50 mt-1">{hint}</p>}
      </div>
    </div>
  );
}

/* CSS-only shimmer rows for table/list loading states. */
export function SkeletonRows({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn('px-3 py-2.5 space-y-2.5', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-3" style={{ width: `${22 + ((i * 13) % 18)}%` }} />
          <div className="skeleton h-3 flex-1" />
          <div className="skeleton h-3" style={{ width: `${14 + ((i * 7) % 12)}%` }} />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
