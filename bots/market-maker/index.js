/**
 * Mersennet Trade Market Maker — Dense Liquidity
 *
 * 30 levels per side, each at a unique price tick
 * Exponential depth profile: thin at top, thick deeper
 * Fetches live mid price from chain each cycle
 *
 * Talks to the Mersennet L1 over JSON-RPC (mersennet_orders_* namespace).
 * On startup it idempotently seeds the 5 markets (only on a fresh chain) and
 * deposits collateral for the maker wallet so submitOrder passes margin checks.
 */

const { BotWallet } = require('./signer');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const INDEXER_URL = process.env.INDEXER_URL || 'http://127.0.0.1:4010/trades';

// The maker signs every order/cancel/deposit with its own funded keypair
// (native MRSN allocated at genesis). Orders execute with caller = this wallet.
const maker = new BotWallet(RPC_URL, 'maker', process.env.MM_PRIVATE_KEY);

// Orders now settle as consensus transactions (one tx per order, mined
// over blocks). 30 levels x 2 sides x 5 markets = 300 tx/cycle saturated
// the mempool faster than the chain could mine, so most orders never
// rested. Use a modest number of levels so every order lands and the book
// stays deep + stable across all markets. ARB (seed 1) uses a larger tick
// so its bid ladder doesn't collapse below price 1.
// Levels are deliberately small: every order is a signed tx from ONE sender
// (the maker), so orders settle as sequential nonces. Placing 5 markets x 2
// sides x N levels per cycle faster than the chain mines wedges the maker's
// mempool slot (nonce backlog) and stalls all its future orders. Keep the
// per-cycle order count at/under what mines in one refresh interval.
const MARKETS = {
  1: { symbol: 'MRSN', seed: 115,   tick: 1,    baseSize: 50,  levels: 3 },
  2: { symbol: 'BTC',  seed: 74500, tick: 10,   baseSize: 2,   levels: 3 },
  3: { symbol: 'ETH',  seed: 3730,  tick: 1,    baseSize: 8,   levels: 3 },
  4: { symbol: 'SOL',  seed: 148,   tick: 1,    baseSize: 25,  levels: 3 },
  5: { symbol: 'ARB',  seed: 100,   tick: 1,    baseSize: 500, levels: 3 },
};

const CONFIG = {
  owner: maker.address,
  markets: [1, 2, 3, 4, 5],
  // Slower cadence so each cycle's order txs fully mine (drain the
  // per-sender mempool) before the next batch — prevents the backlog that
  // starved later markets.
  refreshInterval: 10_000,
  // Orders now settle through consensus (mined over blocks), so cancelling
  // and re-placing every cycle churns the book faster than it can rest and
  // leaves it shallow. Refresh on a longer cadence and cancel only
  // periodically so resting liquidity accumulates into a visible book.
  cancelBeforeRefresh: (process.env.MM_CANCEL_EVERY_CYCLE || 'false') === 'true',
  cancelEveryNCycles: Number(process.env.MM_CANCEL_EVERY_N || 12),
  // Collateral deposited for the maker wallet on startup (integer units — the
  // precompile uses unscaled collateral/price/size and notional = price*size).
  seedCollateral: process.env.MM_COLLATERAL || '1000000000000',
};

let rpcId = 1;
let isRefreshing = false;
let cycleCount = 0;
const liveMid = {};

// Node 20 global fetch — protocol/port aware, so http:// and https:// (incl.
// rpc.mersennet.com on 443) both work without per-scheme plumbing.
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
function hexToNum(h) { return h ? Number(BigInt(h)) : 0; }

async function fetchMidPrice(marketId) {
  try {
    const ob = await rpcCall('mersennet_orders_getOrderBook', [marketId]);
    if (!ob) return null;
    const bids = ob.bids || [];
    const asks = ob.asks || [];
    const seed = MARKETS[marketId]?.seed || 100;

    // Find best bid/ask that are within 50% of seed to filter outliers
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

    if (bestBid > 0 && bestAsk > 0) return Math.round((bestBid + bestAsk) / 2);
    if (bestAsk > 0) return bestAsk;
    if (bestBid > 0) return bestBid;
    return null;
  } catch (e) {
    console.error(`[mm] fetchMidPrice(${marketId}) failed: ${e.message}`);
    return null;
  }
}

