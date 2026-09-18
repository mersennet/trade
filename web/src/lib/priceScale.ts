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

/** Scale for `marketId` (refreshes at most every 15 s; 1 when unknown). */
export async function getPriceScale(marketId: number): Promise<number> {
  if (!loaded || Date.now() - loadedAt > 15_000) {
    loaded = load().catch(() => { /* keep previous scales */ });
  }
  await loaded;
  return scales.get(Number(marketId)) ?? 1;
}

/** Drop the cache so the next `getPriceScale` reads the chain again. */
export function invalidatePriceScales(): void {
  loaded = null;
  loadedAt = 0;
}

/**
 * Around an armed price-scale switch, wait until it is safe to sign an order:
 * an order built with the old scale that lands after the switch is priced
 * 100× off. Blocks from 8 blocks before the switch until 8 after (≈35 s), and
 * forces a fresh scale read once the switch has passed. No-op otherwise.
 */
export async function waitOutScaleSwitch(): Promise<void> {
  let switchHeight = 0;
  try { switchHeight = Number((await api.getProtocol()).switches?.priceScaleHeight || 0); } catch { return; }
  if (!switchHeight) return;
  const started = Date.now();
  while (Date.now() - started < 70_000) {
    let head = 0;
    try { head = Number((await api.getChainHealth()).head || 0); } catch { return; }
    if (!head) return;
    if (head >= switchHeight && head < switchHeight + 300) invalidatePriceScales();
    if (head < switchHeight - 8 || head >= switchHeight + 8) return;
    console.info(`[orders] tick-size switch at block ${switchHeight} in progress (head ${head}); waiting`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Synchronous best-effort scale (1 until the first load completes). */
export function priceScaleSync(marketId: number): number {
  return scales.get(Number(marketId)) ?? 1;
}

/** Round a human price to the market's finest tick (1 / scale). */
export function roundToTick(human: number, scale: number): number {
  return Math.round(human * scale) / scale;
}
