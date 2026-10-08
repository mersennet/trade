/**
 * Mersennet chain adapter for Mersennet Trade.
 *
 * Talks to the Mersennet L1 (chain ID 131071) — order book, positions, and
 * collateral live in the native MersennetOrders CLOB precompile at 0x...0100.
 * There is no off-chain sequencer and no external Vault/PerpEngine/Oracle
 * contracts: matching is on-chain and atomic.
 *
 * Surfaces:
 *   - `mersennet_orders_*` JSON-RPC for order book state + order submission
 *   - `eth_call` against the precompile for per-account reads
 *   - calldata builders so the frontend can sign deposit/withdraw txs
 */

const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const PRECOMPILE = '0x0000000000000000000000000000000000000100';

// On-chain conventions (MersennetOrders precompile, matching the live testnet
// and the original MersennetTrade terminal): collateral, prices, and sizes are
// plain integer units (no decimal scaling). The engine computes
// notional = price * size and compares it against collateral directly.
const USDC_DECIMALS = 0; // export name kept for route compatibility — MRSN collateral units
const SIZE_DECIMALS = 0;
const PRICE_DECIMALS = 0;
const USDC_UNIT  = 10n ** BigInt(USDC_DECIMALS);
const SIZE_UNIT  = 10n ** BigInt(SIZE_DECIMALS);
const PRICE_UNIT = 10n ** BigInt(PRICE_DECIMALS);

// Risk parameters come from the chain, not from a table. There is NO funding
// on the testnet CLOB (no funding interval, no payments), so `fundingRate` is
// null everywhere and the UIs hide the column. Max leverage is the inverse of
// the initial margin the protocol enforces from the settlement switch (10% →
// 10×); before that height the chain enforces no margin at all, which the
// UI states rather than inventing per-market caps (the old 100×/50×/20×
// numbers were never enforced anywhere).
const FALLBACK_INITIAL_MARGIN_BPS = 1000;
function maxLeverageFromProtocol() {
  const p = protocolCache.value;
  const bps = Number(p && (p.settlementInitialMarginBps || p.initialMarginBps)) || FALLBACK_INITIAL_MARGIN_BPS;
  return Math.max(1, Math.floor(10000 / bps));
}
/** True once the chain enforces initial margin (settlement switch passed). */
function marginEnforced() {
  const p = protocolCache.value;
  return !!(p && p.settlementActive);
}

// USD-quoted perps, MRSN-collateralized. There is no USDC on the perp side —
// the quote is the oracle's USD price (spot pairs against MockUSDC live in
// spotEngine). This array is the seed / RPC-outage fallback; refreshMarkets()
// below syncs it IN PLACE with the live on-chain list (markets are created
// permissionlessly via createMarket, so new listings must appear without a
// redeploy — every consumer iterates chain.MARKETS at call time).
const MARKETS = [
  { id: 1, symbol: 'MRSN/USD', base: 'MRSN', quote: 'USD', maxLeverage: 10, fundingRate: null },
  { id: 2, symbol: 'BTC/USD',  base: 'BTC',  quote: 'USD', maxLeverage: 10, fundingRate: null },
  { id: 3, symbol: 'ETH/USD',  base: 'ETH',  quote: 'USD', maxLeverage: 10, fundingRate: null },
  { id: 4, symbol: 'SOL/USD',  base: 'SOL',  quote: 'USD', maxLeverage: 10, fundingRate: null },
  { id: 5, symbol: 'ARB/USD',  base: 'ARB',  quote: 'USD', maxLeverage: 10, fundingRate: null },
];

/**
 * Sync MARKETS with `mersennet_orders_getMarkets`. Chain symbols are bare
 * ("MRSN"); the UI convention is BASE/USD. Hex tick/lot sizes are decoded to
 * plain integers (chain units). On RPC failure the previous list is kept.
 */