let submitErrLogged = false;
let marketMissing = false; // set when the chain reports "unknown market" (markets wiped by a state reset)
async function submitOrder(marketId, side, price, size) {
  try {
    // Signed placeOrder tx to the CLOB precompile. It gossips to the leader,
    // mines in a block, and executes with caller = the maker wallet. Fills are
    // read from the resulting order book / reported by the taker path, so we
    // return the tx hash for logging rather than a synchronous outcome.
    const txHash = await maker.placeOrder(marketId, side, price, size, 'gtc');
    return { txHash, trades: [] };
  } catch (e) {
    if (e.message && e.message.includes('unknown market')) marketMissing = true;
    if (!submitErrLogged) {
      console.error(`[mm] submitOrder(m${marketId} ${side} ${price}x${size}) failed: ${e.message}`);
      submitErrLogged = true;
    }
    return null;
  }
}

function buildOrders(marketId, mid) {
  const m = MARKETS[marketId];
  const tick = m.tick;
  const levels = m.levels;
  const orders = [];

  for (let i = 0; i < levels; i++) {
    const depth = i + 1;

    // Exponential size profile: small near spread, large deeper
    let sizeMult;
    if (i < 3)       sizeMult = 1.0 + Math.random() * 0.5;
    else if (i < 8)  sizeMult = 2.0 + Math.random() * 1.0;
    else if (i < 15) sizeMult = 3.0 + Math.random() * 2.0;
    else if (i < 22) sizeMult = 5.0 + Math.random() * 3.0;
    else              sizeMult = 8.0 + Math.random() * 5.0;

    const size = Math.max(1, Math.round(m.baseSize * sizeMult));

    // Each level is exactly `depth * tick` away from mid
    const bidPrice = mid - depth * tick;
    const askPrice = mid + depth * tick;

    if (bidPrice >= 1) {
      orders.push({ marketId, side: 'buy',  price: bidPrice, size });
    }
    if (askPrice >= 2) {
      orders.push({ marketId, side: 'sell', price: askPrice, size });
    }
  }

  return orders;
}

async function cancelAllOrders() {
  try {
    const openOrders = await rpcCall('mersennet_orders_getOpenOrders', [CONFIG.owner]);
    if (!openOrders || !Array.isArray(openOrders) || openOrders.length === 0) return 0;
    const ids = openOrders.map(o => o.order_id || o.id).filter(Boolean).slice(0, 3000);
    if (ids.length === 0) return 0;

    const batchSize = 200;
    let cancelled = 0;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(id => maker.cancelOrder(id))
      );
      cancelled += results.filter(r => r.status === 'fulfilled').length;
    }
    return cancelled;
  } catch (e) {
    console.error(`[mm] cancelAllOrders failed: ${e.message}`);
    return 0;
  }
}

const pendingReports = [];

async function flushReports() {
  if (pendingReports.length === 0) return;
  const batch = pendingReports.splice(0, pendingReports.length);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.REPORT_SECRET) headers['X-Report-Secret'] = process.env.REPORT_SECRET;
    await fetch(INDEXER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
    });
  } catch {}
}

// --- Startup bootstrap -----------------------------------------------------

// Markets are seeded deterministically from the genesis config on every node
// (the unsigned addMarket RPC is disabled — it only mutated one node). The bot
// just verifies they exist; if not, the chain wasn't started with the expected
// genesis markets and there is nothing the bot can (or should) do about it.
async function ensureMarkets() {
  const existing = await Promise.all(
    CONFIG.markets.map(async (id) => {
      try { return (await rpcCall('mersennet_orders_getOrderBook', [id])) != null; }
      catch { return false; }
    })
  );
  const present = existing.filter(Boolean).length;
  if (present === CONFIG.markets.length) {
    console.log(`[mm] all ${present} genesis markets present`);
  } else {
    console.warn(`[mm] only ${present}/${CONFIG.markets.length} markets present — check the node's genesis.markets config`);
  }
}

// Deposit collateral for the maker wallet (signed tx) so its orders pass the
// margin check. Requires the wallet to be genesis-funded with native MRSN.
async function ensureCollateral() {
  try {
    const txHash = await maker.depositCollateral(BigInt(CONFIG.seedCollateral));
    console.log(`[mm] deposited ${CONFIG.seedCollateral} collateral for ${CONFIG.owner} (tx ${txHash})`);
  } catch (e) {
    console.error(`[mm] depositCollateral failed for ${CONFIG.owner}: ${e.message} — is the wallet funded with native MRSN at genesis?`);
  }
}

