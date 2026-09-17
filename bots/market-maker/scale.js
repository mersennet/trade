// Per-market price scale. On-chain prices are human × priceScale (from
// `mersennet_orders_getMarkets`; 1 until a market is rescaled to finer ticks).
// The bots keep their seeds and ticks in HUMAN units and convert at the edge,
// so a rescale on-chain needs no bot change: a $0.05 tick becomes 5 chain
// units at scale 100 and stays 1 unit (the minimum) at scale 1.
const scales = {};

async function refreshScales(rpcCall) {
  try {
    const live = await rpcCall('mersennet_orders_getMarkets', []);
    if (!Array.isArray(live)) return;
    for (const m of live) {
      let sc = 1;
      try { sc = Math.max(1, Number(BigInt(m.priceScale ?? 1))); } catch { sc = 1; }
      const id = Number(m.id);
      if (scales[id] && scales[id] !== sc) console.log(`[scale] market ${id}: ${scales[id]} -> ${sc}`);
      scales[id] = sc;
    }
  } catch (e) {
    console.warn('[scale] getMarkets failed (keeping previous scales):', e.message);
  }
}

const scaleOf = (id) => scales[Number(id)] || 1;
/** Human price → chain units. */
const toChain = (human, id) => Math.round(Number(human) * scaleOf(id));
/** Chain units → human price. */
const toHuman = (chain, id) => Number(chain) / scaleOf(id);
/** Human tick → chain tick (at least one unit). */
const chainTick = (humanTick, id) => Math.max(1, Math.round(Number(humanTick) * scaleOf(id)));

module.exports = { refreshScales, scaleOf, toChain, toHuman, chainTick };
