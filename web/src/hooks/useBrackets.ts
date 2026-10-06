'use client';
import { useEffect } from 'react';
import { useStore, type Bracket } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { livePositionSize } from '@/lib/positions';
import { api } from '@/lib/api';

const UNFILLED_GRACE_MS = 60_000;
const FLAT_CONFIRM_MS = 8_000;
let pruning = false;
const firing = new Set<string>();
const flatSince = new Map<string, number>();

/**
 * Drop the owner's brackets whose position is gone: closed by hand, liquidated,
 * flipped or closed in another tab. Otherwise they stay armed, and drawn on
 * the chart, until a trigger happens to cross. A bracket set with a resting
 * order exists before its position does, so one that has never seen its
 * position open goes only when it is over a minute old and no order of the
 * owner rests on that market. When the chain does not answer, nothing goes.
 * rpc.mersennet.com has several origins and one catching up after a restart
 * can briefly serve a state from before the position opened, so the position
 * must read flat on two passes FLAT_CONFIRM_MS apart.
 */
export async function pruneClosedBrackets(owner: string, marketId?: number) {
  if (pruning) return;
  pruning = true;
  try {
    const store = useStore.getState;
    const mine = store().brackets.filter((b) => b.owner.toLowerCase() === owner.toLowerCase()
      && (marketId === undefined || b.marketId === marketId));
    let restingMarkets: Set<number> | null = null;
    for (const b of mine) {
      if (firing.has(b.id)) continue;
      const live = await livePositionSize(b.owner, b.marketId);
      if (live === null) continue;
      const current = store().brackets.find((x) => x.id === b.id);
      if (!current || current.ts !== b.ts || firing.has(b.id)) continue;
      const held = current.isLong ? live : -live;
      const key = `${current.id}:${current.ts}`;
      if (held > 0) {
        flatSince.delete(key);
        if (!current.seenOpen) store().setBracket({ ...current, seenOpen: true });
        continue;
      }
      if (!current.seenOpen) {
        if (Date.now() - current.ts < UNFILLED_GRACE_MS) continue;
        if (restingMarkets === null) {
          try {
            const res = await api.getOrders(owner);
            restingMarkets = new Set(res.orders.map((o) => Number(o.market_id)));
          } catch {
            return;
          }
        }
        if (restingMarkets.has(current.marketId)) continue;
      }
      const first = flatSince.get(key);
      if (first === undefined) {
        flatSince.set(key, Date.now());
        continue;
      }
      if (Date.now() - first < FLAT_CONFIRM_MS) continue;
      flatSince.delete(key);
      store().removeBracket(current.id);
      store().addNotification('info', 'TP/SL removed', `Market ${current.marketId}: the position it protected is closed.`);
    }
  } finally {
    pruning = false;
  }
}

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

  async function fireBracket(b: Bracket, leg: 'tp' | 'sl') {
    const label = leg === 'tp' ? 'Take-profit' : 'Stop-loss';
    const { placeOrderOnChain, marketableLimitPrice } = await import('@/lib/orderSigning');
    const isBuy = !b.isLong; // closing a long sells, closing a short buys

    // A transient failure (RPC hiccup, brief nonce race) must not silently
    // consume the user's protection: retry with backoff before giving up. An
    // explicit wallet rejection is respected immediately — the user said no.
    const MAX_ATTEMPTS = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Close what is held now: the position may have shrunk, closed or
        // flipped since the bracket was set, and an order for the old size
        // would then open or flip a position instead of closing one.
        const live = await livePositionSize(b.owner, b.marketId);
        if (live === null) throw new Error('could not read the position from the chain');
        const held = b.isLong ? live : -live;
        if (held <= 0) {
          removeBracket(b.id);
          useStore.getState().addNotification('info', `${label} removed`, `Market ${b.marketId}: the position it protected is already closed.`);
          return;
        }
        const closeSize = Math.min(Math.floor(Number(b.size)), held);
        const price = await marketableLimitPrice(
          b.marketId,
          isBuy,
          useStore.getState().slippage || 1,
          useStore.getState().tickers[b.marketId]?.markPrice || 0,
        );
        await placeOrderOnChain(provider, {
          marketId: b.marketId,
          isBuy,
          priceUsd: price,
          sizeBase: String(closeSize),
          tif: 'Ioc',
          sessionKey: oneClickEnabled ? sessionKey || undefined : undefined,
        });
        toast(`${label} triggered — closing ${closeSize} (market ${b.marketId})`, 'success');
        useStore.getState().addNotification('fill', `${label} triggered`, `Closed ${closeSize} on market ${b.marketId} @ ${tickers[b.marketId]?.markPrice ?? '—'}`);
        removeBracket(b.id);
        return;
      } catch (e) {
        lastErr = e as Error;
        if (/user (rejected|denied)/i.test(lastErr.message || '')) break;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
    // All attempts failed — the bracket is spent (leaving it would loop forever
    // against a persistent failure), so make the loss of protection loud: a
    // persistent notification plus an error toast, not just a transient toast.
    removeBracket(b.id);
    const msg = lastErr?.message || 'unknown error';
    toast(`${label} trigger FAILED after ${MAX_ATTEMPTS} attempts — your position is UNPROTECTED: ${msg}`, 'error');
    useStore.getState().addNotification(
      'warning',
      `${label} failed — position unprotected`,
      `Market ${b.marketId}: the closing order could not be placed (${msg}). Re-add TP/SL from the positions table or close manually.`,
    );
  }

  useEffect(() => {
    if (!address) return;
    const run = () => { void pruneClosedBrackets(address); };
    run();
    const timer = setInterval(run, 10_000);
    return () => clearInterval(timer);
  }, [address]);

  useEffect(() => {
    if (!address || brackets.length === 0) return;

    for (const b of brackets) {
      if (b.owner.toLowerCase() !== address.toLowerCase()) continue;
      if (firing.has(b.id)) continue;
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

      firing.add(b.id);
      void fireBracket(b, fire).finally(() => firing.delete(b.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers, brackets, address]);
}
