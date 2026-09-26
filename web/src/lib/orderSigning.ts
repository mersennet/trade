/**
 * Direct on-chain order placement for Mersennet Trade.
 *
 * Mersennet's order book is native to the chain: the MersennetOrders precompile
 * at 0x...0100 matches orders atomically inside the protocol. There is no
 * off-chain sequencer and no EIP-712 relay — placing an order is a regular
 * wallet transaction calling `placeOrder` on the precompile:
 *
 *   placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif)
 *     -> (uint256 orderId, uint256 filled, uint256 remaining)
 *
 * Units: sizes are plain integer units; prices are human × the market's
 * priceScale (1 for integer-priced markets, 100 once a market trades on
 * $0.01 ticks). `placeOrderOnChain` takes HUMAN prices and scales them.
 *
 * Two signing modes:
 *   1. Wallet popup (default): pass `provider`.
 *   2. One-click trading: pass `sessionKey` (private key string).
 */

import { MERSENNET_ORDERS_PRECOMPILE, getDefaultChain } from './chain';
import { getPriceScale, waitOutScaleSwitch } from './priceScale';

export type Tif = 'Gtc' | 'Ioc' | 'Fok';

const TIF_CODE: Record<Tif, number> = { Gtc: 0, Ioc: 1, Fok: 2 };

const PLACE_ORDER_ABI = [
  'function placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif) returns (uint256 orderId, uint256 filled, uint256 remaining)',
  'function placeOrderExt(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif, uint8 flags, uint64 expireAtBlock) returns (uint256 orderId, uint256 filled, uint256 remaining)',
  'function cancelOrder(uint256 orderId) returns (bool success)',
  'function createMarket(bytes32 symbol, uint256 tickSize, uint256 lotSize) returns (uint64 marketId)',
];

/** Post-only flag bit for placeOrderExt's `flags` byte. */
export const FLAG_POST_ONLY = 0x01;

export interface PlacedOrder {
  txHash: string;
  marketId: number;
  isBuy: boolean;
  price: string;
  size: string;
  tif: Tif;
}

/** Maker-order options for placeOrderExt (post-only / good-till-date). */
export interface MakerFlags {
  postOnly?: boolean;
  /** Absolute chain block height at which a resting order auto-cancels. */
  expireAtBlock?: number;
}

