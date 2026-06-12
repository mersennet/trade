/**
 * Collateral deposit / withdraw helpers.
 *
 * On Mersennet, collateral is native MRSN held by the MersennetOrders
 * precompile. The API returns calldata; the WALLET signs and broadcasts:
 *   1. Build the calldata via the API
 *   2. (ERC20 approval is skipped — collateral is native, `approve.token`
 *      comes back empty from the API)
 *   3. Send the deposit / withdraw tx to the precompile
 *   4. Wait for confirmation
 *
 * All amounts are passed as human strings (e.g. "100.5"); the API converts
 * them to integer chain units.
 */

import { api } from './api';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

export interface VaultTxResult {
  approveTx?: string;
  vaultTx: string;
}

/**
 * Deposit native MRSN collateral into the MersennetOrders precompile.
 * Throws on user rejection or chain error; caller should toast the message.
 */
export async function depositToVault(
  // Browser-injected provider (Web3Provider). Typed loosely so the call site
  // doesn't need to import ethers types eagerly.
  provider: unknown,
  owner: string,
  humanAmount: string,
): Promise<VaultTxResult> {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;
  const p = provider as InstanceType<EthersLike['providers']['Web3Provider']>;
  const signer = p.getSigner();

  // 1. Get the calldata + amounts from the API.
  const built = await api.buildDeposit(owner, humanAmount);

  // 2. Approve only when collateral is an ERC20 token. Mersennet uses
  // native MRSN, so the API returns an empty `approve.token` and we skip.
  let approveHash: string | undefined;
  if (built.approve?.token) {
    const need = e.BigNumber.from(built.approve.amount);
    const erc20 = new e.Contract(built.approve.token, ERC20_ABI, signer);
    const allowance = (await erc20.allowance(owner, built.approve.spender)) as InstanceType<
      EthersLike['BigNumber']
    >;
    if (allowance.lt(need)) {
      const approveTx = await erc20.approve(built.approve.spender, need);
      approveHash = approveTx.hash;
      await approveTx.wait(1);
    }
  }

  // 3. Send the deposit tx (already encoded by the API).
  const tx = await signer.sendTransaction({
    to: built.tx.to,
    data: built.tx.data,
    value: e.BigNumber.from(built.tx.value || '0x0'),
  });
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Deposit tx reverted');

  return { approveTx: approveHash, vaultTx: tx.hash };
}

export async function withdrawFromVault(
  provider: unknown,
  owner: string,
  humanAmount: string,
): Promise<VaultTxResult> {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;
  const p = provider as InstanceType<EthersLike['providers']['Web3Provider']>;
  const signer = p.getSigner();

  const built = await api.buildWithdraw(owner, humanAmount);
  const tx = await signer.sendTransaction({
    to: built.tx.to,
    data: built.tx.data,
    value: e.BigNumber.from(built.tx.value || '0x0'),
  });
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Withdraw tx reverted');
  return { vaultTx: tx.hash };
}
