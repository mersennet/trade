/**
 * Mersennet Trade Taker Bot — High-Frequency Trade Generator
 *
 * Fires hundreds of trades per second using parallel HTTP connections.
 * Multiple simulated traders crossing the spread simultaneously.
 * Realistic patterns: bursts, varied sizes, weighted market selection.
 */

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';

const MARKETS = {
  1:  { symbol: 'MRSN',  weight: 3.0, seed: 115,   tick: 1,  sizeRange: [1, 10]    },
  2:  { symbol: 'BTC',   weight: 5.0, seed: 74500, tick: 10, sizeRange: [1, 2]     },
  3:  { symbol: 'ETH',   weight: 4.0, seed: 3730,  tick: 1,  sizeRange: [1, 5]     },
  4:  { symbol: 'SOL',   weight: 3.0, seed: 148,   tick: 1,  sizeRange: [1, 8]     },
  5:  { symbol: 'ARB',   weight: 1.5, seed: 1,     tick: 1,  sizeRange: [10, 100]  },
};
const liveMid = {};
function hexToNum(h) { return h ? Number(BigInt(h)) : 0; }

const TAKERS = Array.from({ length: 20 }, (_, i) =>
  '0x' + (i + 2).toString(16).padStart(40, '0')
);

const CONFIG = {
  waveSizeMin: 3,
  waveSizeMax: 8,
  waveDelayMin: 2000,
  waveDelayMax: 5000,
  maxSockets: 100,
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

const INDEXER_URL = process.env.INDEXER_URL || 'http://127.0.0.1:4010/trades';
const pendingReports = [];

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
    const fills = result?.trades?.length || 0;
    const filled = result?.filled ? Number(BigInt(result.filled)) : 0;

    if (fills > 0 && result.trades) {
      for (const t of result.trades) {
        pendingReports.push({
          marketId: trade.marketId,
          taker: trade.taker,
          maker: t.maker || '0x0',
          side: trade.side,
          price: t.price ? Number(BigInt(t.price)) : trade.price,
          size: t.size ? Number(BigInt(t.size)) : trade.size,
        });
      }
    }

    return { fills, filled, orderId: result?.order_id };
  } catch (e) {
    if (!submitErrLogged) {
      console.error(`[taker] submitOrder failed: ${e.message}`);
      submitErrLogged = true;
    }
    return { fills: 0, filled: 0, orderId: null };
  }
}

async function flushReports() {
  if (pendingReports.length === 0) return;
  const batch = pendingReports.splice(0, pendingReports.length);
  try {
    const res = await fetch(INDEXER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) console.log(`[taker] Report failed: ${res.status}`);
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runWave() {
  submitErrLogged = false;
  const waveSize = randInt(CONFIG.waveSizeMin, CONFIG.waveSizeMax);
  const trades = Array.from({ length: waveSize }, () => generateTrade());

  const start = Date.now();
  const results = await Promise.allSettled(trades.map(t => submitTrade(t)));
  const elapsed = Date.now() - start;

  let waveFills = 0;
  let wavePlaced = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      waveFills += r.value.fills;
      if (r.value.orderId || r.value.fills > 0) wavePlaced++;
    }
  }

  totalTrades += waveSize;
  totalFills += waveFills;
  const opsPerSec = Math.round(waveSize / (elapsed / 1000));

  console.log(`[taker] Wave: ${waveSize} orders in ${elapsed}ms (${opsPerSec}/s) | placed=${wavePlaced} fills=${waveFills} | total: ${totalTrades} orders, ${totalFills} fills`);

  flushReports().catch(() => {});
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
