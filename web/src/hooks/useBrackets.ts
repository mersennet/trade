'use client';
import { useEffect, useRef } from 'react';
import { useStore, type Bracket } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';

/**
 * Client-side TP/SL bracket watcher.
 *
 * The chain has no server-side auto-execution (disabled in the auth
 * hardening: an API executing orders for an unsigned owner was account
 * takeover). Brackets therefore live in the local store and are executed by
 * this watcher while the user's session is open: when the mark price crosses
 * a trigger, it submits a signed reduce-only IOC — silently via the one-click
 * session key when enabled, otherwise with a wallet confirmation popup.
 *
 * Trigger semantics (correct TP/SL direction, unlike a plain stop):
 *   long  (close = sell): TP fires when mark >= tp, SL fires when mark <= sl
 *   short (close = buy):  TP fires when mark <= tp, SL fires when mark >= sl
 */
export function useBrackets() {
  const tickers = useStore((s) => s.tickers);
  const brackets = useStore((s) => s.brackets);
  const removeBracket = useStore((s) => s.removeBracket);
  const oneClickEnabled = useStore((s) => s.oneClickEnabled);
  const sessionKey = useStore((s) => s.sessionKey);
  const { address, provider } = useWallet();
  const { toast } = useToast();
  const firingRef = useRef<Set<string>>(new Set());

  async function fireBracket(b: Bracket, leg: 'tp' | 'sl') {
    const label = leg === 'tp' ? 'Take-profit' : 'Stop-loss';
    try {
      const { placeOrderOnChain, marketableLimitPrice } = await import('@/lib/orderSigning');
      const isBuy = !b.isLong; // closing a long sells, closing a short buys
      const price = await marketableLimitPrice(
        b.marketId,
        isBuy,
        useStore.getState().slippage || 1,
        tickers[b.marketId]?.markPrice || 0,
      );
      await placeOrderOnChain(provider, {
        marketId: b.marketId,
        isBuy,
        priceUsd: price,
        sizeBase: b.size,
        tif: 'Ioc',
        sessionKey: oneClickEnabled ? sessionKey || undefined : undefined,
      });
      toast(`${label} triggered — closing ${b.size} (market ${b.marketId})`, 'success');
    } catch (e) {
      toast(`${label} trigger failed: ${(e as Error).message}`, 'error');
    } finally {
      // Either way the bracket is spent — a failed fire must not loop.
      removeBracket(b.id);
    }
  }

  useEffect(() => {
    if (!address || brackets.length === 0) return;

    for (const b of brackets) {
      if (b.owner.toLowerCase() !== address.toLowerCase()) continue;
      if (firingRef.current.has(b.id)) continue;
      const mark = tickers[b.marketId]?.markPrice;
      if (!mark) continue;

      const tp = b.tp ? Number(b.tp) : null;
      const sl = b.sl ? Number(b.sl) : null;
      let fire: 'tp' | 'sl' | null = null;
      if (b.isLong) {
        if (tp && mark >= tp) fire = 'tp';
        else if (sl && mark <= sl) fire = 'sl';
      } else {
        if (tp && mark <= tp) fire = 'tp';
        else if (sl && mark >= sl) fire = 'sl';
      }
      if (!fire) continue;

      firingRef.current.add(b.id);
      void fireBracket(b, fire).finally(() => firingRef.current.delete(b.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers, brackets, address]);
}