async function refreshMarkets() {
  try {
    // Leverage/margin flags derive from the protocol; refresh it first so the
    // market list never carries a stale era.
    await getProtocol().catch(() => null);
    const live = await rpcCall('mersennet_orders_getMarkets', []);
    if (!Array.isArray(live) || live.length === 0) return;
    const toInt = (v) => {
      try { return Number(BigInt(v ?? '0x1')); } catch { return 1; }
    };
    // Listings from automated end-to-end runs (symbols E2E<n>) are real
    // on-chain markets but noise for traders; hide them from every list.
    const hidden = new RegExp(process.env.HIDDEN_MARKET_PATTERN || '^E2E\\d*$', 'i');
    const mapped = live
      .filter((m) => (m.status ?? 'active') === 'active')
      .filter((m) => !hidden.test(String(m.symbol || '')))
      .map((m) => {
        const base = String(m.symbol || `MKT${m.id}`).toUpperCase();
        return {
          id: Number(m.id),
          symbol: `${base}/USD`,
          base,
          quote: 'USD',
          maxLeverage: maxLeverageFromProtocol(),
          marginEnforced: marginEnforced(),
          fundingRate: null,
          tickSize: toInt(m.tickSize),
          lotSize: toInt(m.lotSize),
          // On-chain price = human price × priceScale (1 until a market is
          // rescaled to finer ticks). Every consumer divides by it.
          priceScale: Math.max(1, toInt(m.priceScale ?? 1)),
        };
      });
    MARKETS.length = 0;
    MARKETS.push(...mapped);
  } catch (e) {
    console.warn('[chain] refreshMarkets failed (keeping previous list):', e.message);
  }
}

// Deferred a tick: rpcCall's `let _rpcId` is declared below and would be in
// its temporal dead zone if called synchronously at module load.
setImmediate(refreshMarkets);
// 10 s: a price-scale switch must reach every consumer quickly.
const _marketsTimer = setInterval(refreshMarkets, 10_000);
if (_marketsTimer.unref) _marketsTimer.unref();

// ---------------------------------------------------------------------
// Generic JSON-RPC
// ---------------------------------------------------------------------

