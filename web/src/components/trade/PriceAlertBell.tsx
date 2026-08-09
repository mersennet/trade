'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/stores/useStore';
import { cn, formatPrice } from '@/lib/utils';
import { ensureNotificationPermission } from '@/hooks/usePriceAlerts';

/**
 * Price-alert bell in the market bar: set a target above/below the current
 * mark; the usePriceAlerts watcher fires a browser + in-app notification on
 * the crossing and clears the alert.
 */
export default function PriceAlertBell({ marketId }: { marketId: number }) {
  const alerts = useStore((s) => s.priceAlerts);
  const addPriceAlert = useStore((s) => s.addPriceAlert);
  const removePriceAlert = useStore((s) => s.removePriceAlert);
  const mark = useStore((s) => s.tickers[marketId]?.markPrice || 0);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const marketAlerts = alerts.filter((a) => a.marketId === marketId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const add = () => {
    const price = parseFloat(target);
    if (!price || price <= 0 || !mark) return;
    addPriceAlert({
      id: `${Date.now()}-${Math.random()}`,
      marketId,
      direction: price >= mark ? 'above' : 'below',
      price,
      created: Date.now(),
    });
    ensureNotificationPermission();
    setTarget('');
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label={marketAlerts.length ? `Price alerts, ${marketAlerts.length} active` : 'Set a price alert'}
        aria-expanded={open}
        title="Price alerts"
        className={cn(
          'p-1 rounded-md transition-colors',
          marketAlerts.length > 0 ? 'text-yellow hover:text-yellow/80' : 'text-dim hover:text-foreground'
        )}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-surface border border-border rounded-xl shadow-xl z-50 p-3">
          <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-2">Price alert · mark {formatPrice(mark)}</p>
          <div className="flex gap-1.5 mb-2">
            <input
              type="number"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              placeholder="Target price"
              aria-label="Alert target price"
              className="flex-1 bg-surface-2 border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-primary/40"
            />
            <button
              onClick={add}
              disabled={!target}
              className="px-2.5 py-1.5 bg-primary text-black rounded-md text-[11px] font-semibold hover:brightness-110 disabled:opacity-40 transition-all"
            >Set</button>
          </div>
          <p className="text-[9.5px] text-dim mb-1">Fires once when mark crosses the target. Above/below is inferred from the current mark.</p>
          {marketAlerts.length > 0 && (
            <div className="space-y-1 pt-1.5 border-t border-border/50">
              {marketAlerts.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-[11px] font-mono">
                  <span className="text-foreground/80">
                    {a.direction === 'above' ? '≥' : '≤'} {formatPrice(a.price)}
                  </span>
                  <button
                    onClick={() => removePriceAlert(a.id)}
                    aria-label={`Remove alert at ${a.price}`}
                    className="text-dim hover:text-red transition-colors"
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
