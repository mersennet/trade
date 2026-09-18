/**
 * Mersennet Trade Taker Bot — Ambient Trade Flow
 *
 * Simulates organic taker activity: small waves of spread-crossing orders on
 * a relaxed cadence, so the tape ticks, candles form, and 24h volume is real
 * without saturating the chain. Orders route through consensus (one tx per
 * order), so fills are emitted as MersennetOrdersTrades WS events that the
 * indexer picks up — no direct fill reporting needed.
 */

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';

// Seeds must match the market maker's so the outlier filter anchors on the
// same price regime (ARB in particular quotes around 100, not 1).
// `seed` and `tick` are HUMAN prices, converted to chain units with the
// market's live priceScale (see scale.js).
const { refreshScales, toChain, chainTick, scaleOf, quietForSwitch, quietReason } = require('./scale');
const { refreshProtocol, ensureUnits } = require('./settlement');
const MARKETS = {
  1:  { symbol: 'MRSN',  weight: 3.0, seed: 115,   tick: 0.05, sizeRange: [1, 10]  },
  2:  { symbol: 'BTC',   weight: 5.0, seed: 77000, tick: 10,   sizeRange: [1, 2]   },
  3:  { symbol: 'ETH',   weight: 4.0, seed: 2500,  tick: 1,    sizeRange: [1, 5]   },
  4:  { symbol: 'SOL',   weight: 3.0, seed: 100,   tick: 0.05, sizeRange: [1, 8]   },
  5:  { symbol: 'ARB',   weight: 1.5, seed: 100,   tick: 0.05, sizeRange: [5, 40]  },
};
const liveMid = {};
function hexToNum(h) { return h ? Number(BigInt(h)) : 0; }

const { BotWallet } = require('./signer');

// Each taker is a real, genesis-funded keypair that signs its own orders
// (caller = the taker). Their addresses are deterministic (see bot-addresses.js)
// so genesis funds them and the indexer excludes them from human leaderboards
// via the configured BOT_ADDRESSES list.
const NUM_TAKERS = Number(process.env.NUM_TAKERS || 20);
// Collateral each taker keeps on the CLOB (MRSN); the maker funds the wallets.
const TAKER_TARGET = BigInt(process.env.TAKER_TARGET_COLLATERAL || 50_000);
const TAKER_WALLETS = Array.from({ length: NUM_TAKERS }, (_, i) =>
  new BotWallet(process.env.RPC_URL || 'https://rpc.mersennet.com', `taker-${i}`)
);
const TAKERS = TAKER_WALLETS.map((w) => w.address);
const walletByAddress = Object.fromEntries(TAKER_WALLETS.map((w) => [w.address, w]));

// Ambient cadence: a small wave every few seconds ≈ 0.5-1 order/s. Orders are
// consensus txs (mined over ~1s blocks), so this stays well under chain
// throughput while keeping the tape/candles/volume visibly alive.
const CONFIG = {
  waveSizeMin: 2,
  waveSizeMax: 5,
  waveDelayMin: 4000,
  waveDelayMax: 9000,
  priceFetchInterval: 10_000,
};

let rpcId = 1;
let totalTrades = 0;
let totalFills = 0;
let submitErrLogged = false;

