/**
 * Per-market price scale. On-chain prices are human × priceScale (1 until a
 * market is rescaled to finer ticks; e.g. 100 lets MRSN trade on $0.01).
 * The API serves human prices everywhere, so the terminal only converts at
 * the chain boundary: signing an order, reading the book straight from RPC.
 */
import { api } from './api';

const scales = new Map<number, number>();
let loaded: Promise<void> | null = null;
let loadedAt = 0;

async function load(): Promise<void> {
  const { markets } = await api.getMarkets();
  for (const m of markets) scales.set(m.id, Math.max(1, Number(m.priceScale ?? 1)));
  loadedAt = Date.now();
}

/** Scale for `marketId` (refreshes at most once a minute; 1 when unknown). */
export async function getPriceScale(marketId: number): Promise<number> {
  if (!loaded || Date.now() - loadedAt > 60_000) {
    loaded = load().catch(() => { /* keep previous scales */ });
  }
  await loaded;
  return scales.get(Number(marketId)) ?? 1;
}

/** Synchronous best-effort scale (1 until the first load completes). */
export function priceScaleSync(marketId: number): number {
  return scales.get(Number(marketId)) ?? 1;
}

/** Round a human price to the market's finest tick (1 / scale). */
export function roundToTick(human: number, scale: number): number {
  return Math.round(human * scale) / scale;
}
