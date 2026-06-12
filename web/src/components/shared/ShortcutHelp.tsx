'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/stores/useStore';

const SHORTCUTS = [
  { keys: ['Ctrl', 'K'], description: 'Command palette' },
  { keys: ['?'], description: 'Show this help' },
  { keys: ['Esc'], description: 'Close modal' },
  { keys: ['B'], description: 'Buy / Long' },
  { keys: ['S'], description: 'Sell / Short' },
  { keys: ['L'], description: 'Limit order' },
  { keys: ['M'], description: 'Market order' },
  { keys: ['T'], description: 'Go to Trade' },
  { keys: ['P'], description: 'Go to Portfolio' },
  { keys: ['V'], description: 'Go to Vault' },
  { keys: ['A'], description: 'Go to Analytics' },
];

export default function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const setTrade = useStore((s) => s.setTrade);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === '?' || (e.ctrlKey && e.key === '/')) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') { setOpen(false); return; }

      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (key) {
        case 'b': setTrade({ side: 'buy' }); break;
        case 's': setTrade({ side: 'sell' }); break;
        case 'l': setTrade({ orderType: 'limit' }); break;
        case 'm': setTrade({ orderType: 'market' }); break;
        case 't': router.push('/trade'); break;
        case 'p': router.push('/portfolio'); break;
        case 'v': router.push('/vault'); break;
        case 'a': router.push('/analytics'); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [router, setTrade]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="relative w-full max-w-md bg-surface border border-border rounded-xl shadow-[0_0_40px_rgba(0,0,0,0.5)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 id="shortcut-help-title" className="text-sm font-semibold text-foreground">Keyboard Shortcuts</h2>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close keyboard shortcuts"
            className="text-dim hover:text-foreground text-xs transition-colors duration-150"
          >
            Esc
          </button>
        </div>
        <div className="p-3 max-h-[60vh] overflow-y-auto space-y-1">
          {SHORTCUTS.map((s) => (
            <div
              key={s.description}
              className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-surface-2 transition-colors duration-150"
            >
              <span className="text-xs text-foreground/80">{s.description}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="min-w-[24px] text-center text-[10px] text-dim bg-surface-2 px-1.5 py-1 rounded border border-border font-mono"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-border">
          <p className="text-[10px] text-dim text-center">
            Press <kbd className="text-[10px] bg-surface-2 px-1 py-0.5 rounded border border-border font-mono">?</kbd> or{' '}
            <kbd className="text-[10px] bg-surface-2 px-1 py-0.5 rounded border border-border font-mono">Ctrl+/</kbd> to toggle
          </p>
        </div>
      </div>
    </div>
  );
}
