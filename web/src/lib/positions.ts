import { getDefaultChain } from './chain';

/**
 * The account's signed position size on a market, read from the chain at the
 * moment of asking (long > 0, short < 0, 0 when flat), or null when the node
 * did not answer. Orders that must only reduce size against this, never
 * against a size remembered from earlier.
 */
export async function livePositionSize(owner: string, marketId: number): Promise<number | null> {
  try {
    const res = await fetch(getDefaultChain().rpcUrls[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mersennet_orders_getAccount', params: [owner] }),
    });
    const j = (await res.json()) as { result?: { positions?: { marketId: number | string; size: string }[] }; error?: unknown };
    if (!j || j.error || !j.result) return null;
    const p = (j.result.positions || []).find((x) => Number(x.marketId) === marketId);
    const size = p ? Number(p.size) : 0;
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}
