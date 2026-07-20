/**
 * Collateral deposit / withdraw helpers.
 *
 * Deposits and withdrawals are wallet-signed transactions to the MersennetOrders
 * precompile (0x…0100). The chain credits/debits the *verified signer's*
 * collateral — there is no server-side gasless credit anymore (that trusted an
 * unsigned `owner` and let anyone fund/mutate any account). Standard
 * Ethereum-format signed txs are accepted by the node and tracked by the wallet.
 * The CLOB tracks collateral, prices and sizes in plain integer units (no
 * decimal scaling), so amounts are floored to integers to match order notionals.
 */

import { MERSENNET_ORDERS_PRECOMPILE } from './chain';

export interface VaultTxResult {
  approveTx?: string;
  vaultTx: string;
}

const PRECOMPILE_ABI = [
  'function depositCollateral(uint256 amount) returns (bool)',
  'function withdrawCollateral(uint256 amount) returns (bool)',
];

/** Human amount -> integer chain units (floor). The CLOB is integer-only. */
function toChainAmount(human: string): bigint {
  const n = Number(String(human).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error('Amount must be positive');
  return BigInt(Math.floor(n));
}

async function getSigner(provider: unknown) {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;
  if (!provider) throw new Error('Connect your wallet first');
  const p = provider as InstanceType<EthersLike['providers']['Web3Provider']>;
  return { e, signer: p.getSigner() };
}

/**
 * Deposit native MRSN collateral into the MersennetOrders precompile. The tx is
 * signed by the wallet; the precompile escrows the amount from the signer's
 * native balance (1:1 backed). Throws on rejection/chain error.
 */
export async function depositToVault(
  provider: unknown,
  _owner: string,
  humanAmount: string,
): Promise<VaultTxResult> {
  const { e, signer } = await getSigner(provider);
  const amount = toChainAmount(humanAmount);
  const iface = new e.utils.Interface(PRECOMPILE_ABI);
  const data = iface.encodeFunctionData('depositCollateral', [amount]);
  const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data });
  await tx.wait(1);
  return { vaultTx: tx.hash };
}

/**
 * Withdraw escrowed MRSN collateral back to the signer's native balance. The
 * precompile validates margin before releasing funds and reverts if the
 * withdrawal would breach maintenance margin.
 */
export async function withdrawFromVault(
  provider: unknown,
  _owner: string,
  humanAmount: string,
): Promise<VaultTxResult> {
  const { e, signer } = await getSigner(provider);
  const amount = toChainAmount(humanAmount);
  const iface = new e.utils.Interface(PRECOMPILE_ABI);
  const data = iface.encodeFunctionData('withdrawCollateral', [amount]);
  const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data });
  await tx.wait(1);
  return { vaultTx: tx.hash };
}
