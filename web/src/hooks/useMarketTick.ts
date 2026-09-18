'use client';
import { useEffect, useState } from 'react';
import { api, type Market } from '@/lib/api';
import { getPriceScale } from '@/lib/priceScale';

/**
 * The market's price tick in quote units (tickSize ÷ priceScale — $0.01 on
 * MRSN/SOL/ARB after the rescale, $10 on BTC) and the decimals needed to show
 * it. Falls back to 1 until the market list and scale are known.
 */
export function useMarketTick(market: Pick<Market, 'id' | 'tickSize'>): { tick: number; decimals: number; step: string } {
  const [tick, setTick] = useState(1);
  useEffect(() => {
    let alive = true;
    (async () => {
      let tickSize = Number(market.tickSize ?? 0);
      if (!tickSize) {
        try { tickSize = Number((await api.getMarkets()).markets.find((m) => m.id === market.id)?.tickSize ?? 1); } catch { tickSize = 1; }
      }
      const scale = await getPriceScale(market.id).catch(() => 1);
      if (alive) setTick(Math.max(1, tickSize) / scale);
    })();
    return () => { alive = false; };
  }, [market.id, market.tickSize]);
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return { tick, decimals, step: tick >= 1 ? String(Math.round(tick * 100) / 100) : tick.toFixed(decimals) };
}
