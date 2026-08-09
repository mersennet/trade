/**
 * Shared cash-flow PnL model — the same model the indexer's leaderboard uses
 * (a sell brings cash in, a buy sends cash out; realized PnL when flat, cost
 * basis while open). Used by the analytics page and the portfolio performance
 * card so both tell the same story.
 */
import type { Trade } from '@/lib/api';

export function tradeCashFlow(t: Pick<Trade, 'side' | 'price' | 'size'>): number {
  return (t.side === 'sell' ? 1 : -1) * Number(t.price) * Number(t.size);
}

/** Cumulative cash-flow curve, oldest first, deduped by second. */
export function buildEquityCurve(trades: Pick<Trade, 'side' | 'price' | 'size' | 'time'>[]): { time: number; value: number }[] {
  const sorted = [...trades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  let cum = 0;
  const curve: { time: number; value: number }[] = [];
  for (const t of sorted) {
    cum += tradeCashFlow(t);
    curve.push({ time: Math.floor(new Date(t.time).getTime() / 1000), value: cum });
  }
  return curve;
}
