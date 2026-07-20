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
 * Units: the chain stores prices and sizes as plain integer units (no
 * decimal scaling) — matching the original MersennetTrade terminal conventions.
 *
 * Two signing modes:
 *   1. Wallet popup (default): pass `provider`.
 *   2. One-click trading: pass `sessionKey` (private key string).
 */

import { MERSENNET_ORDERS_PRECOMPILE, getDefaultChain } from './chain';

export type Tif = 'Gtc' | 'Ioc' | 'Fok';

const TIF_CODE: Record<Tif, number> = { Gtc: 0, Ioc: 1, Fok: 2 };

const PLACE_ORDER_ABI = [
  'function placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif) returns (uint256 orderId, uint256 filled, uint256 remaining)',
  'function cancelOrder(uint256 orderId) returns (bool success)',
];

export interface PlacedOrder {
  txHash: string;
  marketId: number;
  isBuy: boolean;
  price: string;
  size: string;
  tif: Tif;
}

/** Convert a human number string to integer chain units (rounds decimals). */
export function toChainUnits(human: string | number): string {
  const n = Number(String(human).trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${human}`);
  return String(Math.round(n));
}

/**
 * Place an order directly on the on-chain CLOB via a wallet transaction.
 *
 * @param signerSource  ethers Web3Provider, OR ignored when `sessionKey` set
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
    // Optional session key (no-popup signing). When set, signs with this key
    // directly against the chain RPC and ignores `signerSource`.
    sessionKey?: string;
  },
): Promise<PlacedOrder> {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;

  // Pick the signer: session key (no popup) wins over provider.
  let signer: InstanceType<EthersLike['Signer']>;
  if (params.sessionKey) {
    const rpc = new e.providers.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
    signer = new e.Wallet(params.sessionKey, rpc);
  } else {
    if (!signerSource) throw new Error('No signer (connect wallet or enable one-click)');
    const p = signerSource as InstanceType<EthersLike['providers']['Web3Provider']>;
    signer = p.getSigner() as unknown as InstanceType<EthersLike['Signer']>;
  }

  const tif: Tif = params.tif ?? 'Gtc';
  const price = toChainUnits(params.priceUsd);
  const size = toChainUnits(params.sizeBase);
  if (BigInt(size) <= BigInt(0)) throw new Error('Size must be > 0');
  if (BigInt(price) <= BigInt(0)) throw new Error('Price must be > 0');

  const iface = new e.utils.Interface(PLACE_ORDER_ABI);
  const data = iface.encodeFunctionData('placeOrder', [
    params.marketId,
    params.isBuy,
    price,
    size,
    TIF_CODE[tif],
  ]);

  // Explicit gas: the precompile call would otherwise rely on eth_estimateGas,
  // which reverts (and fails the order) when the account has no collateral yet.
  // placeOrder needs ~50k precompile gas + intrinsic; 300k is a safe ceiling.
  const tx = await signer.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 300_000,
  });
  await tx.wait(1);

  return {
    txHash: tx.hash,
    marketId: params.marketId,
    isBuy: params.isBuy,
    price,
    size,
    tif,
  };
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
  const p = signerSource as InstanceType<EthersLike['providers']['Web3Provider']>;
  const signer = p.getSigner();

  const iface = new e.utils.Interface(PLACE_ORDER_ABI);
  const data = iface.encodeFunctionData('cancelOrder', [orderId]);

  const tx = await signer.sendTransaction({
    to: MERSENNET_ORDERS_PRECOMPILE,
    data,
    gasLimit: 200_000,
  });
  await tx.wait(1);
  return tx.hash;
}
