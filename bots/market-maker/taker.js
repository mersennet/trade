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
  2:  { symbol: 'BTC',   weight: 5.0, seed: 77000, tick: 10, sizeRange: [1, 2]   },
  3:  { symbol: 'ETH',   weight: 4.0, seed: 2500,  tick: 1,  sizeRange: [1, 5]   },
  4:  { symbol: 'SOL',   weight: 3.0, seed: 100,   tick: 1,  sizeRange: [1, 8]   },
  5:  { symbol: 'ARB',   weight: 1.5, seed: 100,   tick: 1,  sizeRange: [5, 40]  },
};
const liveMid = {};
function hexToNum(h) { return h ? Number(BigInt(h)) : 0; }

const { BotWallet } = require('./signer');

// Each taker is a real, genesis-funded keypair that signs its own orders
// (caller = the taker). Their addresses are deterministic (see bot-addresses.js)
// so genesis funds them and the indexer excludes them from human leaderboards
// via the configured BOT_ADDRESSES list.
const NUM_TAKERS = Number(process.env.NUM_TAKERS || 20);
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
  const mid = liveMid[marketId] || m.seed;

  // Side bias against on-chain inventory: flat -> 50/50; heavily long ->
  // mostly sells; heavily short -> mostly buys. Full bias at 20x base size.
  const inv = inventory[`${taker}:${marketId}`] || 0;
  const cap = 20 * m.sizeRange[1];
  const skew = Math.max(-1, Math.min(1, inv / cap)); // -1..1
  const buyProb = 0.5 - 0.45 * skew;
  const side = Math.random() < buyProb ? 'buy' : 'sell';
  const size = randInt(m.sizeRange[0], m.sizeRange[1]);

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
    const wallet = walletByAddress[trade.taker];
    if (!wallet) return { accepted: false };
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

  // Each taker signs a depositCollateral tx (requires genesis native-MRSN
  // funding). Margin is enforced on-chain before crossing orders can fill.
  console.log(`[taker] Depositing collateral for ${TAKER_WALLETS.length} taker wallets...`);
  await Promise.all(TAKER_WALLETS.map(w =>
    w.depositCollateral(10n ** 12n)
      .catch(e => console.error(`[taker] deposit ${w.address} failed: ${e.message}`))
  ));

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
