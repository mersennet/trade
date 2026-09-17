/**
 * Chase order engine (client-side keeper).
 *
 * A chase order is a limit order that follows the top of the book on its own
 * side: whenever someone posts a better price, the engine cancels the resting
 * order and re-places it at the new best price, keeping it at the front until
 * it fills (or the chase is stopped / runs out of reprices).
 *
 * Mersennet has no off-chain sequencer, so every reprice is a real on-chain
 * cancel + place. Chasing therefore REQUIRES one-click trading: the agent key
 * signs the reprice transactions silently (the precompile books them to the
 * granting wallet). Without it every tick of the book would open a popup.
 *
 * The engine lives in the browser tab. Closing the tab stops the chase but
 * leaves the last resting order on the book (it is a normal GTC order).
 */

import { MERSENNET_ORDERS_PRECOMPILE, getDefaultChain } from './chain';
import { getPriceScale, priceScaleSync } from './priceScale';

export interface ChaseEvent {
  kind: 'placed' | 'repriced' | 'filled' | 'stopped' | 'error';
  price?: number;
  reprices?: number;
  message?: string;
}

export interface ChaseParams {
  marketId: number;
  isBuy: boolean;
  /** Integer chain units (same convention as placeOrderOnChain). */
  size: string;
  sessionKey: string;
  /** The account the orders belong to (the wallet that granted the agent). */
  owner: string;
  /** Stop chasing after this many reprices (default 50). */
  maxReprices?: number;
  onEvent?: (evt: ChaseEvent) => void;
}

interface ChaseState {
  params: Required<Pick<ChaseParams, 'marketId' | 'isBuy' | 'size' | 'sessionKey' | 'maxReprices'>> & {
    onEvent?: (evt: ChaseEvent) => void;
  };
  owner: string;
  orderId: bigint | null;
  price: bigint;
  reprices: number;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
}

const ABI = [
  'function placeOrderExt(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif, uint8 flags, uint64 expireAtBlock) returns (uint256 orderId, uint256 filled, uint256 remaining)',
  'function cancelOrder(uint256 orderId) returns (bool success)',
];
const FLAG_POST_ONLY = 0x01;
const POLL_MS = 3_000;

const active = new Map<string, ChaseState>();

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(getDefaultChain().rpcUrls[0], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'rpc error');
  return body.result;
}

const toBig = (v: unknown): bigint =>
  typeof v === 'string' ? BigInt(v) : BigInt(Number(v || 0));

/** Best price on each side of the book, 0n when the side is empty. */
async function bestPrices(marketId: number): Promise<{ bid: bigint; ask: bigint }> {
  const book = (await rpc('mersennet_orders_getOrderBook', [marketId])) as {
    bids?: Array<{ price: unknown }>;
    asks?: Array<{ price: unknown }>;
  } | null;
  const bids = (book?.bids || []).map((l) => toBig(l.price)).filter((p) => p > 0n);
  const asks = (book?.asks || []).map((l) => toBig(l.price)).filter((p) => p > 0n);
  return {
    bid: bids.length ? bids.reduce((a, b) => (b > a ? b : a)) : 0n,
    ask: asks.length ? asks.reduce((a, b) => (b < a ? b : a)) : 0n,
  };
}

/**
 * The price a chase order wants right now: join the best level on its own
 * side. With an empty own side, post one tick inside the opposite side so the
 * order still rests instead of crossing.
 */
function targetPrice(isBuy: boolean, bid: bigint, ask: bigint): bigint {
  if (isBuy) {
    if (bid > 0n) return bid;
    if (ask > 1n) return ask - 1n;
  } else {
    if (ask > 0n) return ask;
    if (bid > 0n) return bid + 1n;
  }
  return 0n;
}

async function signerFor(state: ChaseState) {
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
  return new ethers.Wallet(state.params.sessionKey, provider);
}

