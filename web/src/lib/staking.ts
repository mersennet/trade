/**
 * Delegated staking on Mersennet.
 *
 * Staking is native to the chain via the staking precompile at 0x…0400.
 * Delegating locks native MRSN to a validator and earns a pro-rata share of
 * that validator's block rewards (minus the validator's commission). There is
 * no off-chain component — every action is a wallet transaction, and reads go
 * through `eth_call` against the precompile's view methods.
 *
 *   delegate(address validator, uint256 amount)
 *   undelegate(address validator, uint256 amount) -> uint256 unlockAtBlock
 *   claimRewards(address validator) -> uint256 paid
 *   withdrawUnbonded() -> uint256 paid
 *   getDelegation(address delegator, address validator) -> (uint256 amount, uint256 pending)
 *   getValidatorStaking(address validator) -> (uint256 delegatedTotal, uint256 commissionBps)
 *   getUnbonding(address delegator) -> (uint256 total, uint256 withdrawable, uint256 nextUnlock)
 */

import { MERSENNET_STAKING_PRECOMPILE, getDefaultChain } from './chain';

const STAKING_ABI = [
  'function delegate(address validator, uint256 amount) returns (bool)',
  'function undelegate(address validator, uint256 amount) returns (uint256 unlockAtBlock)',
  'function claimRewards(address validator) returns (uint256 paid)',
  'function withdrawUnbonded() returns (uint256 paid)',
  'function getDelegation(address delegator, address validator) view returns (uint256 amount, uint256 pending)',
  'function getValidatorStaking(address validator) view returns (uint256 delegatedTotal, uint256 commissionBps)',
  'function getUnbonding(address delegator) view returns (uint256 total, uint256 withdrawable, uint256 nextUnlock)',
];

type EthersLike = typeof import('ethers');

async function ethers(): Promise<EthersLike> {
  const { ethers } = await import('ethers');
  return ethers as EthersLike;
}

function signerFrom(e: EthersLike, signerSource: unknown) {
  if (!signerSource) throw new Error('No signer (connect wallet)');
  const p = signerSource as InstanceType<EthersLike['providers']['Web3Provider']>;
  return p.getSigner();
}

async function sendStaking(
  signerSource: unknown,
  fn: string,
  args: unknown[],
  gasLimit: number,
): Promise<string> {
  const e = await ethers();
  const signer = signerFrom(e, signerSource);
  const iface = new e.utils.Interface(STAKING_ABI);
  const data = iface.encodeFunctionData(fn, args);
  const tx = await signer.sendTransaction({ to: MERSENNET_STAKING_PRECOMPILE, data, gasLimit });
  await tx.wait(1);
  return tx.hash;
}

/** MRSN has 18 decimals; delegation amounts are wei. */
export function mrsnToWei(human: string | number): string {
  const s = String(human).trim();
  if (!s || Number(s) <= 0) throw new Error(`Invalid amount: ${human}`);
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return (BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded || '0')).toString();
}

export function weiToMrsn(wei: string | bigint, decimals = 4): string {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function delegate(signerSource: unknown, validator: string, amountMrsn: string): Promise<string> {
  return sendStaking(signerSource, 'delegate', [validator, mrsnToWei(amountMrsn)], 200_000);
}

export function undelegate(signerSource: unknown, validator: string, amountMrsn: string): Promise<string> {
  return sendStaking(signerSource, 'undelegate', [validator, mrsnToWei(amountMrsn)], 200_000);
}

export function claimRewards(signerSource: unknown, validator: string): Promise<string> {
  return sendStaking(signerSource, 'claimRewards', [validator], 150_000);
}

export function withdrawUnbonded(signerSource: unknown): Promise<string> {
  return sendStaking(signerSource, 'withdrawUnbonded', [], 150_000);
}

export interface DelegationView {
  amount: string; // wei
  pending: string; // wei
}

export interface ValidatorStakingView {
  delegatedTotal: string; // wei
  commissionBps: number;
}

export interface UnbondingView {
  total: string; // wei
  withdrawable: string; // wei
  nextUnlock: number; // block height, 0 if none pending
}

async function callView(fn: string, args: unknown[]): Promise<unknown[]> {
  const e = await ethers();
  const rpc = new e.providers.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
  const iface = new e.utils.Interface(STAKING_ABI);
  const data = iface.encodeFunctionData(fn, args);
  const ret = await rpc.call({ to: MERSENNET_STAKING_PRECOMPILE, data });
  return iface.decodeFunctionResult(fn, ret) as unknown[];
}

export async function getDelegation(delegator: string, validator: string): Promise<DelegationView> {
  const [amount, pending] = await callView('getDelegation', [delegator, validator]);
  return { amount: (amount as bigint).toString(), pending: (pending as bigint).toString() };
}

export async function getValidatorStaking(validator: string): Promise<ValidatorStakingView> {
  const [delegatedTotal, commissionBps] = await callView('getValidatorStaking', [validator]);
  return {
    delegatedTotal: (delegatedTotal as bigint).toString(),
    commissionBps: Number(commissionBps),
  };
}

export async function getUnbonding(delegator: string): Promise<UnbondingView> {
  const [total, withdrawable, nextUnlock] = await callView('getUnbonding', [delegator]);
  return {
    total: (total as bigint).toString(),
    withdrawable: (withdrawable as bigint).toString(),
    nextUnlock: Number(nextUnlock),
  };
}

/** Validators from the node RPC, with their self-stake. */
export async function getValidators(): Promise<{ address: string; stake: string }[]> {
  const rpc = getDefaultChain().rpcUrls[0];
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mersennet_validators', params: [] }),
  });
  const { result } = await res.json();
  return (result || []).map((v: { address: string; stake: string }) => ({
    address: v.address,
    stake: String(v.stake),
  }));
}
