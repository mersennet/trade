// Per-market price scale. On-chain prices are human × priceScale (from
// `mersennet_orders_getMarkets`; 1 until a market is rescaled to finer ticks).
// The bots keep their seeds and ticks in HUMAN units and convert at the edge,
// so a rescale on-chain needs no bot change: a $0.05 tick becomes 5 chain
// units at scale 100 and stays 1 unit (the minimum) at scale 1.
const scales = {};
// Height the cached scales were read at, and the armed rescale height, both
// from ONE getProtocol answer (so they cannot disagree about the era).
let scalesAsOfHeight = 0;
let priceScaleHeight = 0;
// The mark switch relists ARB on a 100x finer scale (see relist.js).
let markPriceHeight = 0;
// Blocks before the rescale during which no new order is submitted: an order
// built with the old scale that lands after the switch is priced 100x off
// (a $115 ask becomes $1.15 and is lifted at once). Cancels are scale-agnostic
// and resting orders are migrated in place by the chain, so only new orders
// need the pause. Resumes once a post-switch getProtocol answer is cached.
const QUIET_BEFORE = Number(process.env.SWITCH_QUIET_BLOCKS || 8);

async function refreshScales(rpcCall) {
  try {
    const p = await rpcCall('mersennet_orders_getProtocol', []);
    const live = p && Array.isArray(p.markets) ? p.markets : null;
    if (!live) return;
    for (const m of live) {
      let sc = 1;
      try { sc = Math.max(1, Number(BigInt(m.priceScale ?? 1))); } catch { sc = 1; }
      const id = Number(m.id);
      if (scales[id] && scales[id] !== sc) console.log(`[scale] market ${id}: ${scales[id]} -> ${sc} (height ${p.height})`);
      scales[id] = sc;
    }
    scalesAsOfHeight = Number(p.height) || scalesAsOfHeight;
    priceScaleHeight = Number(p.switches?.priceScaleHeight || 0);
    markPriceHeight = Number(p.switches?.markPriceHeight || 0);
  } catch (e) {
    console.warn('[scale] getProtocol failed (keeping previous scales):', e.message);
  }
}

const nearing = (h) => h > 0 && scalesAsOfHeight >= h - QUIET_BEFORE && scalesAsOfHeight < h;

/** True while new orders must not be submitted around a switch that rescales a market. */
function quietForSwitch() {
  if (!scalesAsOfHeight) return false;
  return nearing(priceScaleHeight) || nearing(markPriceHeight);
}
function quietReason() {
  const what = nearing(priceScaleHeight) ? `price-scale switch at ${priceScaleHeight}` : `mark switch (ARB relist) at ${markPriceHeight}`;
  return `${what} (scales as of ${scalesAsOfHeight}): no new orders until the post-switch scale is read`;
}

const scaleOf = (id) => scales[Number(id)] || 1;
/** Human price → chain units. */
const toChain = (human, id) => Math.round(Number(human) * scaleOf(id));
/** Chain units → human price. */
const toHuman = (chain, id) => Number(chain) / scaleOf(id);
/** Human tick → chain tick (at least one unit). */
const chainTick = (humanTick, id) => Math.max(1, Math.round(Number(humanTick) * scaleOf(id)));

module.exports = { refreshScales, scaleOf, toChain, toHuman, chainTick, quietForSwitch, quietReason };