async function refreshQuotes() {
  if (isRefreshing) return;
  isRefreshing = true;
  cycleCount++;
  submitErrLogged = false;
  marketMissing = false;
  const start = Date.now();

  try {
    // Cancel stale orders periodically (not every cycle) so consensus-
    // settled resting orders have time to accumulate into a deep book.
    let cancelled = 0;
    if (CONFIG.cancelBeforeRefresh || cycleCount % CONFIG.cancelEveryNCycles === 0) {
      cancelled = await cancelAllOrders();
    }

    // Fetch live mid prices, anchored toward seed
    await Promise.all(CONFIG.markets.map(async (mId) => {
      const chainMid = await fetchMidPrice(mId);
      const seed = MARKETS[mId].seed;
      if (chainMid && chainMid > 0) {
        // Blend: 70% toward seed, 30% chain — prevents wild drift
        liveMid[mId] = Math.round(seed * 0.7 + chainMid * 0.3);
      } else {
        liveMid[mId] = seed;
      }
    }));

    // Interleave orders across markets (round-robin by depth level) so no
    // single market monopolizes the low mempool nonces — orders settle as
    // sequential txs from one sender, so a flat per-market concatenation
    // left later markets perpetually behind and unfilled.
    const perMarket = CONFIG.markets.map((marketId) =>
      buildOrders(marketId, liveMid[marketId] || MARKETS[marketId].seed),
    );
    const allOrders = [];
    const maxLen = Math.max(0, ...perMarket.map((o) => o.length));
    for (let i = 0; i < maxLen; i++) {
      for (const orders of perMarket) {
        if (i < orders.length) allOrders.push(orders[i]);
      }
    }

    const placeStart = Date.now();
    const results = await Promise.allSettled(
      allOrders.map(o => submitOrder(o.marketId, o.side, o.price, o.size))
    );
    const placeTime = Date.now() - placeStart;

    const placed = results.filter(r => r.status === 'fulfilled' && r.value).length;
    let fills = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.trades?.length > 0) {
        fills += r.value.trades.length;
        for (const t of r.value.trades) {
          const matchedOrder = allOrders[results.indexOf(r)] || {};
          pendingReports.push({
            marketId: matchedOrder.marketId || 1,
            taker: CONFIG.owner,
            maker: t.maker || '0x0',
            side: matchedOrder.side || 'buy',
            price: t.price ? Number(BigInt(t.price)) : matchedOrder.price,
            size: t.size ? Number(BigInt(t.size)) : matchedOrder.size,
          });
        }
      }
    }

    flushReports().catch(() => {});

    const totalTime = Date.now() - start;
    const opsPerSec = placeTime > 0 ? Math.round(allOrders.length / (placeTime / 1000)) : 0;

    const midStr = CONFIG.markets.map(id => `${MARKETS[id].symbol}=${liveMid[id] || '?'}`).join(' ');
    console.log(`[mm] #${cycleCount}: cancel=${cancelled} place=${placed}/${allOrders.length} fills=${fills} ${opsPerSec}ops/s ${totalTime}ms | ${midStr}`);

    // Self-heal: if the chain lost its markets (e.g. a state reset/re-seed),
    // every submit fails with "unknown market" and the book goes empty. Re-seed
    // markets + maker collateral so liquidity recovers without a manual restart.
    if (marketMissing && placed === 0) {
      console.warn('[mm] markets missing on chain — re-seeding markets + collateral');
      try { await ensureMarkets(); await ensureCollateral(); }
      catch (e) { console.error(`[mm] re-seed failed: ${e.message}`); }
    }

  } catch (e) {
    console.error('[mm] Error:', e.message);
  } finally {
    isRefreshing = false;
  }
}

async function main() {
  console.log('[mm] Mersennet Trade Market Maker — Dense Liquidity');
  console.log(`[mm] RPC: ${RPC_URL}`);
  console.log(`[mm] Markets: ${CONFIG.markets.map(id => MARKETS[id].symbol).join(', ')}`);
  console.log(`[mm] Refresh: ${CONFIG.refreshInterval / 1000}s | Cancel+Replace each cycle`);

  await ensureMarkets();
  await ensureCollateral();

  await refreshQuotes();
  setInterval(refreshQuotes, CONFIG.refreshInterval);
}

main().catch(e => { console.error('[mm] Fatal:', e); process.exit(1); });
process.on('SIGINT', () => { console.log('[mm] Stopped.'); process.exit(0); });