/** Convert a human number string to integer chain units (× scale, rounds). */
export function toChainUnits(human: string | number, scale = 1): string {
  const n = Number(String(human).trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${human}`);
  return String(Math.round(n * scale));
}

/**
 * Compute an IOC limit price that actually crosses the *live* order book for a
 * "market" order, bounded by the caller's slippage tolerance.
 *
 * The CLOB uses integer price ticks. Pricing a market order off mark × (1 ±
 * slippage) and rounding to the nearest integer silently fails to cross on
 * markets where one tick is larger than the slippage cushion (e.g. MRSN ≈ 98):
 * the order is accepted, costs gas, and fills nothing. Here we read the current
 * best bid/ask from the chain and price *through* it by at least one tick, in
 * the correct rounding direction (buy → up, sell → down), then widen by the
 * slippage tolerance so a market order sweeps available liquidity.
 */
export async function marketableLimitPrice(
  marketId: number,
  isBuy: boolean,
  slippagePct: number,
  markFallback = 0,
): Promise<string> {
  const rpcUrl = getDefaultChain().rpcUrls[0];
  // Work in chain units (the book is raw), return a HUMAN price.
  const scale = await getPriceScale(marketId);
  const toInt = (v: unknown): number =>
    typeof v === 'string' && v.startsWith('0x') ? parseInt(v, 16) : Number(v);
  markFallback = markFallback * scale;

  let bestBid = 0;
  let bestAsk = 0;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mersennet_orders_getOrderBook', params: [marketId] }),
    });
    const { result } = await res.json();
    const bidPrices = (result?.bids || []).map((b: { price: unknown }) => toInt(b.price)).filter((n: number) => n > 0);
    const askPrices = (result?.asks || []).map((a: { price: unknown }) => toInt(a.price)).filter((n: number) => n > 0);
    bestBid = bidPrices.length ? Math.max(...bidPrices) : 0;
    bestAsk = askPrices.length ? Math.min(...askPrices) : 0;
  } catch {
    // fall through to mark-price fallback below
  }

  const slip = Math.max(0, slippagePct) / 100;
  if (isBuy) {
    const ref = bestAsk || markFallback;
    if (!ref) throw new Error('No ask-side liquidity or mark price — cannot place a market buy right now.');
    // Cross the best ask by at least one tick, then widen by slippage.
    return String(Math.max(Math.ceil(ref * (1 + slip)), Math.ceil(ref) + 1) / scale);
  }
  const ref = bestBid || markFallback;
  if (!ref) throw new Error('No bid-side liquidity or mark price — cannot place a market sell right now.');
  // Cross the best bid by at least one tick (floor to 1), then widen by slippage.
  return String(Math.max(1, Math.min(Math.floor(ref * (1 - slip)), Math.floor(ref) - 1)) / scale);
}

/**
 * Place an order directly on the on-chain CLOB via a wallet transaction.
 *
 * @param signerSource  ethers BrowserProvider, OR ignored when `sessionKey` set
 * @param params        human-readable order params (price, size as decimal strings)
 */
export async function placeOrderOnChain(
  signerSource: unknown,
  params: {
    marketId: number;
    isBuy: boolean;
    priceUsd: string;     // human, e.g. "95000"
    sizeBase: string;     // human, e.g. "2"
    tif?: Tif;
    // Maker flags — when set, the call routes through placeOrderExt.
    maker?: MakerFlags;
    // Optional session key (no-popup signing). When set, signs with this key
    // directly against the chain RPC and ignores `signerSource`.
    sessionKey?: string;
  },
): Promise<PlacedOrder> {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;

  // Pick the signer: session key (no popup) wins over provider.
  let signer: InstanceType<EthersLike['Wallet']> | InstanceType<EthersLike['JsonRpcSigner']>;
  if (params.sessionKey) {
    const rpc = new e.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
    signer = new e.Wallet(params.sessionKey, rpc);
  } else {
    if (!signerSource) throw new Error('No signer (connect wallet or enable one-click)');
    const p = signerSource as InstanceType<EthersLike['BrowserProvider']>;
    signer = await p.getSigner();
  }

  const tif: Tif = params.tif ?? 'Gtc';
  await waitOutScaleSwitch();
  const price = toChainUnits(params.priceUsd, await getPriceScale(params.marketId));
  const size = toChainUnits(params.sizeBase);
  if (BigInt(size) <= BigInt(0)) throw new Error('Size must be > 0');
  if (BigInt(price) <= BigInt(0)) throw new Error('Price must be > 0');

  const iface = new e.Interface(PLACE_ORDER_ABI);
  const usesExt = !!(params.maker && (params.maker.postOnly || params.maker.expireAtBlock));
  const data = usesExt
    ? iface.encodeFunctionData('placeOrderExt', [
        params.marketId,
        params.isBuy,
        price,
        size,
        TIF_CODE[tif],
        params.maker?.postOnly ? FLAG_POST_ONLY : 0,
        params.maker?.expireAtBlock ?? 0,
      ])
    : iface.encodeFunctionData('placeOrder', [
        params.marketId,
        params.isBuy,
        price,
        size,
        TIF_CODE[tif],
      ]);

  // Preflight: run the exact call as eth_call first. A refused order is a
  // reverted transaction that still burns its gas and, on this chain, comes
  // back with no reason (a precompile error returns empty output — a user hit
  // four of those on 25 Sep with nothing to go on). Simulate, and if the book
  // would refuse it, say why in words instead of sending it.
  const from = await signer.getAddress();
  const refusal = await simulateRefusal(from, data, {
    marketId: params.marketId, price: BigInt(price), size: BigInt(size), tif, postOnly: !!params.maker?.postOnly, isBuy: params.isBuy,
  });
  if (refusal) throw new Error(refusal);

  // Explicit gas: the precompile call would otherwise rely on eth_estimateGas,
  // which reverts (and fails the order) when the account has no collateral yet.
  // placeOrder needs ~50k precompile gas + intrinsic; 300k is a safe ceiling.
  const tx = await signer.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 300_000,
  });
  const receipt = await tx.wait(1);
  if (receipt && receipt.status === 0) {
    throw new Error('The order book refused this order after it was sent (the book moved between the check and the block). Nothing was placed; try again.');
  }

  return {
    txHash: tx.hash,
    marketId: params.marketId,
    isBuy: params.isBuy,
    price,
    size,
    tif,
  };
}

/** Raw JSON-RPC against the default chain (no wallet involved). */
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(getDefaultChain().rpcUrls[0], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'rpc error');
  return json.result as T;
}

/**
 * Simulate `data` from `from` against the order-book precompile. Returns null
 * when the order would be accepted, otherwise a sentence explaining the most
 * likely refusal. `placeOrder` answers 96 bytes on success; an empty answer
 * (or a revert) means the book refused it. When the node returns a reason
 * string (Error(string)) it is used verbatim; until then the reason is
 * reconstructed from the account and market state.
 */
async function simulateRefusal(
  from: string,
  data: string,
  order: { marketId: number; price: bigint; size: bigint; tif: Tif; postOnly: boolean; isBuy: boolean },
): Promise<string | null> {
  let out = '';
  try {
    out = await rpc<string>('eth_call', [{ from, to: MERSENNET_ORDERS_PRECOMPILE, data, gas: '0x493e0' }, 'latest']);
  } catch (e) {
    const msg = (e as Error).message || '';
    const reason = /revert(?:ed)?(?::| with reason)?\s*"?([^"]+)"?/i.exec(msg)?.[1];
    if (reason) return `The order book refused this order: ${reason.trim()}.`;
    // RPC hiccup: do not block the order on a failed simulation.
    return null;
  }
  if (out && out !== '0x' && out.length >= 2 + 64) return null; // accepted
  if (typeof out === 'string' && out.startsWith('0x08c379a0')) {
    try {
      const len = parseInt(out.slice(10 + 64, 10 + 128), 16);
      const hex = out.slice(10 + 128, 10 + 128 + len * 2);
      const reason = decodeURIComponent(hex.replace(/(..)/g, '%$1'));
      return `The order book refused this order: ${reason}.`;
    } catch { /* fall through to the reconstruction */ }
  }
  return explainRefusal(from, order);
}

async function explainRefusal(
  from: string,
  order: { marketId: number; price: bigint; size: bigint; tif: Tif; postOnly: boolean; isBuy: boolean },
): Promise<string> {
  try {
    // `from` may be an agent (one-click key): the account that pays margin is
    // its owner — agentOf(address) -> (owner, expiresAtBlock) on the precompile.
    let owner = from;
    try {
      const out = await rpc<string>('eth_call', [{ to: MERSENNET_ORDERS_PRECOMPILE, data: '0xac3c0e30' + from.toLowerCase().replace(/^0x/, '').padStart(64, '0') }, 'latest']);
      const grantOwner = out && out.length >= 66 ? '0x' + out.slice(26, 66) : '';
      if (grantOwner && !/^0x0{40}$/.test(grantOwner)) owner = grantOwner;
    } catch { /* assume the signer is the owner */ }
    const [acct, protocol, markets] = await Promise.all([
      rpc<{ collateral: string }>('mersennet_orders_getAccount', [owner]),
      rpc<{ initialMarginBps?: number; markets?: { id: number; priceScale?: number }[] }>('mersennet_orders_getProtocol', []),
      rpc<{ id: number; symbol?: string; tickSize?: string; lotSize?: string; status?: string; priceScale?: number }[]>('mersennet_orders_getMarkets', []).catch(() => []),
    ]);
    const market = (markets || []).find((m) => Number(m.id) === order.marketId);
    if (market && market.status && /halt|paused|closed/i.test(String(market.status))) {
      return `This market is ${String(market.status).toLowerCase()} — orders are not being accepted right now.`;
    }
    const tick = market?.tickSize ? BigInt(market.tickSize) : 0n;
    const lot = market?.lotSize ? BigInt(market.lotSize) : 0n;
    if (tick > 0n && order.price % tick !== 0n) return 'The price is not on this market\'s tick — round it to the nearest tick and try again.';
    if (lot > 0n && order.size % lot !== 0n) return 'The size is not a multiple of this market\'s lot — round it and try again.';
    const imr = Number(protocol?.initialMarginBps || 0);
    if (imr > 0) {
      const scale = BigInt(market?.priceScale || protocol?.markets?.find((m) => Number(m.id) === order.marketId)?.priceScale || 1);
      const notional = (order.price * order.size) / (scale > 0n ? scale : 1n);
      const required = (notional * BigInt(imr) + 9_999n) / 10_000n;
      const collateral = BigInt(acct?.collateral || '0x0');
      if (collateral < required) {
        return `Not enough collateral: this order needs ${required.toLocaleString()} MRSN of initial margin (${imr / 100}% of ${notional.toLocaleString()} notional) and the account holds ${collateral.toLocaleString()} MRSN. Deposit more or reduce the size.`;
      }
    }
    if (order.postOnly) return 'Post-only: this price would cross the book and take liquidity — move the price or disable Post Only.';
    if (order.tif === 'Fok') return 'Fill-or-kill: the book cannot fill the whole size at this price right now.';
    return 'The order book would refuse this order (no reason available from the node yet). Check the size, price and your collateral, then try again.';
  } catch {
    return 'The order book would refuse this order. Check the size, price and your collateral, then try again.';
  }
}

/**
 * Permissionless market listing. Calls `createMarket` on the CLOB precompile;
 * the chain charges a 100 MRSN listing fee (native balance) and validates the
 * symbol + tick/lot. Returns the new integer market id.
 */
export async function createMarketOnChain(
  signerSource: unknown,
  params: { symbol: string; tickSize: string; lotSize: string },
): Promise<{ txHash: string; marketId: number }> {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;

  if (!signerSource) throw new Error('No signer (connect wallet)');
  const p = signerSource as InstanceType<EthersLike['BrowserProvider']>;
  const signer = await p.getSigner();

  const symbol = params.symbol.trim().toUpperCase();
  if (!symbol || symbol.length > 20) throw new Error('Symbol must be 1–20 characters');
  const tick = toChainUnits(params.tickSize);
  const lot = toChainUnits(params.lotSize);
  if (BigInt(tick) <= 0n || BigInt(lot) <= 0n) throw new Error('Tick and lot must be > 0');

  // bytes32 = right-padded ASCII.
  const symbolBytes32 = e.encodeBytes32String(symbol);
  const iface = new e.Interface(PLACE_ORDER_ABI);
  const data = iface.encodeFunctionData('createMarket', [symbolBytes32, tick, lot]);

  const tx = await signer.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 800_000,
  });
  const receipt = await tx.wait(1);

  // Decode the returned marketId from the call (best-effort via eth_call replay).
  let marketId = 0;
  try {
    const rpc = new e.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
    const ret = await rpc.call({
      to: MERSENNET_ORDERS_PRECOMPILE,
      data,
      from: await signer.getAddress(),
      blockTag: receipt?.blockNumber,
    });
    const [id] = iface.decodeFunctionResult('createMarket', ret);
    marketId = Number(id);
  } catch {
    // Non-fatal: the tx already mined; the markets list refresh will show it.
  }

  return { txHash: tx.hash, marketId };
}

/** Cancel an order directly on-chain via a wallet transaction. */
export async function cancelOrderOnChain(
  signerSource: unknown,
  orderId: number | string,
): Promise<string> {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;

  if (!signerSource) throw new Error('No signer (connect wallet)');
  const p = signerSource as InstanceType<EthersLike['BrowserProvider']>;
  const signer = await p.getSigner();

  const iface = new e.Interface(PLACE_ORDER_ABI);
  const data = iface.encodeFunctionData('cancelOrder', [orderId]);

  const tx = await signer.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 200_000,
  });
  await tx.wait(1);
  return tx.hash;
}
