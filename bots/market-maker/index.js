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
// `seed` and `tick` are HUMAN prices; scale.js converts them to chain units
// with the market's live priceScale (a $0.05 tick is 1 unit at scale 1 and
// 5 units once the market trades on $0.01 ticks).
const { refreshScales, scaleOf, toChain, chainTick, quietForSwitch, quietReason } = require('./scale');
const { refreshProtocol, ensureUnits, marginBps } = require('./settlement');
const { deriveKey } = require('./signer');
const { ethers: ethersLib } = require('ethers');
const MARKETS = {
  1: { symbol: 'MRSN', seed: 115,   tick: 0.05, baseSize: 150, levels: 3 }, // top level absorbs a whole taker wave (5 × 10) between refreshes
  2: { symbol: 'BTC',  seed: 77000, tick: 10,   baseSize: 3,   levels: 5 }, // busiest market: deeper ask side so takers don't empty it between cycles
  3: { symbol: 'ETH',  seed: 2500,  tick: 1,    baseSize: 8,   levels: 3 },
  4: { symbol: 'SOL',  seed: 100,   tick: 0.05, baseSize: 60,  levels: 3 },
  5: { symbol: 'ARB',  seed: 100,   tick: 0.05, baseSize: 500, levels: 3 },
};

// MM_OWNER: quote for another account through agent delegation — the vault.
// Orders signed by the maker key are booked to MM_OWNER once the vault has
// granted the maker as its agent (vault-manager.js does that); until then the
// precompile books them to the maker itself. Open orders / fills are read for
// the owner, and collateral is the owner's, so seeding is skipped.
const OWNER = (process.env.MM_OWNER || maker.address).toLowerCase();
const CONFIG = {
  // Effective owner: MM_OWNER only while its grant to the maker is live on
  // chain (checked every minute by resolveOwner), else the maker itself.
  owner: maker.address.toLowerCase(),
  markets: [1, 2, 3, 4, 5],
  // With quote maintenance a cycle only replaces the few levels takers
  // consumed (~6-12 txs), so 5s keeps the book two-sided between waves
  // without approaching the per-sender in-flight cap.
  refreshInterval: Number(process.env.MM_REFRESH_MS || 5_000),
  // Off-ladder orders (mid moved, or leftovers) are retired at most this many
  // per cycle so a cancel sweep can never flood the mempool again.
  cancelPerCycle: Number(process.env.MM_CANCEL_PER_CYCLE || 25),
};

let rpcId = 1;
let isRefreshing = false;
let cycleCount = 0;
const liveMid = {};