let _rpcId = 1;
async function rpcCall(method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } catch (e) {
    e.upstream = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function ethCall(data, from) {
  const callObj = { to: PRECOMPILE, data };
  if (from) callObj.from = from;
  return rpcCall('eth_call', [callObj, 'latest']);
}

// ---------------------------------------------------------------------
// ABI helpers (precompile uses standard Solidity ABI encoding)
// ---------------------------------------------------------------------

const PRECOMPILE_IFACE = new ethers.Interface([
  'function placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif) returns (uint256, uint256, uint256)',
  'function cancelOrder(uint256 orderId) returns (bool)',
  'function depositCollateral(uint256 amount) returns (bool)',
  'function withdrawCollateral(uint256 amount) returns (bool)',
  'function getPosition(uint64 marketId) view returns (int128 size, uint256 entryPrice)',
  'function getCollateral() view returns (uint256)',
  'function isLiquidatable(address account) view returns (bool)',
  'function getBestBidAsk(uint64 marketId) view returns (uint256 bestBid, uint256 bestAsk)',
]);

function rawToUnits(raw, decimals) {
  // Convert a BigInt-style raw amount string into a JS Number with `decimals` precision.
  if (raw == null) return 0;
  const s = typeof raw === 'string' ? raw : raw.toString();
  if (!decimals) return Number(s);
  const sign = s.startsWith('-') ? -1 : 1;
  const abs  = s.replace(/^-/, '');
  if (abs === '0') return 0;
  const padded = abs.padStart(decimals + 1, '0');
  const intPart  = padded.slice(0, -decimals) || '0';
  const fracPart = padded.slice(-decimals);
  return sign * Number(`${intPart}.${fracPart}`);
}

// ---------------------------------------------------------------------
// Per-account reads (precompile eth_call with `from` = trader)
// ---------------------------------------------------------------------

const FLAT_POSITION = Object.freeze({ sizeRaw: '0', size: 0, entryPriceRaw: '0', entryPrice: 0, entryNotionalRaw: '0', entryNotional: 0, reservedMargin: 0, reservedMarginRaw: '0' });

// RPC failures propagate: a caller that read them as "no position" would show
// an open position as closed and price liquidations off zero collateral.
async function getPosition(marketId, address) {
  const data = PRECOMPILE_IFACE.encodeFunctionData('getPosition', [marketId]);
  const r = await ethCall(data, address);
  if (typeof r !== 'string' || r.startsWith('0x08c379a0')) return { ...FLAT_POSITION };
  try {
    const [size, entryPrice] = PRECOMPILE_IFACE.decodeFunctionResult('getPosition', r);
    const sizeRaw = size.toString();
    const entryPriceRaw = entryPrice.toString();
    const scale = BigInt(priceScaleOf(marketId));
    const notionalRaw = (BigInt(sizeRaw) < 0n ? -BigInt(sizeRaw) : BigInt(sizeRaw)) * BigInt(entryPriceRaw) / SIZE_UNIT / scale;
    return {
      sizeRaw,                                                // raw (signed), plain integer units
      size: rawToUnits(sizeRaw, SIZE_DECIMALS),               // human base units
      entryPriceRaw,                                          // chain units (human × priceScale)
      entryPrice: toHumanPrice(marketId, entryPriceRaw),      // human quote
      entryNotionalRaw: notionalRaw.toString(),
      entryNotional: rawToUnits(notionalRaw.toString(), USDC_DECIMALS),
      reservedMargin: 0,        // margin reservation is internal to the precompile
      reservedMarginRaw: '0',
    };
  } catch {
    return { ...FLAT_POSITION };
  }
}

async function getCollateralRaw(address) {
  const data = PRECOMPILE_IFACE.encodeFunctionData('getCollateral', []);
  const r = await ethCall(data, address);
  if (typeof r !== 'string' || r.startsWith('0x08c379a0')) return '0';
  try {
    const [collateral] = PRECOMPILE_IFACE.decodeFunctionResult('getCollateral', r);
    return collateral.toString();
  } catch {
    return '0';
  }
}

// One collateral unit is one MRSN from the settlement switch (block
// 1,605,600) and one wei before it. `mersennet_orders_getProtocol` exposes the
// live factor as `weiPerCollateralUnit`, so units ↔ MRSN is derived from the
// chain rather than hard-coded to either era: a deposit made on Friday reads as
// the same number of MRSN on Sunday.
const WEI_PER_MRSN = 10n ** 18n;
function weiPerCollateralUnit() {
  const raw = protocolCache.value && protocolCache.value.weiPerCollateralUnit;
  try { const v = BigInt(raw ?? 1); return v > 0n ? v : 1n; } catch { return 1n; }
}
/** Collateral units that make up one MRSN (1e18 before the settlement switch, 1 after). */
function unitsPerMrsn() {
  return WEI_PER_MRSN / weiPerCollateralUnit();
}
/** Decimal places implied by the current unit (18 before the switch, 0 after). */
function collateralDecimals() {
  return String(unitsPerMrsn()).length - 1;
}
/** Raw collateral units → human MRSN (float, display precision). */
function unitsToMrsn(raw) {
  if (raw == null) return 0;
  let u; try { u = BigInt(String(raw)); } catch { return 0; }
  const per = unitsPerMrsn();
  const whole = u / per;
  const frac = u % per;
  return Number(whole) + Number(frac) / Number(per);
}
/** Human MRSN (string/number) → raw collateral units (BigInt, floor). */
function mrsnToUnits(human) {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${human}`);
  const [int, frac = ''] = s.split('.');
  const wei = BigInt(int) * WEI_PER_MRSN + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return wei / weiPerCollateralUnit();
}

/**
 * Margin collateral in MRSN as the chain counts it: native MRSN plus
 * registered token collateral at its weight (see getMarginCollateral below).
 * Every equity / margin-ratio / liquidation computation in the API goes
 * through here, so a USDC-only account is a funded account everywhere.
 */
async function getCollateral(address) {
  return (await getMarginCollateral(address)).collateral;
}

/** Native MRSN collateral only — the part a native withdrawal can move. */
async function getFreeCollateral(address) {
  return (await getMarginCollateral(address)).native;
}

// ---------------------------------------------------------------------
// Margin collateral = native MRSN + registered token collateral at its weight
// ---------------------------------------------------------------------
// The chain's margin checks use `collateral + token_margin_value` (USDC at
// 90% today; the allowlist is `mersennet_orders_getCollateralAssets`). A user
// who deposited only USDC therefore *can* trade — the UI must count it too,
// or it tells them "no collateral" while the chain would accept their order.

const ERC20_SYMBOL = '0x95d89b41';   // symbol()
const ERC20_DECIMALS = '0x313ce567'; // decimals()
let _assetsCache = { at: 0, value: null };
const _tokenMetaCache = new Map();

function decodeAbiString(hex) {
  try {
    const h = hex.replace(/^0x/, '');
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0+$/, '');
  } catch { return 'TOKEN'; }
}

/** Registered collateral assets with symbol/decimals, cached 5 min. */
async function getCollateralAssets() {
  if (_assetsCache.value && Date.now() - _assetsCache.at < 300_000) return _assetsCache.value;
  const raw = (await rpcCall('mersennet_orders_getCollateralAssets', [])) || [];
  const assets = [];
  for (const a of raw) {
    const token = String(a.token).toLowerCase();
    let meta = _tokenMetaCache.get(token);
    if (!meta) {
      let symbol = 'TOKEN'; let decimals = 18;
      try { symbol = decodeAbiString(await rpcCall('eth_call', [{ to: token, data: ERC20_SYMBOL }, 'latest'])); } catch { /* keep default */ }
      try { decimals = parseInt(String(await rpcCall('eth_call', [{ to: token, data: ERC20_DECIMALS }, 'latest'])), 16) || 18; } catch { /* keep default */ }
      meta = { symbol, decimals };
      _tokenMetaCache.set(token, meta);
    }
    assets.push({
      token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      weightBps: Number(a.weightBps),
      valueNum: BigInt(a.valueNum ?? 1),
      valueDen: BigInt(a.valueDen ?? 1) || 1n,
    });
  }
  _assetsCache = { at: Date.now(), value: assets };
  return assets;
}

/**
 * What the chain counts as margin for `address`, in MRSN:
 * { collateral (total), native, tokenMarginValue, tokens: [{ symbol, amount, marginValue, weightBps }] }.
 */
async function getMarginCollateral(address) {
  await getProtocol();
  const [acct, assets] = await Promise.all([
    rpcCall('mersennet_orders_getAccount', [address]).catch(() => null),
    getCollateralAssets().catch(() => []),
  ]);
  const nativeRaw = acct && acct.collateral != null ? BigInt(acct.collateral) : BigInt(await getCollateralRaw(address));
  const native = unitsToMrsn(nativeRaw);
  const tokens = [];
  let tokenUnits = 0n;
  for (const tc of (acct && acct.tokenCollateral) || []) {
    const asset = assets.find((a) => a.token === String(tc.token).toLowerCase());
    if (!asset) continue;
    const amountRaw = BigInt(tc.amount);
    // Same arithmetic as the chain: amount * value_num / value_den * weight / 10000, in collateral units.
    const marginUnits = (amountRaw * asset.valueNum / asset.valueDen) * BigInt(asset.weightBps) / 10_000n;
    tokenUnits += marginUnits;
    tokens.push({
      token: asset.token,
      symbol: asset.symbol,
      amount: Number(amountRaw) / 10 ** asset.decimals,
      marginValue: unitsToMrsn(marginUnits),
      weightBps: asset.weightBps,
    });
  }
  const tokenMarginValue = unitsToMrsn(tokenUnits);
  return { collateral: native + tokenMarginValue, native, tokenMarginValue, tokens };
}

async function getBestBidAsk(marketId) {
  try {
    const data = PRECOMPILE_IFACE.encodeFunctionData('getBestBidAsk', [marketId]);
    const r = await ethCall(data);
    const [bestBid, bestAsk] = PRECOMPILE_IFACE.decodeFunctionResult('getBestBidAsk', r);
    return { bestBid: bestBid.toString(), bestAsk: bestAsk.toString() };
  } catch {
    return { bestBid: '0', bestAsk: '0' };
  }
}

// While the market maker requotes, a side of the book can lose its quotes for
// a block, leaving a stray resting order as the best price ($10 bids on MRSN
// at $115). Marking positions, stops and alerts there fires them falsely, so
// a book wider than 1% (quotes are ~0.1% wide) is marked at the median of bid,
// ask and last trade, and a one-sided book keeps the last good mark.
const _lastMark = new Map();
const MARK_FALLBACK_MS = 10 * 60_000;

/** Mark from book top and last trade (BigInt raw units, 0n = absent); null when a side is missing. */
function markFromBook(bid, ask, last) {
  if (bid <= 0n || ask <= 0n) return null;
  const mid = (bid + ask) / 2n;
  if (ask - bid <= mid / 100n || last <= 0n) return mid;
  return [bid, ask, last].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[1];
}

async function lastTradePrice(marketId) {
  const markets = await rpcCall('mersennet_orders_getMarkets', []);
  const m = (markets || []).find((x) => Number(x.id) === Number(marketId));
  return m && m.lastPrice ? BigInt(m.lastPrice) : 0n;
}

/** Mark price in raw chain units (see markFromBook); '0' when there is no price at all. */
async function getMarkPrice(marketId) {
  const id = Number(marketId);
  const { bestBid, bestAsk } = await getBestBidAsk(id);
  const bid = BigInt(bestBid);
  const ask = BigInt(bestAsk);
  const wide = bid > 0n && ask > 0n && ask - bid > (bid + ask) / 200n;
  const mark = markFromBook(bid, ask, wide ? await lastTradePrice(id).catch(() => 0n) : 0n);
  if (mark != null) {
    _lastMark.set(id, { mark, at: Date.now() });
    return mark.toString();
  }
  const kept = _lastMark.get(id);
  if (kept && Date.now() - kept.at < MARK_FALLBACK_MS) return kept.mark.toString();
  const last = await lastTradePrice(id).catch(() => 0n);
  return (last > 0n ? last : bid > 0n ? bid : ask).toString();
}

// Markets with no external listing are priced off their own book, so a swept
// or polluted book became "the price" (6 Oct: MRSN/USD shown at $16,472, and
// bots quoting off this feed kept it there). Outside 0.3x-3x of the seed the
// display falls back to the seed.
const DISPLAY_REFERENCE_USD = { 1: 115, 5: 100 };

/** Display-only price with age. Mersennet matches on-chain, so mid is never stale. */
async function getOraclePriceForDisplay(marketId) {
  const price = await getMarkPrice(marketId);
  const ref = DISPLAY_REFERENCE_USD[Number(marketId)];
  const human = toHumanPrice(marketId, price);
  if (ref && human > 0 && (human > ref * 3 || human < ref * 0.3)) {
    return { price: toChainPrice(marketId, ref).toString(), age: 0, clamped: true };
  }
  return { price, age: 0 };
}

async function isLiquidatable(marketId, address) {
  try {
    const data = PRECOMPILE_IFACE.encodeFunctionData('isLiquidatable', [address]);
    const r = await ethCall(data);
    const [ok] = PRECOMPILE_IFACE.decodeFunctionResult('isLiquidatable', r);
    return { liquidatable: ok, maintenanceMargin: '0', equity: '0' };
  } catch {
    return { liquidatable: false };
  }
}

// Stats that came from the earlier contract-based vault/perp engine don't exist as
// dedicated chain reads here; the indexer aggregates them from fills.
async function getOpenInterest() { return '0'; }
async function getInsuranceFundUsd() { return 0; }
async function getPnlPoolUsd() { return 0; }
async function getVaultTvlUsd() { return 0; }

async function getMarketConfig(marketId) {
  const m = MARKETS.find((x) => x.id === Number(marketId));
  if (!m) return null;
  return {
    enabled: true,
    initialMarginBps: Math.floor(10000 / m.maxLeverage),
    maintenanceMarginBps: Math.floor(10000 / m.maxLeverage / 2),
    takerFeeBps: 5,
    makerFeeBps: 2,
    liquidationFeeBps: 50,
    fundingIntervalSec: 8 * 3600,
    cumulativeFunding: '0',
    lastFundingTime: 0,
  };
}

// ---------------------------------------------------------------------
// Order book — native on-chain CLOB via mersennet_orders_* RPC
// ---------------------------------------------------------------------

async function getOrderBook(marketId) {
  try {
    const book = await rpcCall('mersennet_orders_getOrderBook', [Number(marketId)]);
    return book || { bids: [], asks: [] };
  } catch {
    return { bids: [], asks: [] };
  }
}

async function getOpenOrders(address) {
  try {
    const body = await rpcCall('mersennet_orders_getOpenOrders', [address]);
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.orders)) return body.orders;
    return [];
  } catch {
    return [];
  }
}

/**
 * Submit an order to the on-chain CLOB.
 * Expects {owner, market_id, side, price, size, tif} with price/size as
 * raw hex (1e18). Matching is atomic — the result reports fills directly.
 */
// The node does NOT emit MersennetOrdersTrades WS events for submitOrder RPC
// fills, so the indexer's subscription never sees them. We report fills to the
// indexer directly here so trades/volume/candles populate for both bot and real
// user orders. Fire-and-forget; never block or fail the order on a report error.
const INDEXER_REPORT_URL = process.env.INDEXER_REPORT_URL || 'http://127.0.0.1:4010/trades';
function hexToNum(v) {
  try { return typeof v === 'string' && v.startsWith('0x') ? Number(BigInt(v)) : Number(v) || 0; }
  catch { return 0; }
}
function reportFills(result, marketIdFallback, sideFallback) {
  const trades = result && Array.isArray(result.trades) ? result.trades : [];
  if (trades.length === 0) return;
  const payload = trades.map(t => ({
    market_id: hexToNum(t.market_id) || Number(marketIdFallback) || 0,
    taker: t.taker,
    maker: t.maker,
    side: t.side || sideFallback,
    price: hexToNum(t.price),
    size: hexToNum(t.size),
  }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.REPORT_SECRET) headers['X-Report-Secret'] = process.env.REPORT_SECRET;
  fetch(INDEXER_REPORT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

async function submitOrder(_params) {
  // Unsigned owner-field placement is disabled on the node. Clients must
  // send a wallet-signed placeOrder tx to the CLOB precompile.
  const err = new Error(
    'Unsigned submitOrder is disabled; sign a placeOrder tx to 0x…0100 and submit via eth_sendRawTransaction'
  );
  err.statusCode = 410;
  err.code = 'SIGNED_ORDER_REQUIRED';
  throw err;
}

async function cancelOrder(_orderId) {
  const err = new Error(
    'Unsigned cancelOrder is disabled; sign a cancelOrder tx to 0x…0100 and submit via eth_sendRawTransaction'
  );
  err.statusCode = 410;
  err.code = 'SIGNED_ORDER_REQUIRED';
  throw err;
}

// ---------------------------------------------------------------------
// Native MRSN balance
// ---------------------------------------------------------------------

async function getBalance(address) {
  const r = await rpcCall('eth_getBalance', [address, 'latest']);
  return BigInt(r).toString();
}

// The head is shared for a second, so a burst of requests makes one call, and
// a refused call (the RPC's per-IP rate limit) is answered from a head under
// 30 s old instead of failing the request (and the health check).
let _head = { number: null, at: 0 };
async function getBlockNumber() {
  const now = Date.now();
  if (_head.number != null && now - _head.at < 1000) return _head.number;
  try {
    const r = await rpcCall('eth_blockNumber');
    _head = { number: Number(BigInt(r)), at: now };
    return _head.number;
  } catch (e) {
    if (_head.number != null && now - _head.at < 30_000) return _head.number;
    throw e;
  }
}

// Deposit / withdraw collateral via the precompile.
// These return calldata for the frontend to sign with the user's wallet.
// Deposits are native MRSN: the tx carries `value` = amount (no ERC20 approve).
function depositCalldata(amount) {
  return PRECOMPILE_IFACE.encodeFunctionData('depositCollateral', [amount]);
}

// Gasless collateral credit via the unsigned testnet RPC (the same path the
// market-maker uses to seed itself). The node's transaction hashing is not
// standard-Ethereum compatible, so a MetaMask/ethers-signed deposit can't be
// tracked or confirmed by the wallet. On a faucet testnet collateral is free
// anyway, so we credit `owner` server-side instead of prompting a wallet tx.
async function depositCollateralGasless(_owner, _amount) {
  const err = new Error(
    'Unsigned depositCollateral is disabled; sign a depositCollateral tx to 0x…0100'
  );
  err.statusCode = 410;
  err.code = 'SIGNED_DEPOSIT_REQUIRED';
  throw err;
}

function withdrawCalldata(amount) {
  return PRECOMPILE_IFACE.encodeFunctionData('withdrawCollateral', [amount]);
}

// ---------------------------------------------------------------------
// Staking precompile reads (0x…0400) — used for governance voting power
// ---------------------------------------------------------------------

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000400';
const STAKING_IFACE = new ethers.Interface([
  'function getDelegation(address delegator, address validator) view returns (uint256 amount, uint256 pending)',
]);

/**
 * Real on-chain voting power: the address's total MRSN delegated across all
 * validators via the staking precompile, in whole MRSN. Replaces the deprecated
 * DB-simulated staking_balance table, which real delegations never touch.
 */
async function getOnChainVotingPower(address) {
  const validators = await rpcCall('mersennet_staking_getValidators', []);
  if (!Array.isArray(validators) || validators.length === 0) return 0;
  const amounts = await Promise.all(
    validators.map(async (v) => {
      try {
        const data = STAKING_IFACE.encodeFunctionData('getDelegation', [address, v.address]);
        const ret = await rpcCall('eth_call', [{ to: STAKING_PRECOMPILE, data }, 'latest']);
        const [amount] = STAKING_IFACE.decodeFunctionResult('getDelegation', ret);
        return BigInt(amount.toString());
      } catch {
        return 0n;
      }
    }),
  );
  const totalWei = amounts.reduce((s, a) => s + a, 0n);
  return Number(totalWei / 10n ** 18n);
}

/**
 * Live CLOB protocol parameters (`mersennet_orders_getProtocol`), cached 30 s:
 * margin bps, settlement/agent/frame switches, wei per collateral unit.
 */
let protocolCache = { at: 0, value: null };
async function getProtocol() {
  if (protocolCache.value && Date.now() - protocolCache.at < 30_000) return protocolCache.value;
  try {
    const p = await rpcCall('mersennet_orders_getProtocol', []);
    if (p) protocolCache = { at: Date.now(), value: p };
  } catch { /* keep the previous value */ }
  return protocolCache.value;
}

/**
 * Observed seconds per block over the last ~1,800 blocks (one hour), cached
 * 60 s. The nominal slot is 2 s; missed leader slots stretch the average (2.1 s
 * on 18 Sep), which is enough to put a switch ETA off by hours over two days.
 */
let blockTimeCache = { at: 0, value: 2 };
async function observedBlockTime() {
  if (Date.now() - blockTimeCache.at < 60_000) return blockTimeCache.value;
  try {
    const head = await rpcCall('eth_getBlockByNumber', ['latest', false]);
    const h = parseInt(head.number, 16);
    const span = Math.min(1800, h - 1);
    const old = await rpcCall('eth_getBlockByNumber', ['0x' + (h - span).toString(16), false]);
    const dt = parseInt(head.timestamp, 16) - parseInt(old.timestamp, 16);
    if (span > 0 && dt > 0) blockTimeCache = { at: Date.now(), value: Math.min(10, Math.max(1, dt / span)) };
  } catch { /* keep the previous value */ }
  return blockTimeCache.value;
}

/**
 * Upcoming protocol switches with live ETAs: CLOB switches from getProtocol
 * plus the validator-set switches the node exposes. Sorted by height.
 */
async function upcomingSwitches() {
  const [p, vset, secPerBlock] = await Promise.all([
    getProtocol(),
    rpcCall('mersennet_validatorSet', []).catch(() => null),
    observedBlockTime(),
  ]);
  if (!p) return { blockTimeSec: secPerBlock, height: null, switches: [] };
  const height = Number(p.height) || 0;
  const labels = {
    agentDelegationHeight: 'Agent keys for one-click trading',
    priceScaleHeight: '$0.01 ticks on MRSN, SOL and ARB',
    frameCallerHeight: 'Contracts own their CLOB accounts (maker vault deposits)',
    settlementHeight: 'Settlement: 1 unit = 1 MRSN, PnL settles, 10%/5% margin, liquidations',
    benchHeight: 'Benching after 3 missed leader slots',
    jailEscalationHeight: 'Escalating jail',
    rewardsToOperatorHeight: 'Block rewards to the operator wallet',
    revertReasonsHeight: 'Refused orders return their reason',
    feeFloorHeight: '1 gwei base-fee floor and fee split',
    maxValidatorsHeight: 'Up to 50 validators',
  };
  const all = { ...(p.switches || {}) };
  const vp = vset && vset.params;
  if (vp) for (const k of ['benchHeight', 'jailEscalationHeight', 'rewardsToOperatorHeight', 'maxValidatorsHeight']) if (typeof vp[k] === 'number') all[k] = vp[k];
  const now = Date.now();
  const switches = Object.entries(all)
    .filter(([, h]) => typeof h === 'number' && h > height)
    .map(([key, h]) => {
      const blocksLeft = h - height;
      const etaSec = Math.round(blocksLeft * secPerBlock);
      return { key, label: labels[key] || key, height: h, blocksLeft, etaSec, etaAt: new Date(now + etaSec * 1000).toISOString() };
    })
    .sort((a, b) => a.height - b.height);
  return { blockTimeSec: Number(secPerBlock.toFixed(3)), height, switches };
}

/** Chain price (hex/decimal string/number) → human price for `marketId`. */
function toHumanPrice(marketId, raw) {
  if (raw == null) return 0;
  const s = String(raw);
  let n;
  try { n = s.startsWith('0x') ? Number(BigInt(s)) : Number(s); } catch { return 0; }
  if (!Number.isFinite(n)) return 0;
  return n / priceScaleOf(marketId);
}

/** Human price → chain price (BigInt) for `marketId`. */
function toChainPrice(marketId, human) {
  return BigInt(Math.round(Number(human) * priceScaleOf(marketId)));
}

/** Price scale of a market (1 when unknown). */
function priceScaleOf(marketId) {
  const m = MARKETS.find((x) => x.id === Number(marketId));
  return m && m.priceScale ? m.priceScale : 1;
}

/** SQL fragment: divide a chain price by its market's scale (`col` is the market_id column). */
function priceScaleSql(col = 'market_id') {
  const cases = MARKETS.filter((m) => m.priceScale && m.priceScale !== 1)
    .map((m) => `WHEN ${Number(m.id)} THEN ${Number(m.priceScale)}`).join(' ');
  return cases ? `(CASE ${col} ${cases} ELSE 1 END)` : '1';
}

module.exports = {
  MARKETS,
  priceScaleOf,
  priceScaleSql,
  toHumanPrice,
  toChainPrice,
  getProtocol,
  rpcCall,
  ethCall,
  // Decimal helpers (exposed so routes can convert raw -> human consistently)
  USDC_DECIMALS, SIZE_DECIMALS, PRICE_DECIMALS,
  weiPerCollateralUnit, unitsPerMrsn, collateralDecimals, unitsToMrsn, mrsnToUnits,
  maxLeverageFromProtocol, marginEnforced,
  observedBlockTime, upcomingSwitches,
  USDC_UNIT, SIZE_UNIT, PRICE_UNIT,
  rawToUnits,
  // Reads
  getPosition,
  getCollateral,
  getCollateralRaw,
  getFreeCollateral,
  getCollateralAssets,
  getMarginCollateral,
  getMarkPrice,
  markFromBook,
  getOraclePriceForDisplay,
  getOpenInterest,
  getInsuranceFundUsd,
  getPnlPoolUsd,
  getVaultTvlUsd,
  isLiquidatable,
  getMarketConfig,
  getOnChainVotingPower,
  // Order book (on-chain CLOB)
  getOrderBook,
  getOpenOrders,
  submitOrder,
  cancelOrder,
  getBestBidAsk,
  // Chain
  getBalance,
  getBlockNumber,
  // Tx helpers
  depositCalldata,
  withdrawCalldata,
  depositCollateralGasless,
  PRECOMPILE,
};
