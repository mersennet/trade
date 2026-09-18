'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export const UPGRADE_CMD = 'curl -fsSL https://mersennet.com/downloads/install.sh | sudo bash';

/**
 * "Upgrade → <latest>" marker for a node on an older build. Click unfolds the
 * exact command (with copy) so an operator never has to look it up.
 */
export default function UpgradeBadge({ build, latest, className }: { build?: string | null; latest?: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(UPGRADE_CMD); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {build && <span className="font-mono text-[11px] text-dim">{build}</span>}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Behind the current release${latest ? ` ${latest}` : ''} — click for the command`}
        className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20"
      >Upgrade{latest ? ` → ${latest}` : ''}</button>
      {open && (
        <span className="basis-full mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[11px]">
          <code className="font-mono text-foreground break-all">{UPGRADE_CMD}</code>
          <button type="button" onClick={copy} className="text-primary hover:underline shrink-0">{copied ? 'Copied' : 'Copy'}</button>
          <span className="basis-full text-dim">Run on the node as root. Keeps keys, state and operator; ~1 min. <a href="https://docs.mersennet.com/validators/run-a-node/#step-4--keep-it-running" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Guide →</a></span>
        </span>
      )}
    </span>
  );
}