// ---- Live reference prices ------------------------------------------------
// The CLOB quotes in integer USD ticks, so BTC/ETH/SOL can track their real
// prices; MRSN has no external market and ARB (~$0.14) is below one tick, so
// both keep their seeds. Median of Coinbase + Binance spot, refreshed every
// 30s; a source older than 5 min is ignored and the market falls back to seed.
const REF_SYMBOLS = { 2: { coinbase: 'BTC-USD', binance: 'BTCUSDT' }, 3: { coinbase: 'ETH-USD', binance: 'ETHUSDT' }, 4: { coinbase: 'SOL-USD', binance: 'SOLUSDT' } };
const REF_TTL_MS = 5 * 60_000;
const STALE_BAND = 0.02;        // resting liquidity >2% through our mid is treated as stale
const refPrice = {};            // marketId -> { price, at }
const rawTop = {};              // marketId -> { bid, ask } straight from the chain book
const lastAnchor = {};          // marketId -> anchor used last cycle (for jump detection)

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function refreshReferencePrices() {
  await Promise.all(Object.entries(REF_SYMBOLS).map(async ([id, sym]) => {
    const quotes = [];
    await Promise.all([
      fetchJson(`https://api.coinbase.com/v2/prices/${sym.coinbase}/spot`).then((j) => quotes.push(Number(j?.data?.amount))).catch(() => {}),
      fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${sym.binance}`).then((j) => quotes.push(Number(j?.price))).catch(() => {}),
    ]);
    const valid = quotes.filter((q) => Number.isFinite(q) && q > 0).sort((a, b) => a - b);
    if (valid.length === 0) return;
    const median = valid.length === 2 ? (valid[0] + valid[1]) / 2 : valid[Math.floor(valid.length / 2)];
    refPrice[id] = { price: median, at: Date.now() };
  }));
}

/** Price anchor for a market in CHAIN units: live reference when fresh, else the seed. */
function anchorFor(marketId) {
  const ref = refPrice[marketId];
  if (ref && Date.now() - ref.at < REF_TTL_MS) return toChain(ref.price, marketId);
  return toChain(MARKETS[marketId].seed, marketId);
}

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
    const seed = toChain(MARKETS[marketId]?.seed || 100, marketId);
    // The RPC returns levels in ascending price order on both sides, so the
    // best bid is the *last* bid, not bids[0]. Use max/min explicitly.
    const bidPrices = bids.map((b) => hexToNum(b.price)).filter((p) => p > 0);
    const askPrices = asks.map((a) => hexToNum(a.price)).filter((p) => p > 0);
    // Raw top of book (no outlier filter) for the stale-liquidity guard.
    rawTop[marketId] = {
      bid: bidPrices.length ? Math.max(...bidPrices) : 0,
      ask: askPrices.length ? Math.min(...askPrices) : 0,
    };

    // Best bid/ask within a sanity band around the seed (filters outliers).
    const inBand = (p) => p > seed * 0.3 && p < seed * 3;
    const bandBids = bidPrices.filter(inBand);
    const bandAsks = askPrices.filter(inBand);
    const bestBid = bandBids.length ? Math.max(...bandBids) : 0;
    const bestAsk = bandAsks.length ? Math.min(...bandAsks) : 0;

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
    // A null hash means the wallet skipped the send (in-flight backoff). Return
    // null so the cycle log counts only orders that actually reached the node —
    // wrapping a null hash in an object made "place=30/30" read as healthy while
    // every send was being skipped.
    return txHash ? { txHash, trades: [] } : null;
  } catch (e) {
    if (e.message && e.message.includes('unknown market')) marketMissing = true;
    if (!submitErrLogged) {
      console.error(`[mm] submitOrder(m${marketId} ${side} ${price}x${size}) failed: ${e.message}`);
      submitErrLogged = true;
    }
    return null;
  }
}

// ---- Inventory cap ---------------------------------------------------------
// The maker's position per market, read from the chain every 30 s. Above
// MM_MAX_NOTIONAL (collateral units ≈ USD) of |position| × mid the maker
// quotes only the side that reduces it. Without a cap the random walk of
// taker fills grew the inventory to 400 BTC / 33k SOL short over three days
// (≈$64M notional) — far past what its collateral can margin from the
// settlement switch, so every increasing fill would have been refused.
const MAX_NOTIONAL = Number(process.env.MM_MAX_NOTIONAL || 4_000_000);
const GET_POSITION_SELECTOR = '0x0f85fc5a'; // keccak("getPosition(uint64)")[:4]
const positions = {}; // marketId -> signed size (Number)
let positionsAt = 0;
async function refreshPositions() {
  if (Date.now() - positionsAt < 30_000) return;
  positionsAt = Date.now();
  for (const mId of CONFIG.markets) {
    try {
      const data = GET_POSITION_SELECTOR + BigInt(mId).toString(16).padStart(64, '0');
      const out = await rpcCall('eth_call', [{ from: CONFIG.owner, to: '0x0000000000000000000000000000000000000100', data, gas: '0x30000' }, 'latest']);
      if (!out || out === '0x' || out.length < 66) { positions[mId] = 0; continue; }
      let size = BigInt('0x' + out.slice(2, 66));
      if (size >= (1n << 255n)) size -= (1n << 256n);
      positions[mId] = Number(size);
    } catch { /* keep the last reading */ }
  }
}

// ---- Collateral-aware sizing -----------------------------------------------
// From the settlement switch the CLOB refuses any order whose initial margin
// (notional × initialMarginBps) exceeds the owner's collateral, and a refused
// order is a reverted tx that still burns its gas. The owner is the vault
// when the agent grant is live, so the capacity is the vault's deposits, not
// the maker's own wallet: with 450 MRSN on the precompile after the 20 Sep
// switch the maker kept quoting sizes designed for 2.5M and every order of
// five days reverted (530k failed txs a day, 91% of the chain's traffic,
// zero fills). Quote what the collateral can margin, nothing more.
const ORDER_MARGIN_USE = 0.9;     // one order may use at most this share of the collateral
const INVENTORY_EQUITY_USE = 0.4; // total |position| notional kept at ≤ 40% of the liquidation threshold
let ownerCollateral = null;        // collateral units of CONFIG.owner (MRSN from the switch)
let collateralAt = 0;
const capLogAt = {};               // marketId -> last "sizing to collateral" log
async function refreshCollateral() {
  if (Date.now() - collateralAt < 30_000) return;
  collateralAt = Date.now();
  try {
    const acct = await rpcCall('mersennet_orders_getAccount', [CONFIG.owner]);
    if (acct && acct.collateral != null) ownerCollateral = Number(BigInt(acct.collateral));
  } catch { /* keep the last reading */ }
}
/** Largest notional (collateral units) a single order may carry right now; Infinity without margin checks. */
function perOrderNotionalCap() {
  const { initialMarginBps } = marginBps();
  if (!initialMarginBps || ownerCollateral == null) return Infinity;
  return ownerCollateral * 10_000 / initialMarginBps * ORDER_MARGIN_USE;
}
/** Inventory cap per market: MM_MAX_NOTIONAL, or less when the collateral could not survive it. */
function inventoryCap() {
  const { maintenanceMarginBps } = marginBps();
  if (!maintenanceMarginBps || ownerCollateral == null) return MAX_NOTIONAL;
  return Math.min(MAX_NOTIONAL, ownerCollateral * 10_000 / maintenanceMarginBps * INVENTORY_EQUITY_USE / CONFIG.markets.length);
}

// ---- On-chain revert detection -----------------------------------------------
// `place=N/N` only says the node accepted the tx; whether it executed is in
// the receipt. Sample a few of the previous cycles' hashes each cycle; when
// every sampled order reverted for three cycles running, stop placing for a
// while instead of feeding the chain reverts at 6/s (5 days of it: 25 Sep).
const REVERT_PAUSE_MS = Number(process.env.MM_REVERT_PAUSE_MS || 60_000);
const pendingChecks = [];          // { hash, at }
let revertStreak = 0;
let pausedUntil = 0;
let lastRevertStats = { reverted: 0, sampled: 0 };
async function checkReverts() {
  const now = Date.now();
  const due = pendingChecks.filter((p) => now - p.at > 12_000).slice(0, 4);
  if (!due.length) return;
  let reverted = 0; let sampled = 0;
  for (const p of due) {
    const idx = pendingChecks.indexOf(p);
    if (idx >= 0) pendingChecks.splice(idx, 1);
    try {
      const r = await rpcCall('eth_getTransactionReceipt', [p.hash]);
      if (!r) continue;               // not mined (yet): no signal
      sampled++;
      if (r.status === '0x0') reverted++;
    } catch { /* rpc hiccup: no signal */ }
  }
  if (!sampled) return;
  lastRevertStats = { reverted, sampled };
  revertStreak = reverted === sampled ? revertStreak + 1 : 0;
  if (revertStreak >= 3 && now >= pausedUntil) {
    pausedUntil = now + REVERT_PAUSE_MS;
    console.warn(`[mm] every sampled order reverted on chain for ${revertStreak} cycles (owner ${CONFIG.owner}, collateral ${ownerCollateral ?? '?'} units, per-order cap ${Math.round(perOrderNotionalCap()).toLocaleString()}) — not placing for ${REVERT_PAUSE_MS / 1000}s`);
  }
}

function buildOrders(marketId, mid) {
  const m = MARKETS[marketId];
  const tick = chainTick(m.tick, marketId);
  const levels = m.levels;
  const orders = [];
  const scale = scaleOf(marketId);
  // Inventory cap: past the cap quote only the reducing side.
  const pos = positions[marketId] || 0;
  const notional = Math.abs(pos) * (mid / scale);
  const maxNotional = inventoryCap();
  const capLong = notional >= maxNotional && pos > 0;   // long: stop bidding
  const capShort = notional >= maxNotional && pos < 0;  // short: stop asking
  if (capLong || capShort) console.log(`[mm] ${m.symbol}: inventory ${pos} (~${Math.round(notional).toLocaleString()} notional) at cap ${Math.round(maxNotional).toLocaleString()} — quoting ${capLong ? 'asks' : 'bids'} only`);
  const orderCap = perOrderNotionalCap();
  let shrunk = 0; let dropped = 0;
  // Size an order so its notional fits the collateral; 0 = the level cannot be quoted at all.
  const fit = (size, price) => {
    const unit = price / scale;
    if (size * unit <= orderCap) return size;
    const s = Math.floor(orderCap / unit);
    if (s >= 1) shrunk++; else dropped++;
    return s;
  };

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

    // Stale-liquidity guard. A resting bid far above (or ask far below) the
    // reference price is not a market — it is someone's forgotten order (the
    // old GTC takers left 141k of them). Quoting into it fills instantly at
    // the wrong price and prints it on the tape; the drain job removes such
    // orders, we simply do not trade with them.
    const top = rawTop[marketId] || { bid: 0, ask: 0 };
    const skipAsks = top.bid > 0 && top.bid > mid * (1 + STALE_BAND);
    const skipBids = top.ask > 0 && top.ask < mid * (1 - STALE_BAND);

    if (bidPrice >= 1 && !skipBids && !capLong) {
      const s = fit(size, bidPrice);
      if (s >= 1) orders.push({ marketId, side: 'buy',  price: bidPrice, size: s });
    }
    if (askPrice >= 2) {
      const s = fit(size, askPrice);
      if (!skipAsks && !capShort && s >= 1) orders.push({ marketId, side: 'sell', price: askPrice, size: s });
    }
  }

  if ((shrunk || dropped) && Date.now() - (capLogAt[marketId] || 0) > 300_000) {
    capLogAt[marketId] = Date.now();
    console.log(`[mm] ${m.symbol}: collateral ${ownerCollateral} units caps one order at ~${Math.round(orderCap).toLocaleString()} notional — ${shrunk} level(s) shrunk, ${dropped} dropped`);
  }
  return orders;
}

/** Identity of a quote level: one resting order per (market, side, price). */
function quoteKey(o) {
  return `${o.marketId}:${o.side}:${o.price}`;
}

/** The maker's resting orders, normalised to { id, marketId, side, price }. */
async function openOrders() {
  try {
    const raw = await rpcCall('mersennet_orders_getOpenOrders', [CONFIG.owner]);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((o) => ({
        id: BigInt(o.order_id ?? o.id ?? 0),
        marketId: hexToNum(o.market_id ?? o.marketId),
        side: String(o.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
        price: hexToNum(o.price),
      }))
      .filter((o) => o.id > 0n);
  } catch (e) {
    console.error(`[mm] openOrders failed: ${e.message}`);
    return [];
  }
}

/** Cancel the given orders (already bounded by the caller); returns how many were sent. */
async function cancelOrders(orders) {
  if (orders.length === 0) return 0;
  const results = await Promise.allSettled(orders.map((o) => maker.cancelOrder(o.id)));
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
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
let ownerCheckedAt = 0;
async function resolveOwner() {
  if (OWNER === maker.address.toLowerCase()) return;
  if (Date.now() - ownerCheckedAt < 60_000) return;
  ownerCheckedAt = Date.now();
  try {
    const view = await rpcCall('mersennet_orders_getAgents', [OWNER]);
    const mine = (view?.agents || []).find((a) => a.agent.toLowerCase() === maker.address.toLowerCase());
    const live = !!view?.active && !!mine && !mine.expired;
    const next = live ? OWNER : maker.address.toLowerCase();
    if (next !== CONFIG.owner) {
      console.log(live
        ? `[mm] agent grant live — quoting for ${OWNER}`
        : `[mm] no live agent grant from ${OWNER} (delegation ${view?.active ? 'active' : 'inactive'}) — quoting for own account`);
      CONFIG.owner = next;
      collateralAt = 0; // re-read the collateral of the new owner on this cycle
    }
  } catch (e) {
    /* keep the current owner on rpc hiccups */
  }
}

async function ensureCollateral() {
  // Collateral is kept at MM_TARGET_COLLATERAL MRSN by ensureSettlementCollateral
  // (era-aware units). The old fixed-unit seed deposit would be 1e12 MRSN after
  // the settlement switch and revert on every start.
  if (OWNER !== maker.address.toLowerCase()) {
    console.log(`[mm] acting as agent for ${OWNER}: collateral is the vault's, not seeding`);
  }
}

// The maker holds MM_TARGET_COLLATERAL MRSN of collateral (10x margin from
// the settlement switch → 25M notional of capacity, 4M cap per market) and
// keeps every taker wallet funded with native MRSN so they can hold theirs
// (50k each → 500k capacity, ~6 BTC). The maker wallet was topped up with 3M
// MRSN from the faucet wallet on 18 Sep for this. Funded in every era: a
// deposit made before the switch carries over as the same MRSN.
const TARGET_COLLATERAL = BigInt(process.env.MM_TARGET_COLLATERAL || 2_500_000);
const TAKER_FUND_MRSN = BigInt(process.env.MM_TAKER_FUND_MRSN || 60_000);
const NUM_TAKERS = Number(process.env.NUM_TAKERS || 20);
let lastSettlementCheck = 0;
async function ensureSettlementCollateral() {
  if (Date.now() - lastSettlementCheck < 60_000) return;
  lastSettlementCheck = Date.now();
  await refreshProtocol(rpcCall);
  if (OWNER === maker.address.toLowerCase() || CONFIG.owner === maker.address.toLowerCase()) {
    try { await ensureUnits(maker, TARGET_COLLATERAL, 'mm'); } catch (e) { console.warn('[mm] collateral top-up failed:', e.message); }
  }
  // Fund takers and the liquidation keeper (only when a balance is below half its target).
  const wallets = [...Array.from({ length: NUM_TAKERS }, (_, i) => `taker-${i}`), 'liquidator'];
  for (const label of wallets) {
    try {
      const addr = new ethersLib.Wallet(deriveKey(label)).address;
      const bal = BigInt(await rpcCall('eth_getBalance', [addr, 'latest']) || '0x0');
      const target = label === 'liquidator' ? 200n : TAKER_FUND_MRSN; // the keeper only needs gas
      if (bal < (target * 10n ** 18n) / 2n) {
        const tx = await maker.sendValue(addr, target * 10n ** 18n);
        console.log(`[mm] funded ${label} ${addr} with ${target} MRSN (tx ${tx})`);
      }
    } catch (e) { console.warn(`[mm] ${label} funding failed:`, e.message); }
  }
}

let quietLogged = false;
async function refreshQuotes() {
  if (isRefreshing) return;
  if (quietForSwitch()) {
    if (!quietLogged) { console.log(`[mm] quiet: ${quietReason()}`); quietLogged = true; }
    return;
  }
  if (quietLogged) { console.log('[mm] switch passed, quoting with the new scales'); quietLogged = false; }
  isRefreshing = true;
  await resolveOwner();
  await ensureSettlementCollateral();
  await refreshPositions();
  await refreshCollateral();
  await checkReverts();
  cycleCount++;
  submitErrLogged = false;
  marketMissing = false;
  const start = Date.now();

  try {
    // Anchor each market to its live reference price (or seed), blended
    // 70/30 with the chain's own mid so the book follows reality without
    // whipsawing on a single print. A jump of >5% in the anchor (first live
    // fetch after a restart, or a real market move) invalidates every resting
    // order on that market so the old ladder is not crossed by the new one.
    const jumped = new Set();
    await Promise.all(CONFIG.markets.map(async (mId) => {
      const chainMid = await fetchMidPrice(mId);
      const anchor = anchorFor(mId);
      if (lastAnchor[mId] && Math.abs(anchor - lastAnchor[mId]) / lastAnchor[mId] > 0.05) jumped.add(mId);
      lastAnchor[mId] = anchor;
      const nearAnchor = chainMid && chainMid > 0 && Math.abs(chainMid - anchor) / anchor < 0.05;
      liveMid[mId] = Math.round(nearAnchor ? anchor * 0.7 + chainMid * 0.3 : anchor);
    }));

    // Interleave orders across markets (round-robin by depth level) so no
    // single market monopolizes the low mempool nonces — orders settle as
    // sequential txs from one sender, so a flat per-market concatenation
    // left later markets perpetually behind and unfilled.
    const perMarket = CONFIG.markets.map((marketId) =>
      buildOrders(marketId, liveMid[marketId] || toChain(MARKETS[marketId].seed, marketId)),
    );
    const ladder = [];
    const maxLen = Math.max(0, ...perMarket.map((o) => o.length));
    for (let i = 0; i < maxLen; i++) {
      for (const orders of perMarket) {
        if (i < orders.length) ladder.push(orders[i]);
      }
    }

    // Quote maintenance instead of blind re-quoting. Every order is a mined
    // tx, so re-placing the full ladder each cycle and bulk-cancelling every
    // Nth cycle grew the open-order set into the thousands and then fired a
    // thousand-cancel burst that flooded the mempool. Instead, diff the
    // resting orders against the desired ladder: keep levels already quoted,
    // place only the missing ones (typically what the taker just consumed),
    // and retire a bounded number of off-ladder orders per cycle.
    const resting = await openOrders();
    const wanted = new Set(ladder.map(quoteKey));
    // One resting order per level: the oldest keeps its price-time priority,
    // any newer duplicate at the same level is surplus and gets retired along
    // with off-ladder orders (oldest first, bounded per cycle).
    const keeper = new Map();
    for (const o of resting) {
      const k = quoteKey(o);
      if (wanted.has(k) && (!keeper.has(k) || o.id < keeper.get(k).id)) keeper.set(k, o);
    }
    const quoted = new Set(keeper.keys());
    if (jumped.size) for (const k of [...quoted]) { if (jumped.has(Number(k.split(':')[0]))) quoted.delete(k); }
    // While paused after a revert streak, keep maintaining (cancels) but place nothing.
    const paused = Date.now() < pausedUntil;
    const allOrders = paused ? [] : ladder.filter((o) => !quoted.has(quoteKey(o)));
    const stale = resting
      .filter((o) => keeper.get(quoteKey(o)) !== o || jumped.has(o.marketId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const cancelled = await cancelOrders(stale.slice(0, CONFIG.cancelPerCycle));

    const placeStart = Date.now();
    const results = await Promise.allSettled(
      allOrders.map(o => submitOrder(o.marketId, o.side, o.price, o.size))
    );
    const placeTime = Date.now() - placeStart;

    const placed = results.filter(r => r.status === 'fulfilled' && r.value).length;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.txHash && pendingChecks.length < 24) pendingChecks.push({ hash: r.value.txHash, at: Date.now() });
    }
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
    // Account nonce is the ground truth for "orders actually mined": if it
    // stops advancing while place>0, the wallet is wedged (signer.js resyncs).
    const w = maker.stats();
    console.log(`[mm] #${cycleCount}: resting=${resting.length} quoted=${ladder.length - allOrders.length}/${ladder.length} place=${placed}/${allOrders.length} cancel=${cancelled}/${stale.length} fills=${fills} reverted=${lastRevertStats.reverted}/${lastRevertStats.sampled}${paused ? ' PAUSED' : ''} collateral=${ownerCollateral ?? '?'} nonce=${w.mined}/${w.local} skipped=${w.skipped} ${opsPerSec}ops/s ${totalTime}ms | ${midStr}`);

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
  console.log(`[mm] Refresh: ${CONFIG.refreshInterval / 1000}s | quote maintenance (place missing levels, retire <=${CONFIG.cancelPerCycle} off-ladder/duplicate orders per cycle)`);

  await ensureMarkets();
  await ensureCollateral();

  await refreshScales(rpcCall);
  // One getMarkets per cycle: the price-scale switch must be seen before the
  // next ladder is built (a stale scale would quote at 1/100 of the price).
  setInterval(() => refreshScales(rpcCall), Math.min(CONFIG.refreshInterval, 5_000));
  console.log(`[mm] price scales: ${CONFIG.markets.map((id) => `${MARKETS[id].symbol}=${scaleOf(id)}`).join(' ')}`);
  await refreshReferencePrices().catch(() => {});
  setInterval(() => refreshReferencePrices().catch(() => {}), 30_000);
  console.log(`[mm] reference prices: ${Object.keys(REF_SYMBOLS).map((id) => `${MARKETS[id].symbol}=${refPrice[id] ? Math.round(refPrice[id].price) : 'seed'}`).join(' ')}`);

  await refreshQuotes();
  setInterval(refreshQuotes, CONFIG.refreshInterval);
}

main().catch(e => { console.error('[mm] Fatal:', e); process.exit(1); });
process.on('SIGINT', () => { console.log('[mm] Stopped.'); process.exit(0); });
