'use client';
import { useEffect, useRef } from 'react';
import { useStore, type ConditionalOrder } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';

/**
 * Client-side keeper for conditional orders (stop, trailing stop, TWAP).
 *
 * Same model as the TP/SL bracket watcher: the chain has no server-side
 * auto-execution (an API placing orders for an unsigned owner was account
 * takeover), so armed orders live in the local store and this hook executes
 * them while a tab is open — silently through the one-click session key when
 * enabled, otherwise with a wallet confirmation popup at trigger time.
 *
 *   stop      buy: fires when mark >= trigger · sell: fires when mark <= trigger
 *             then a marketable IOC (or a resting GTC limit for stop-limit)
 *   trailing  tracks the extreme mark since armed (low for buys, high for
 *             sells) and fires when mark retraces trailPct from it
 *   twap      one marketable IOC slice every intervalMs until all slices are out
 */
export function useConditionalOrders() {
  const tickers = useStore((s) => s.tickers);
  const conditionals = useStore((s) => s.conditionals);
  const updateConditional = useStore((s) => s.updateConditional);
  const removeConditional = useStore((s) => s.removeConditional);
  const oneClickEnabled = useStore((s) => s.oneClickEnabled);
  const sessionKey = useStore((s) => s.sessionKey);
  const { address, provider } = useWallet();
  const { toast } = useToast();
  const firingRef = useRef<Set<string>>(new Set());

  /** Place one signed order for a conditional; retries transient failures. */
  async function place(c: ConditionalOrder, sizeBase: string, mode: 'take' | 'limit', limitPrice?: number) {
    const { placeOrderOnChain, marketableLimitPrice } = await import('@/lib/orderSigning');
    const MAX_ATTEMPTS = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const priceUsd = mode === 'limit' && limitPrice
          ? String(limitPrice)
          : await marketableLimitPrice(
              c.marketId,
              c.isBuy,
              useStore.getState().slippage || 1,
              useStore.getState().tickers[c.marketId]?.markPrice || 0,
            );
        await placeOrderOnChain(provider, {
          marketId: c.marketId,
          isBuy: c.isBuy,
          priceUsd,
          sizeBase,
          tif: mode === 'limit' ? 'Gtc' : 'Ioc',
          sessionKey: oneClickEnabled ? sessionKey || undefined : undefined,
        });
        return priceUsd;
      } catch (e) {
        lastErr = e as Error;
        if (/user (rejected|denied)/i.test(lastErr.message || '')) break;
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw lastErr || new Error('unknown error');
  }

  async function fireStop(c: ConditionalOrder, mark: number) {
    const label = c.kind === 'trailing' ? 'Trailing stop' : c.limitPrice ? 'Stop-limit' : 'Stop';
    try {
      const px = await place(c, c.size, c.limitPrice ? 'limit' : 'take', c.limitPrice || undefined);
      removeConditional(c.id);
      const what = c.limitPrice ? `limit ${c.isBuy ? 'buy' : 'sell'} ${c.size} resting @ ${px}` : `${c.isBuy ? 'bought' : 'sold'} ${c.size} @ ~${px}`;
      toast(`${label} triggered on ${c.marketSymbol} at ${mark} — ${what}`, 'success');
      useStore.getState().addNotification('fill', `${label} triggered`, `${c.marketSymbol}: mark ${mark}, ${what}`);
      if (useStore.getState().soundEnabled) {
        const { playSound } = await import('@/lib/sounds');
        playSound('fill');
      }
    } catch (e) {
      removeConditional(c.id);
      const msg = (e as Error).message || 'unknown error';
      toast(`${label} on ${c.marketSymbol} triggered but the order FAILED: ${msg}`, 'error');
      useStore.getState().addNotification('warning', `${label} failed`, `${c.marketSymbol}: ${msg}. The order was not placed — re-arm it or trade manually.`);
    }
  }

  async function fireTwapSlice(c: ConditionalOrder) {
    const slices = c.slices || 1;
    const executed = c.executed || 0;
    const total = Number(c.size);
    const per = total / slices;
    // Last slice takes the rounding remainder so the total is exact.
    const sizeThis = executed === slices - 1 ? total - per * (slices - 1) : per;
    const sizeStr = String(Number(sizeThis.toFixed(8)));
    try {
      const px = await place(c, sizeStr, 'take');
      const done = executed + 1;
      if (done >= slices) {
        removeConditional(c.id);
        toast(`TWAP complete on ${c.marketSymbol}: ${slices} slices, ${c.size} total`, 'success');
        useStore.getState().addNotification('fill', 'TWAP complete', `${c.marketSymbol}: ${c.size} over ${slices} slices`);
      } else {
        updateConditional(c.id, { executed: done, nextAt: Date.now() + (c.intervalMs || 60_000) });
        toast(`TWAP slice ${done}/${slices} on ${c.marketSymbol}: ${sizeStr} @ ~${px}`, 'info');
      }
    } catch (e) {
      const msg = (e as Error).message || 'unknown error';
      // Skip this slice, keep the schedule; give up after three consecutive misses.
      const misses = ((c as ConditionalOrder & { misses?: number }).misses || 0) + 1;
      if (misses >= 3) {
        removeConditional(c.id);
        toast(`TWAP on ${c.marketSymbol} stopped after 3 failed slices: ${msg}`, 'error');
        useStore.getState().addNotification('warning', 'TWAP stopped', `${c.marketSymbol}: ${msg}`);
      } else {
        updateConditional(c.id, { nextAt: Date.now() + (c.intervalMs || 60_000), ...({ misses } as Partial<ConditionalOrder>) });
        toast(`TWAP slice failed on ${c.marketSymbol} (${msg}); next slice keeps the schedule`, 'error');
      }
    }
  }

  // Price-driven: stop and trailing.
  useEffect(() => {
    if (!address || conditionals.length === 0) return;
    for (const c of conditionals) {
      if (c.owner.toLowerCase() !== address.toLowerCase()) continue;
      if (c.kind === 'twap') continue;
      if (firingRef.current.has(c.id)) continue;
      const mark = tickers[c.marketId]?.markPrice;
      if (!mark) continue;

      if (c.kind === 'stop' && c.triggerPrice) {
        const hit = c.isBuy ? mark >= c.triggerPrice : mark <= c.triggerPrice;
        if (!hit) continue;
        firingRef.current.add(c.id);
        void fireStop(c, mark).finally(() => firingRef.current.delete(c.id));
        continue;
      }

      if (c.kind === 'trailing' && c.trailPct) {
        // Track the favourable extreme; fire on a retrace of trailPct from it.
        const extreme = c.extreme ?? mark;
        const newExtreme = c.isBuy ? Math.min(extreme, mark) : Math.max(extreme, mark);
        if (newExtreme !== c.extreme) updateConditional(c.id, { extreme: newExtreme });
        const trigger = c.isBuy ? newExtreme * (1 + c.trailPct / 100) : newExtreme * (1 - c.trailPct / 100);
        const hit = c.isBuy ? mark >= trigger : mark <= trigger;
        if (!hit || c.extreme === undefined) continue; // need at least one tracked tick first
        firingRef.current.add(c.id);
        void fireStop(c, mark).finally(() => firingRef.current.delete(c.id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers, conditionals, address]);

  // Clock-driven: TWAP slices.
  useEffect(() => {
    if (!address) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const c of useStore.getState().conditionals) {
        if (c.kind !== 'twap' || c.owner.toLowerCase() !== address.toLowerCase()) continue;
        if (firingRef.current.has(c.id)) continue;
        if ((c.nextAt || 0) > now) continue;
        firingRef.current.add(c.id);
        void fireTwapSlice(c).finally(() => firingRef.current.delete(c.id));
      }
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, oneClickEnabled, sessionKey]);
}
