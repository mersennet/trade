/**
 * Collateral deposit / withdraw helpers.
 *
 * Deposits are GASLESS on the faucet testnet: the API credits collateral
 * server-side via the unsigned orders RPC. Wallet-signed deposits aren't used
 * because Mersennet's transaction hashing isn't standard Ethereum, so wallets
 * (MetaMask/ethers) can't track or confirm a signed tx. Amounts are human
 * strings (e.g. "100.5"); the API converts them to integer chain units.
 */

import { api } from './api';

export interface VaultTxResult {
  approveTx?: string;
  vaultTx: string;
}

/**
 * Deposit native MRSN collateral into the MersennetOrders precompile.
 * Throws on user rejection or chain error; caller should toast the message.
 */
export async function depositToVault(
  // Provider is unused now (gasless deposit), kept for call-site compatibility.
  _provider: unknown,
  owner: string,
  humanAmount: string,
): Promise<VaultTxResult> {
  // Gasless deposit: the API credits collateral server-side. We can't use a
  // wallet-signed tx because Mersennet's transaction hashing isn't standard
  // Ethereum, so wallets (MetaMask/ethers) can't track or confirm the deposit.
  // On the faucet testnet collateral is free, so crediting directly is correct.
  const res = await api.creditCollateral(owner, humanAmount);
  if (!res.ok) throw new Error('Deposit failed');
  return { vaultTx: 'gasless' };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function withdrawFromVault(
  _provider: unknown,
  _owner: string,
  _humanAmount: string,
): Promise<VaultTxResult> {
  // Withdrawals are not available on the testnet. Collateral is faucet-funded
  // and credited gaslessly (unbacked), so there is no escrowed native MRSN to
  // pay back, and a wallet-signed withdraw tx can't be tracked anyway. Surface
  // a clear message instead of a cryptic chain error.
  throw new Error('Withdrawals are disabled on the testnet — collateral is faucet-funded');
}
