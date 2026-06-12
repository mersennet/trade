'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const COMMANDS = [
  { label: 'Go to Trade', action: '/trade', keys: 'T' },
  { label: 'Go to Markets', action: '/markets', keys: 'M' },
  { label: 'Go to Portfolio', action: '/portfolio', keys: 'P' },
  { label: 'Go to Vault', action: '/vault', keys: 'V' },
  { label: 'Go to Leaderboard', action: '/leaderboard', keys: 'L' },
  { label: 'Go to Analytics', action: '/analytics', keys: 'A' },
  { label: 'Go to Points', action: '/points', keys: '' },
  { label: 'Go to Competitions', action: '/competitions', keys: '' },
  { label: 'Go to Copy Trading', action: '/copy-trading', keys: '' },
  { label: 'Go to Sub-Accounts', action: '/sub-accounts', keys: '' },
  { label: 'Go to API Docs', action: '/api', keys: '' },
  { label: 'Go to Referrals', action: '/referrals', keys: '' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = COMMANDS.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase())
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-md bg-surface border border-border rounded-xl shadow-[0_0_40px_rgba(0,0,0,0.5)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commands"
          placeholder="Type a command..."
          className="w-full px-4 py-3 bg-transparent text-foreground text-sm border-b border-border outline-none placeholder:text-dim"
        />
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.map((cmd) => (
            <button
              key={cmd.label}
              onClick={() => { router.push(cmd.action); setOpen(false); }}
              className="w-full px-4 py-2.5 text-left text-xs text-foreground/80 hover:bg-surface-2 hover:text-foreground flex items-center justify-between transition-colors duration-150"
            >
              <span>{cmd.label}</span>
              {cmd.keys && (
                <kbd className="text-[10px] text-dim bg-surface-2 px-1.5 py-0.5 rounded border border-border font-mono">{cmd.keys}</kbd>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-dim">No commands found</div>
          )}
        </div>
      </div>
    </div>
  );
}
