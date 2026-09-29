/**
 * Order sizes on every market are whole lots of 1 (1 MRSN, 1 BTC …): the
 * chain has no fractional sizes, so computed sizes are floored here rather
 * than rounded at signing time.
 */

/** A computed size floored to whole lots. */
export function floorLots(x: number): string {
  return String(Math.max(0, Math.floor(x + 1e-9)));
}

/**
 * Split `total` whole lots into `n` slices of whole lots, larger ones first
 * (5 over 3 → [2, 2, 1]); a slice is 0 when there are fewer lots than slices.
 */
export function splitWholeLots(total: number, n: number): number[] {
  const t = Math.max(0, Math.floor(total + 1e-9));
  const k = Math.max(1, Math.floor(n));
  const base = Math.floor(t / k);
  const extra = t - base * k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}