// Node 20 global fetch — handles http:// and https:// (rpc.mersennet.com:443).
async function rpcCall(method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

function toHex(v) { return '0x' + BigInt(Math.max(1, Math.round(v))).toString(16); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randEl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function pickMarket() {
  const entries = Object.entries(MARKETS);
  const totalW = entries.reduce((s, [, m]) => s + m.weight, 0);
  let r = Math.random() * totalW;
  for (const [id, m] of entries) {
    r -= m.weight;
    if (r <= 0) return Number(id);
  }
  return Number(entries[0][0]);
}

const rawTop = {}; // marketId -> { bid, ask } straight from the chain book

// Live reference (same sources as the maker). When the book's mid is more
// than 5% away from the reference the book is stale/polluted and the
// reference wins, so takers never chase forgotten orders.
const REF_SYMBOLS = { 2: { coinbase: 'BTC-USD', binance: 'BTCUSDT' }, 3: { coinbase: 'ETH-USD', binance: 'ETHUSDT' }, 4: { coinbase: 'SOL-USD', binance: 'SOLUSDT' } };
const refPrice = {}; // marketId -> { price, at }
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
async function refreshReferencePrices() {
  await Promise.all(Object.entries(REF_SYMBOLS).map(async ([id, sym]) => {
    const q = [];
    await Promise.all([
      fetchJson(`https://api.coinbase.com/v2/prices/${sym.coinbase}/spot`).then((j) => q.push(Number(j?.data?.amount))).catch(() => {}),
      fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${sym.binance}`).then((j) => q.push(Number(j?.price))).catch(() => {}),
    ]);
    const v = q.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    if (v.length) refPrice[id] = { price: v.length === 2 ? (v[0] + v[1]) / 2 : v[0], at: Date.now() };
  }));
}
/** Fresh reference price in CHAIN units, or null. */
function referenceFor(id) {
  const r = refPrice[id];
  return r && Date.now() - r.at < 5 * 60_000 ? toChain(r.price, id) : null;
}
setInterval(() => refreshReferencePrices().catch(() => {}), 30_000);
refreshReferencePrices().catch(() => {});
refreshScales(rpcCall).catch(() => {});
setInterval(() => refreshScales(rpcCall).catch(() => {}), 5_000);

async function fetchMidPrices() {
  for (const [id, m] of Object.entries(MARKETS)) {
    try {
      const ob = await rpcCall('mersennet_orders_getOrderBook', [Number(id)]);
      if (!ob) continue;
      const bids = ob.bids || [];
      const asks = ob.asks || [];
      const seed = toChain(m.seed, id);

      // Levels arrive in ascending price order on both sides: best bid is the
      // highest bid, best ask the lowest ask. Raw top of book feeds the
      // stale-liquidity guard; the banded values feed the mid.
      const bidPrices = bids.map((b) => hexToNum(b.price)).filter((p) => p > 0);
      const askPrices = asks.map((a) => hexToNum(a.price)).filter((p) => p > 0);
      rawTop[id] = { bid: bidPrices.length ? Math.max(...bidPrices) : 0, ask: askPrices.length ? Math.min(...askPrices) : 0 };
      const inBand = (p) => p > seed * 0.3 && p < seed * 3;
      const bandBids = bidPrices.filter(inBand);
      const bandAsks = askPrices.filter(inBand);
      const bestBid = bandBids.length ? Math.max(...bandBids) : 0;
      const bestAsk = bandAsks.length ? Math.min(...bandAsks) : 0;

      if (bestBid > 0 && bestAsk > 0) liveMid[id] = Math.round((bestBid + bestAsk) / 2);
      else if (bestAsk > 0) liveMid[id] = bestAsk;
      else if (bestBid > 0) liveMid[id] = bestBid;
      else liveMid[id] = seed;
      const ref = referenceFor(id);
      if (ref && Math.abs(liveMid[id] - ref) / ref > 0.05) liveMid[id] = Math.round(ref);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Inventory management — sustainability.
//
// A 50/50 random walk accumulates net positions, which eventually pins the
// takers' margin and dries up fills. We read each taker's REAL on-chain
// position via eth_call to the precompile's getPosition(uint64) (the caller
// address scopes the read), and bias the trade side against the inventory —
// long inventory sells more, short inventory buys more. Positions then
// mean-revert around flat forever.
// ---------------------------------------------------------------------------
const GET_POSITION_SELECTOR = '0x0f85fc5a'; // keccak("getPosition(uint64)")[:4]
const ORDERS_PRECOMPILE = '0x0000000000000000000000000000000000000100';
const inventory = {}; // `${taker}:${marketId}` -> signed size (i128 as Number)

async function fetchPosition(taker, marketId) {
  const data = GET_POSITION_SELECTOR + BigInt(marketId).toString(16).padStart(64, '0');
  const out = await rpcCall('eth_call', [{ from: taker, to: ORDERS_PRECOMPILE, data, gas: '0x30000' }, 'latest']);
  if (!out || out === '0x' || out.length < 66) return 0;
  // int128 encoded in a 32-byte word (two's complement, sign-extended)
  let size = BigInt('0x' + out.slice(2, 66));
  if (size > (1n << 255n)) size -= (1n << 256n);
  return Number(size);
}

async function refreshInventory() {
  for (const taker of TAKERS) {
    for (const id of Object.keys(MARKETS)) {
      try { inventory[`${taker}:${id}`] = await fetchPosition(taker, Number(id)); }
      catch { /* keep last known */ }
    }
  }
}

function generateTrade() {
  const marketId = pickMarket();
  const m = MARKETS[marketId];
  const taker = randEl(TAKERS);
  const mid = liveMid[marketId] || toChain(m.seed, marketId);
  const tick = chainTick(m.tick, marketId);

  // Side bias against on-chain inventory: flat -> 50/50; heavily long ->
  // mostly sells; heavily short -> mostly buys. Full bias at 20x base size,
  // or earlier when that much inventory would use more than 40% of the
  // taker's margin capacity (collateral × 10 at 10% initial margin): from the
  // settlement switch a fill past capacity is refused, so the bias must turn
  // the taker around first (BTC: ~2.5 contracts at 50k MRSN collateral).
  const inv = inventory[`${taker}:${marketId}`] || 0;
  const midHuman = mid / (scaleOf(marketId) || 1);
  const marginCap = midHuman > 0 ? Math.floor((Number(TAKER_TARGET) * 10 * 0.4) / midHuman) : Infinity;
  const cap = Math.max(1, Math.min(20 * m.sizeRange[1], marginCap));
  const skew = Math.max(-1, Math.min(1, inv / cap)); // -1..1
  const buyProb = 0.5 - 0.45 * skew;
  const side = Math.random() < buyProb ? 'buy' : 'sell';
  const size = randInt(m.sizeRange[0], m.sizeRange[1]);

  // Cross to the touch only: one tick through mid is the maker's best quote.
  // Crossing 1–5 ticks (the old behaviour) swept three maker levels whenever
  // a wave exhausted the top one, and every hourly candle spanned ±3 ticks
  // (112–118 on MRSN) — the chart read as broken. IOC fills what rests at
  // the touch and the remainder is dropped, which is what a taker wants.
  let price;
  if (side === 'buy') {
    price = mid + tick;
  } else {
    price = mid - tick;
  }
  if (price < 1) price = 1;

  return { marketId, side, price, size, taker, symbol: m.symbol };
}

// Orders settle through consensus: submitOrder returns { accepted, txHash }
// and the tx mines over the next blocks. Fills are emitted on-chain as
// MersennetOrdersTrades WS events, which the indexer already consumes — so
// there is no direct fill reporting here.
async function submitTrade(trade) {
  try {
    const wallet = walletByAddress[trade.taker];
    if (!wallet) return { accepted: false };
    // Stale-liquidity guard: a sell would cross a forgotten bid far above the
    // market (or a buy a forgotten ask far below) and print that price on the
    // tape. Those orders are being drained; do not trade with them.
    const top = rawTop[trade.marketId] || { bid: 0, ask: 0 };
    if (trade.side === 'sell' && top.bid > trade.price * 1.02) return { accepted: false, skipped: 'stale bid wall' };
    if (trade.side === 'buy' && top.ask > 0 && top.ask < trade.price * 0.98) return { accepted: false, skipped: 'stale ask wall' };
    // IOC: an unfilled remainder must not rest. The GTC version left ~141k stale
    // bot orders on the books over three weeks, distorting every best bid.
    const txHash = await wallet.placeOrder(trade.marketId, trade.side, trade.price, trade.size, 'ioc');
    return { accepted: !!txHash };
  } catch (e) {
    if (!submitErrLogged) {
      console.error(`[taker] submitOrder failed: ${e.message}`);
      submitErrLogged = true;
    }
    return { accepted: false };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let quietLogged = false;
async function runWave() {
  if (quietForSwitch()) {
    if (!quietLogged) { console.log(`[taker] quiet: ${quietReason()}`); quietLogged = true; }
    return;
  }
  if (quietLogged) {
    // Mids were read in the old scale; re-read before the first post-switch wave.
    await fetchMidPrices().catch(() => {});
    console.log('[taker] switch passed, trading with the new scales');
    quietLogged = false;
  }
  submitErrLogged = false;
  const waveSize = randInt(CONFIG.waveSizeMin, CONFIG.waveSizeMax);
  const trades = Array.from({ length: waveSize }, () => generateTrade());

  const start = Date.now();
  const results = await Promise.allSettled(trades.map(t => submitTrade(t)));
  const elapsed = Date.now() - start;

  let waveAccepted = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.accepted) waveAccepted++;
  }

  totalTrades += waveSize;
  totalFills += waveAccepted;
  console.log(`[taker] Wave: ${waveSize} orders in ${elapsed}ms | accepted=${waveAccepted} | total submitted: ${totalTrades}`);
}

async function main() {
  console.log('[taker] Mersennet Trade Taker — Realistic Trading');
  console.log(`[taker] RPC: ${RPC_URL}`);
  console.log(`[taker] ${TAKERS.length} addresses | waves: ${CONFIG.waveSizeMin}-${CONFIG.waveSizeMax} orders`);

  // Each taker holds TAKER_TARGET_COLLATERAL MRSN of collateral in every era
  // (the maker funds the wallets with native MRSN); re-checked every minute.
  const topUp = async () => {
    await refreshProtocol(rpcCall);
    for (const w of TAKER_WALLETS) {
      try { await ensureUnits(w, TAKER_TARGET, w.label); } catch (e) { console.warn(`[taker] ${w.address} top-up failed:`, e.message); }
    }
  };
  await topUp();
  setInterval(() => topUp().catch(() => {}), 60_000);

  console.log('[taker] Waiting 15s for maker to seed orderbooks...');
  await sleep(15_000);

  await fetchMidPrices();
  console.log('[taker] Mid prices:', Object.entries(liveMid).map(([k, v]) => `${MARKETS[k].symbol}=${v}`).join(' '));

  setInterval(() => fetchMidPrices().catch(() => {}), CONFIG.priceFetchInterval);

  // Inventory refresh: read real on-chain positions every 60s and log net
  // exposure so drift is visible in the container logs.
  await refreshInventory().catch(() => {});
  setInterval(() => {
    refreshInventory()
      .then(() => {
        const per = Object.keys(MARKETS).map((id) => {
          const net = TAKERS.reduce((s, t) => s + (inventory[`${t}:${id}`] || 0), 0);
          return `${MARKETS[id].symbol}=${net}`;
        });
        console.log(`[taker] net inventory: ${per.join(' ')}`);
      })
      .catch(() => {});
  }, 60_000);

  while (true) {
    try {
      await runWave();
      const delay = randInt(CONFIG.waveDelayMin, CONFIG.waveDelayMax);
      await sleep(delay);
    } catch (e) {
      console.error('[taker] Error:', e.message);
      await sleep(5_000);
    }
  }
}

main().catch(e => { console.error('[taker] Fatal:', e); process.exit(1); });
