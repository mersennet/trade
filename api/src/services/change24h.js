// Multi-source 24h price-change cache.
//
// Without indexed trades populating the candles table, our internal
// change24h would always be 0. We fetch the real number from public
// exchange APIs (Coinbase / Binance / KuCoin / MEXC / CoinGecko) and
// cache for 5 min so beta testers see meaningful market tabs and
// the WS ticker broadcast doesn't overwrite UI with 0%.
//
// Source order per market (try in sequence, first non-null wins):
//   - Coinbase products/stats endpoint (no auth, generous limits)
//   - Binance ticker/24hr (no auth, generous limits)
//   - KuCoin / MEXC for assets without Coinbase/Binance listings
//   - CoinGecko (heavy rate limit; only as last resort)
//
// A single background loop refreshes the cache every 60s. All readers
// (REST endpoint and WS ticker broadcaster) call getCachedChange24hPct().
//
// Keyed by market id (chain.js MARKETS): 1=MRSN 2=BTC 3=ETH 4=SOL 5=ARB.
// MRSN is a Mersennet-native testnet token with no external listing, so it
// has no external feed and falls back to the internal change24h.
const FEEDS_24H = {
  2: { coinbase: 'BTC-USD', binance: 'BTCUSDT' },
  3: { coinbase: 'ETH-USD', binance: 'ETHUSDT' },
  4: { coinbase: 'SOL-USD', binance: 'SOLUSDT' },
  5: { coinbase: 'ARB-USD', binance: 'ARBUSDT' },
};

const _cache = new Map(); // marketId -> { value, fetchedAt }
const TTL_MS = 5 * 60_000;
let _refreshing = false;

async function _coinbase24h(id) {
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${id}/stats`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    const o = parseFloat(j.open), l = parseFloat(j.last);
    if (!Number.isFinite(o) || !Number.isFinite(l) || o <= 0) return null;
    return ((l - o) / o) * 100;
  } catch { return null; }
}
async function _binance24h(id) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${id}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    const v = parseFloat(j.priceChangePercent);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}
async function _kucoin24h(id) {
  // KuCoin returns changeRate as a decimal fraction (0.048 = 4.8%).
  try {
    const r = await fetch(`https://api.kucoin.com/api/v1/market/stats?symbol=${id}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    const cr = parseFloat(j?.data?.changeRate);
    return Number.isFinite(cr) ? cr * 100 : null;
  } catch { return null; }
}
async function _mexc24h(id) {
  // MEXC returns priceChangePercent as decimal (0.0173 = 1.73%).
  try {
    const r = await fetch(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${id}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json();
    const v = parseFloat(j.priceChangePercent);
    return Number.isFinite(v) ? v * 100 : null;
  } catch { return null; }
}
async function _cg24h(id) {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const v = j?.[id]?.usd_24h_change;
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

async function refreshAll() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    await Promise.allSettled(Object.entries(FEEDS_24H).map(async ([marketId, srcs]) => {
      let v = null;
      if (srcs.coinbase)               v = await _coinbase24h(srcs.coinbase);
      if (v == null && srcs.binance)   v = await _binance24h(srcs.binance);
      if (v == null && srcs.kucoin)    v = await _kucoin24h(srcs.kucoin);
      if (v == null && srcs.mexc)      v = await _mexc24h(srcs.mexc);
      if (v == null && srcs.coingecko) v = await _cg24h(srcs.coingecko);
      if (Number.isFinite(v)) _cache.set(Number(marketId), { value: v, fetchedAt: Date.now() });
    }));
  } finally { _refreshing = false; }
}

// Kick off background refresh on module load.
refreshAll().catch(() => {});
setInterval(() => { refreshAll().catch(() => {}); }, 60_000);

function getCachedChange24hPct(marketId) {
  const c = _cache.get(Number(marketId));
  // Allow slightly stale data (up to 2× TTL) so we don't drop to 0% during a fetch hiccup.
  if (c && Date.now() - c.fetchedAt < TTL_MS * 2) return c.value;
  refreshAll().catch(() => {});
  return null;
}

module.exports = { getCachedChange24hPct, refreshAll };