/** Place a post-only GTC order and resolve the resting order id from RPC. */
async function placeAt(state: ChaseState, price: bigint): Promise<void> {
  const { ethers } = await import('ethers');
  const wallet = await signerFor(state);
  const iface = new ethers.Interface(ABI);
  const data = iface.encodeFunctionData('placeOrderExt', [
    state.params.marketId,
    state.params.isBuy,
    price.toString(),
    state.params.size,
    0, // GTC
    FLAG_POST_ONLY,
    0,
  ]);
  const tx = await wallet.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 300_000,
  });
  await tx.wait(1);

  // The precompile returns the order id in the call output, which a plain
  // transaction receipt does not expose — match it from open orders instead.
  const orders = (await rpc('mersennet_orders_getOpenOrders', [state.owner])) as Array<{
    id: string;
    market_id: string;
    side: string;
    price: string;
  }>;
  const side = state.params.isBuy ? 'buy' : 'sell';
  const mine = orders
    .filter(
      (o) =>
        toBig(o.market_id) === BigInt(state.params.marketId) &&
        o.side === side &&
        toBig(o.price) === price,
    )
    .map((o) => toBig(o.id));
  state.orderId = mine.length ? mine.reduce((a, b) => (b > a ? b : a)) : null;
  state.price = price;
}

async function cancelCurrent(state: ChaseState): Promise<void> {
  if (state.orderId === null) return;
  const { ethers } = await import('ethers');
  const wallet = await signerFor(state);
  const iface = new ethers.Interface(ABI);
  const data = iface.encodeFunctionData('cancelOrder', [state.orderId.toString()]);
  const tx = await wallet.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 200_000,
  });
  await tx.wait(1);
  state.orderId = null;
}

async function tick(id: string): Promise<void> {
  const state = active.get(id);
  if (!state || state.busy) return;
  state.busy = true;
  try {
    // Fill detection: our resting order vanished without us cancelling it.
    if (state.orderId !== null) {
      const orders = (await rpc('mersennet_orders_getOpenOrders', [state.owner])) as Array<{ id: string }>;
      const stillOpen = orders.some((o) => toBig(o.id) === state.orderId);
      if (!stillOpen) {
        stopChase(id, 'filled');
        return;
      }
    }

    const { bid, ask } = await bestPrices(state.params.marketId);
    const want = targetPrice(state.params.isBuy, bid, ask);
    if (want === 0n) return; // empty book — keep the current order

    const better = state.params.isBuy ? want > state.price : want < state.price;
    if (state.orderId !== null && !better) return;

    if (state.reprices >= state.params.maxReprices) {
      stopChase(id, `max reprices (${state.params.maxReprices}) reached`);
      return;
    }

    await cancelCurrent(state);
    await placeAt(state, want);
    state.reprices += 1;
    state.params.onEvent?.({ kind: 'repriced', price: Number(want) / priceScaleSync(state.params.marketId), reprices: state.reprices });
  } catch (err) {
    // Transient RPC hiccups are fine; a failed reprice leaves either the old
    // order (cancel failed) or no order (place failed) — the next tick heals
    // the latter because `better` is always true with price 0.
    if (state.orderId === null) state.price = 0n;
    state.params.onEvent?.({ kind: 'error', message: (err as Error).message });
  } finally {
    state.busy = false;
  }
}

/** Start chasing. Returns the chase id (used to stop it). */
export async function startChase(params: ChaseParams): Promise<string> {
  await getPriceScale(params.marketId); // warm the scale so event prices are human
  const owner = params.owner.toLowerCase();
  const id = `chase-${params.marketId}-${Date.now()}`;
  const state: ChaseState = {
    params: {
      marketId: params.marketId,
      isBuy: params.isBuy,
      size: params.size,
      sessionKey: params.sessionKey,
      maxReprices: params.maxReprices ?? 50,
      onEvent: params.onEvent,
    },
    owner,
    orderId: null,
    price: 0n,
    reprices: 0,
    timer: null,
    busy: true, // hold ticks until the initial placement lands
  };
  active.set(id, state);

  try {
    const { bid, ask } = await bestPrices(params.marketId);
    const want = targetPrice(params.isBuy, bid, ask);
    if (want === 0n) throw new Error('Empty book — nothing to chase. Place a plain limit order instead.');
    await placeAt(state, want);
    state.params.onEvent?.({ kind: 'placed', price: Number(want) / priceScaleSync(state.params.marketId) });
  } catch (err) {
    active.delete(id);
    throw err;
  }

  state.busy = false;
  state.timer = setInterval(() => void tick(id), POLL_MS);
  return id;
}

/** Stop a chase. Leaves the current resting order on the book. */
export function stopChase(id: string, reason = 'stopped'): void {
  const state = active.get(id);
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  active.delete(id);
  state.params.onEvent?.({ kind: reason === 'filled' ? 'filled' : 'stopped', message: reason, reprices: state.reprices });
}

/** Ids of chases currently running in this tab. */
export function activeChases(): string[] {
  return [...active.keys()];
}
