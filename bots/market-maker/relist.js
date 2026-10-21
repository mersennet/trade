// ARB/USD is relisted at the mark switch: its resting orders are cancelled,
// open positions close at the last trade and its price scale goes from 100 to
// 10,000 ($0.0001 ticks). From then on it trades at its real price (~$0.19,
// where a $0.01 tick was ~5% of the price), fed by Coinbase/Binance like
// BTC/ETH/SOL; until then it keeps the $100 seed.
const { scaleOf } = require('./scale');

const ARB = 5;
const RELIST_SCALE = 10_000;
const ARB_REF = { coinbase: 'ARB-USD', binance: 'ARBUSDT' };

/**
 * Once the chain shows ARB on its relisted scale, applies `overrides` (human
 * seed/tick/sizes) to `markets[5]` and adds ARB to `refSymbols`. Returns true
 * only on the call that switched.
 */
function followArbRelist(markets, refSymbols, overrides) {
  if (refSymbols[ARB] || scaleOf(ARB) < RELIST_SCALE) return false;
  Object.assign(markets[ARB], overrides);
  refSymbols[ARB] = ARB_REF;
  return true;
}

module.exports = { followArbRelist };
