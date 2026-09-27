'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * One-line shell command with a COPY button. The button reads "Copied" for
 * 1.5 s; if the clipboard is blocked (plain http, permissions) the text stays
 * selectable, so nothing is lost.
 */
export default function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };
  return (
    <div className={cn('flex items-center gap-1 rounded bg-surface-2 pr-0.5', className)}>
      <code className="flex-1 min-w-0 block font-mono text-[11px] text-foreground px-2 py-1 overflow-x-auto whitespace-nowrap">{command}</code>
      <button
        type="button"
        onClick={copy}
        title="Copy to clipboard"
        aria-live="polite"
        className={cn(
          'shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors',
          copied ? 'text-green bg-green/15' : 'text-primary bg-primary/10 hover:bg-primary/20',
        )}
      >{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}
