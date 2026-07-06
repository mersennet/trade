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
const MARKETS = {
  1:  { symbol: 'MRSN',  weight: 3.0, seed: 115,   tick: 1,  sizeRange: [1, 10]  },
  2:  { symbol: 'BTC',   weight: 5.0, seed: 74500, tick: 10, sizeRange: [1, 2]   },
  3:  { symbol: 'ETH',   weight: 4.0, seed: 3730,  tick: 1,  sizeRange: [1, 5]   },
  4:  { symbol: 'SOL',   weight: 3.0, seed: 148,   tick: 1,  sizeRange: [1, 8]   },
  5:  { symbol: 'ARB',   weight: 1.5, seed: 100,   tick: 1,  sizeRange: [5, 40]  },
};
const liveMid = {};
function hexToNum(h) { return h ? Number(BigInt(h)) : 0; }

// System-range addresses (0x…0b-0x…1e) — inside the 0x0000… prefix that the
// leaderboard/points queries filter out, so bot flow never pollutes human
// rankings. Starts at 0x0b to skip the standard EVM precompile addresses
// (0x01-0x0a), which cannot receive plain value transfers for gas.
const TAKERS = Array.from({ length: 20 }, (_, i) =>
  '0x' + (i + 11).toString(16).padStart(40, '0')
);

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

async function fetchMidPrices() {
  for (const [id, m] of Object.entries(MARKETS)) {
    try {
      const ob = await rpcCall('mersennet_orders_getOrderBook', [Number(id)]);
      if (!ob) continue;
      const bids = ob.bids || [];
      const asks = ob.asks || [];
      const seed = m.seed;

      // Filter outlier prices (within 50% - 200% of seed)
      let bestBid = 0;
      for (const b of bids) {
        const p = hexToNum(b.price);
        if (p > seed * 0.3 && p < seed * 3) { bestBid = p; break; }
      }
      let bestAsk = 0;
      for (const a of asks) {
        const p = hexToNum(a.price);
        if (p > seed * 0.3 && p < seed * 3) { bestAsk = p; break; }
      }

      if (bestBid > 0 && bestAsk > 0) liveMid[id] = Math.round((bestBid + bestAsk) / 2);
      else if (bestAsk > 0) liveMid[id] = bestAsk;
      else if (bestBid > 0) liveMid[id] = bestBid;
      else liveMid[id] = seed;
    } catch {}
  }
}

function generateTrade() {
  const marketId = pickMarket();
  const m = MARKETS[marketId];
  const side = Math.random() < 0.52 ? 'buy' : 'sell';
  const taker = randEl(TAKERS);
  const size = randInt(m.sizeRange[0], m.sizeRange[1]);
  const mid = liveMid[marketId] || m.seed;

  // Cross the spread aggressively to guarantee fills
  let price;
  if (side === 'buy') {
    price = mid + randInt(1, 5) * m.tick;
  } else {
    price = mid - randInt(1, 5) * m.tick;
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
    const result = await rpcCall('mersennet_orders_submitOrder', [{
      owner: trade.taker,
      market_id: trade.marketId,
      side: trade.side,
      price: toHex(trade.price),
      size: toHex(trade.size),
      tif: 'gtc',
    }]);
    return { accepted: !!(result?.accepted || result?.txHash) };
  } catch (e) {
    if (!submitErrLogged) {
      console.error(`[taker] submitOrder failed: ${e.message}`);
      submitErrLogged = true;
    }
    return { accepted: false };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runWave() {
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

  // Each taker wallet needs collateral to place crossing orders (submitOrder
  // enforces margin). deposit_collateral just credits the integer amount.
  console.log(`[taker] Depositing collateral for ${TAKERS.length} taker wallets...`);
  await Promise.all(TAKERS.map(t =>
    rpcCall('mersennet_orders_depositCollateral', [t, '0x' + (10n ** 12n).toString(16)])
      .catch(e => console.error(`[taker] deposit ${t} failed: ${e.message}`))
  ));

  console.log('[taker] Waiting 15s for maker to seed orderbooks...');
  await sleep(15_000);

  await fetchMidPrices();
  console.log('[taker] Mid prices:', Object.entries(liveMid).map(([k, v]) => `${MARKETS[k].symbol}=${v}`).join(' '));

  setInterval(() => fetchMidPrices().catch(() => {}), CONFIG.priceFetchInterval);

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
