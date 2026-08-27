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

// Per-market risk/funding parameters the chain doesn't expose. Known listings
// keep their tuned values; permissionlessly created markets get the defaults.
// fundingRate is the per-8h rate as a fraction (0.0001 = 0.01% per interval,
// ~11% APR) — in line with typical perp venues. The old 0.01 (1% per 8h)
// annualized to a nonsensical +1095%.
const MARKET_PARAMS = {
  MRSN: { maxLeverage: 50,  fundingRate: 0.0001 },
  BTC:  { maxLeverage: 100, fundingRate: 0.00008 },
  ETH:  { maxLeverage: 50,  fundingRate: 0.00012 },
  SOL:  { maxLeverage: 20,  fundingRate: 0.0001 },
  ARB:  { maxLeverage: 20,  fundingRate: 0.00015 },
};
const DEFAULT_PARAMS = { maxLeverage: 10, fundingRate: 0.0001 };

// USD-quoted perps, MRSN-collateralized. There is no USDC on the perp side —
// the quote is the oracle's USD price (spot pairs against MockUSDC live in
// spotEngine). This array is the seed / RPC-outage fallback; refreshMarkets()
// below syncs it IN PLACE with the live on-chain list (markets are created
// permissionlessly via createMarket, so new listings must appear without a
// redeploy — every consumer iterates chain.MARKETS at call time).
const MARKETS = [
  { id: 1, symbol: 'MRSN/USD', base: 'MRSN', quote: 'USD', maxLeverage: 50,  fundingRate: 0.0001 },
  { id: 2, symbol: 'BTC/USD',  base: 'BTC',  quote: 'USD', maxLeverage: 100, fundingRate: 0.00008 },
  { id: 3, symbol: 'ETH/USD',  base: 'ETH',  quote: 'USD', maxLeverage: 50,  fundingRate: 0.00012 },
  { id: 4, symbol: 'SOL/USD',  base: 'SOL',  quote: 'USD', maxLeverage: 20,  fundingRate: 0.0001 },
  { id: 5, symbol: 'ARB/USD',  base: 'ARB',  quote: 'USD', maxLeverage: 20,  fundingRate: 0.00015 },
];

/**
 * Sync MARKETS with `mersennet_orders_getMarkets`. Chain symbols are bare
 * ("MRSN"); the UI convention is BASE/USD. Hex tick/lot sizes are decoded to
 * plain integers (chain units). On RPC failure the previous list is kept.
 */
async function refreshMarkets() {
  try {
    const live = await rpcCall('mersennet_orders_getMarkets', []);
    if (!Array.isArray(live) || live.length === 0) return;
    const toInt = (v) => {
      try { return Number(BigInt(v ?? '0x1')); } catch { return 1; }
    };
    const mapped = live
      .filter((m) => (m.status ?? 'active') === 'active')
      .map((m) => {
        const base = String(m.symbol || `MKT${m.id}`).toUpperCase();
        const params = MARKET_PARAMS[base] || DEFAULT_PARAMS;
        return {
          id: Number(m.id),
          symbol: `${base}/USD`,
          base,
          quote: 'USD',
          maxLeverage: params.maxLeverage,
          fundingRate: params.fundingRate,
          tickSize: toInt(m.tickSize),
          lotSize: toInt(m.lotSize),
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
const _marketsTimer = setInterval(refreshMarkets, 30_000);
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

const PRECOMPILE_IFACE = new ethers.utils.Interface([
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

async function getPosition(marketId, address) {
  try {
    const data = PRECOMPILE_IFACE.encodeFunctionData('getPosition', [marketId]);
    const r = await ethCall(data, address);
    const [size, entryPrice] = PRECOMPILE_IFACE.decodeFunctionResult('getPosition', r);
    const sizeRaw = size.toString();
    const entryPriceRaw = entryPrice.toString();
    const notionalRaw = (BigInt(sizeRaw) < 0n ? -BigInt(sizeRaw) : BigInt(sizeRaw)) * BigInt(entryPriceRaw) / SIZE_UNIT;
    return {
      sizeRaw,                                                // raw 1e18 (signed)
      size: rawToUnits(sizeRaw, SIZE_DECIMALS),               // human base units
      entryPriceRaw,                                          // raw 1e18
      entryPrice: rawToUnits(entryPriceRaw, PRICE_DECIMALS),  // human quote
      entryNotionalRaw: notionalRaw.toString(),
      entryNotional: rawToUnits(notionalRaw.toString(), USDC_DECIMALS),
      reservedMargin: 0,        // margin reservation is internal to the precompile
      reservedMarginRaw: '0',
    };
  } catch {
    return { sizeRaw: '0', size: 0, entryPriceRaw: '0', entryPrice: 0, entryNotionalRaw: '0', entryNotional: 0, reservedMargin: 0, reservedMarginRaw: '0' };
  }
}

async function getCollateralRaw(address) {
  try {
    const data = PRECOMPILE_IFACE.encodeFunctionData('getCollateral', []);
    const r = await ethCall(data, address);
    const [collateral] = PRECOMPILE_IFACE.decodeFunctionResult('getCollateral', r);
    return collateral.toString();
  } catch {
    return '0';
  }
}

async function getCollateral(address) {
  return rawToUnits(await getCollateralRaw(address), USDC_DECIMALS);
}

// The precompile tracks a single collateral balance; margin reservation is
// internal. Free collateral therefore equals the total balance for display.
async function getFreeCollateral(address) {
  return getCollateral(address);
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

/** Mark price = order book mid, raw 1e18 string. Falls back to best side or '0'. */
async function getMarkPrice(marketId) {
  const { bestBid, bestAsk } = await getBestBidAsk(marketId);
  const bid = BigInt(bestBid);
  const ask = BigInt(bestAsk);
  if (bid > 0n && ask > 0n) return ((bid + ask) / 2n).toString();
  if (bid > 0n) return bid.toString();
  if (ask > 0n) return ask.toString();
  return '0';
}

/** Display-only price with age. Mersennet matches on-chain, so mid is never stale. */
async function getOraclePriceForDisplay(marketId) {
  const price = await getMarkPrice(marketId);
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

async function getBlockNumber() {
  const r = await rpcCall('eth_blockNumber');
  return Number(BigInt(r));
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
const STAKING_IFACE = new ethers.utils.Interface([
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

module.exports = {
  MARKETS,
  rpcCall,
  ethCall,
  // Decimal helpers (exposed so routes can convert raw -> human consistently)
  USDC_DECIMALS, SIZE_DECIMALS, PRICE_DECIMALS,
  USDC_UNIT, SIZE_UNIT, PRICE_UNIT,
  rawToUnits,
  // Reads
  getPosition,
  getCollateral,
  getCollateralRaw,
  getFreeCollateral,
  getMarkPrice,
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
