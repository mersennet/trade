'use client';
import { useEffect, useRef } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';

/**
 * Turns account state changes into notifications (bell in the header):
 *
 *  - a position's size changing → "Filled" (the chain has no per-user fill
 *    stream on the WS yet; positions are polled by the terminal already),
 *  - mark price within 5% of a position's liquidation price → one warning
 *    per position until it moves back out of the band,
 *  - a position closing → "Position closed".
 *
 * The first snapshot after connecting is a baseline, not an event.
 */
const LIQ_WARN_BAND = 0.05;

export function useAccountEvents() {
  const { address } = useWallet();
  const positions = useStore((s) => s.positions);
  const prev = useRef<Map<number, { size: number; symbol: string }> | null>(null);
  const warned = useRef<Set<number>>(new Set());
  const forAddress = useRef<string | null>(null);

  useEffect(() => {
    if (!address) {
      prev.current = null;
      warned.current.clear();
      forAddress.current = null;
      return;
    }
    // Wallet switched: reset the baseline.
    if (forAddress.current !== address) {
      forAddress.current = address;
      prev.current = null;
      warned.current.clear();
    }
    const now = new Map<number, { size: number; symbol: string }>();
    for (const p of positions) now.set(p.marketId, { size: Number(p.size) || 0, symbol: p.symbol });

    const notify = useStore.getState().addNotification;
    if (prev.current) {
      for (const [marketId, cur] of now) {
        const before = prev.current.get(marketId)?.size ?? 0;
        if (cur.size !== before) {
          const delta = cur.size - before;
          if (cur.size === 0) {
            notify('fill', `${cur.symbol} position closed`, `Closed ${Math.abs(before)} ${cur.symbol}`);
          } else {
            notify('fill', `${cur.symbol} filled`, `${delta > 0 ? '+' : ''}${delta} ${cur.symbol} · now ${cur.size > 0 ? 'long' : 'short'} ${Math.abs(cur.size)}`);
          }
        }
      }
      for (const [marketId, before] of prev.current) {
        if (!now.has(marketId) && before.size !== 0) {
          notify('fill', `${before.symbol} position closed`, `Closed ${Math.abs(before.size)} ${before.symbol}`);
        }
      }
    }
    prev.current = now;

    // Liquidation proximity.
    for (const p of positions) {
      const size = Number(p.size) || 0;
      const mark = Number(p.markPrice) || 0;
      const liq = Number(p.liquidationPrice) || 0;
      if (!size || !mark || !liq) continue;
      const dist = Math.abs(mark - liq) / mark;
      if (dist < LIQ_WARN_BAND) {
        if (!warned.current.has(p.marketId)) {
          warned.current.add(p.marketId);
          notify('warning', `${p.symbol} near liquidation`, `Mark ${mark} is ${(dist * 100).toFixed(1)}% from liquidation at ${liq}. Add collateral or reduce size.`);
        }
      } else if (dist > LIQ_WARN_BAND * 2) {
        warned.current.delete(p.marketId);
      }
    }
  }, [address, positions]);
}
