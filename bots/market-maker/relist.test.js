// node --test bots/market-maker/relist.test.js
const test = require('node:test');
const assert = require('node:assert');
const { refreshScales, scaleOf, quietForSwitch, quietReason } = require('./scale');
const { followArbRelist } = require('./relist');

const protocol = (height, arbScale, switches) => async () => ({
  height,
  markets: [{ id: 1, priceScale: '0x64' }, { id: 5, priceScale: arbScale }],
  switches,
});

test('ARB follows the relist at the mark switch, with a quiet window before it', async () => {
  const markets = { 5: { symbol: 'ARB', seed: 100, tick: 0.05, baseSize: 500 } };
  const refs = { 2: { coinbase: 'BTC-USD', binance: 'BTCUSDT' } };
  const relisted = { seed: 0.19, tick: 0.0001, baseSize: 50_000 };

  // Today: no mark switch announced, ARB on scale 100.
  await refreshScales(protocol(2_700_000, '0x64', { priceScaleHeight: 2_100_000 }));
  assert.equal(quietForSwitch(), false);
  assert.equal(followArbRelist(markets, refs, relisted), false);
  assert.equal(markets[5].seed, 100);

  // Announced: quiet only in the last 8 blocks before it.
  await refreshScales(protocol(2_930_791, '0x64', { priceScaleHeight: 2_100_000, markPriceHeight: 2_930_800 }));
  assert.equal(quietForSwitch(), false);
  await refreshScales(protocol(2_930_792, '0x64', { priceScaleHeight: 2_100_000, markPriceHeight: 2_930_800 }));
  assert.equal(quietForSwitch(), true);
  assert.match(quietReason(), /mark switch \(ARB relist\) at 2930800/);
  assert.equal(followArbRelist(markets, refs, relisted), false);

  // After it: ARB on scale 10,000, real price feed, once.
  await refreshScales(protocol(2_930_800, '0x2710', { priceScaleHeight: 2_100_000, markPriceHeight: 2_930_800 }));
  assert.equal(quietForSwitch(), false);
  assert.equal(scaleOf(5), 10_000);
  assert.equal(followArbRelist(markets, refs, relisted), true);
  assert.deepEqual(markets[5], { symbol: 'ARB', seed: 0.19, tick: 0.0001, baseSize: 50_000 });
  assert.deepEqual(refs[5], { coinbase: 'ARB-USD', binance: 'ARBUSDT' });
  assert.equal(followArbRelist(markets, refs, relisted), false);
});

test('the price-scale switch keeps its own quiet window', async () => {
  await refreshScales(protocol(995, '0x64', { priceScaleHeight: 1_000 }));
  assert.equal(quietForSwitch(), true);
  assert.match(quietReason(), /price-scale switch at 1000/);
});
