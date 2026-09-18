'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import EmptyState, { SkeletonRows } from '@/components/shared/EmptyState';

/**
 * The terminal's table: one header style, one row height, one empty /
 * loading / error treatment, and — the part every ad-hoc table forgot — a
 * horizontal scroller with a minimum width so nothing is clipped on phones.
 *
 * Columns are declared once; cells render through `cell(row)`. Numeric
 * columns are right-aligned mono. Pass `error` for an API failure so it is
 * shown as a failure rather than as an empty list.
 */
export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  numeric?: boolean;
  /** Tailwind classes for <th> and <td> (e.g. 'hidden md:table-cell'). */
  className?: string;
  title?: string;
}

export default function DataTable<T>({
  columns, rows, rowKey, loading = false, error = null, empty, minWidth = 640, dense = false, onRowClick, rowClassName, className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  loading?: boolean;
  error?: string | null;
  /** Empty-state copy (label + optional hint/action). */
  empty?: { label: string; hint?: string; action?: ReactNode };
  minWidth?: number;
  dense?: boolean;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}) {
  const pad = dense ? 'px-3 py-2' : 'px-4 py-2.5';
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-xs" style={{ minWidth }}>
        <thead>
          <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border bg-surface-2/30">
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.title}
                className={cn(pad, 'font-medium whitespace-nowrap',
                  (c.align ?? (c.numeric ? 'right' : 'left')) === 'right' ? 'text-right' : (c.align === 'center' ? 'text-center' : 'text-left'),
                  c.className)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={columns.length} className="p-0"><SkeletonRows rows={4} /></td></tr>
          ) : error ? (
            <tr><td colSpan={columns.length} className="p-0">
              <EmptyState label="Could not load this table" hint={`The API did not answer (${error}). It retries automatically.`} />
            </td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="p-0">
              <EmptyState label={empty?.label ?? 'Nothing here yet'} hint={empty?.hint} action={empty?.action} />
            </td></tr>
          ) : rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn('border-b border-border/40 last:border-0 transition-colors',
                onRowClick && 'cursor-pointer hover:bg-surface-2/50', rowClassName?.(row))}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(pad, 'whitespace-nowrap',
                    (c.align ?? (c.numeric ? 'right' : 'left')) === 'right' ? 'text-right' : (c.align === 'center' ? 'text-center' : 'text-left'),
                    c.numeric && 'font-mono tabular-nums', c.className)}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
