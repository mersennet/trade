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
  // Open validator set
  'function registerValidator(address identity, uint256 selfStake, uint256 commissionBps, bytes proof) returns (bool)',
  'function addSelfStake(address identity, uint256 amount) returns (bool)',
  'function unregisterValidator(address identity) returns (bool)',
  'function rotateValidatorKey(address identity, address newIdentity, bytes proof) returns (bool)',
];

type EthersLike = typeof import('ethers');

async function ethers(): Promise<EthersLike> {
  const { ethers } = await import('ethers');
  return ethers as EthersLike;
}

function signerFrom(e: EthersLike, signerSource: unknown) {
  if (!signerSource) throw new Error('No signer (connect wallet)');
  const p = signerSource as InstanceType<EthersLike['BrowserProvider']>;
  return p.getSigner();
}

async function sendStaking(
  signerSource: unknown,
  fn: string,
  args: unknown[],
  gasLimit: number,
): Promise<string> {
  const e = await ethers();
  const signer = await signerFrom(e, signerSource);
  const iface = new e.Interface(STAKING_ABI);
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

/** weiToMrsn with thousands separators: 1,000,000 · 65,000 · 1,234.5678. */
export function fmtMrsnWei(wei: string | bigint, decimals = 4): string {
  const [whole, frac] = weiToMrsn(wei, decimals).split('.');
  const w = BigInt(whole).toLocaleString('en-US');
  return frac ? `${w}.${frac}` : w;
}

/**
 * Largest amount a wallet can bond or delegate from `balanceMrsn`, leaving a
 * little for gas (staking calls cost well under 0.01 MRSN). Two decimals so
 * the number reads like a number, never negative.
 */
export function maxSpendable(balanceMrsn: number | null, reserve = 0.01): string {
  if (balanceMrsn == null || !Number.isFinite(balanceMrsn)) return '';
  const v = Math.max(0, Math.floor((balanceMrsn - reserve) * 100) / 100);
  return v > 0 ? String(v) : '0';
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
  const rpc = new e.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
  const iface = new e.Interface(STAKING_ABI);
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

export interface ValidatorFull {
  address: string;
  selfStake: string; // wei (decimal string)
  delegatedTotal: string; // wei (decimal string)
  commissionBps: number;
}

/**
 * Full validator staking info in a single RPC round-trip
 * (`mersennet_staking_getValidators`): self-stake, delegated total, and
 * commission for every validator. Values arrive hex-encoded.
 */
export async function getValidatorsFull(): Promise<ValidatorFull[]> {
  const rpc = getDefaultChain().rpcUrls[0];
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mersennet_staking_getValidators', params: [] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'staking RPC error');
  type Raw = { address: string; selfStake: string; delegatedTotal: string; commissionBps: number };
  return ((body.result || []) as Raw[]).map((v) => {
    // The node reports the consensus weight (self-stake + delegations) under
    // `selfStake`; the registry's real self-stake is that minus the pool. An
    // operator with 40,000 bonded and 5,000 delegated saw "45,000 self-stake"
    // here and 40,000 in the validator set on the same page.
    const weight = BigInt(v.selfStake ?? '0');
    const delegated = BigInt(v.delegatedTotal ?? '0');
    return {
      address: v.address,
      selfStake: (weight > delegated ? weight - delegated : weight).toString(),
      delegatedTotal: delegated.toString(),
      commissionBps: Number(v.commissionBps ?? 0),
    };
  });
}

/**
 * A staking transaction error as one sentence the operator or delegator can
 * act on. ethers wraps a wallet rejection in a 300-character
 * `user rejected action (action="sendTransaction", …)` string; the precompile
 * reverts with short reasons (staking.rs) that need a hint about what to do.
 */
export function stakingErrorMessage(e: unknown): string {
  const raw = (e as Error)?.message || String(e ?? '');
  const code = (e as { code?: unknown })?.code;
  if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)|ethers-user-denied/i.test(raw)) return 'Cancelled in the wallet.';
  if (/insufficient funds|insufficient balance for gas/i.test(raw)) return 'Not enough MRSN in the wallet for the amount plus gas — the faucet gives 1,001 an hour.';
  if (/caller is not this validator'?s operator/i.test(raw)) return 'Only the operator wallet that registered this node can change its stake — switch to that wallet.';
  if (/self-stake below the minimum/i.test(raw)) return 'Self-stake would be below the 1,000 MRSN minimum.';
  if (/already registered/i.test(raw)) return 'This node identity is already registered.';
  if (/registration is not active/i.test(raw)) return 'Validator registration has not opened yet.';
  if (/validator is exiting/i.test(raw)) return 'This validator is leaving the set; no stake changes until it has exited.';
  if (/genesis validators cannot/i.test(raw)) return 'Genesis validators hold a fixed bond.';
  if (/insufficient delegated amount/i.test(raw)) return 'You have less than that delegated to this validator.';
  if (/unknown validator/i.test(raw)) return 'That validator is not registered.';
  if (/amount must be > 0/i.test(raw)) return 'Enter an amount above zero.';
  if (/nonce too low|replacement transaction underpriced/i.test(raw)) return 'The wallet sent a stale nonce — wait a few seconds and try again.';
  if (/execution reverted/i.test(raw)) return 'The chain rejected the transaction (execution reverted).';
  return raw.length > 160 ? raw.slice(0, 160) + '…' : raw || 'Transaction failed';
}

// ─── Open validator set ─────────────────────────────────────────────────────

export interface ValidatorSetParams {
  activationHeight: number; epochBlocks: number; minSelfStake: string; maxValidators: number; unbondingBlocks: number; jailMissBps: number; jailMinSlots: number;
  rewardsToOperatorHeight?: number; jailEscalationHeight?: number; benchHeight?: number;
}
/** The next consensus switch height above `height` (0 when none is scheduled). Nodes must run the current release by then. */
export function nextProtocolSwitch(params: ValidatorSetParams, height: number): number {
  const hs = [params.rewardsToOperatorHeight, params.jailEscalationHeight, params.benchHeight].filter((h): h is number => typeof h === 'number' && h > height);
  return hs.length ? Math.min(...hs) : 0;
}
export interface ValidatorSetEntry {
  identity: string; operator: string; selfStake: string; delegated: string; votingStake: string; commissionBps: number;
  status: 'pending' | 'active' | 'standby' | 'jailed' | 'exiting'; genesis: boolean; registeredAt: number; jailedUntilEpoch: number;
  exiting: boolean; pendingIdentity: string | null; proposedSlots: number; missedSlots: number; totalProposed: number; timesJailed: number; benched?: boolean;
}
export interface ValidatorSetView {
  active: boolean; params: ValidatorSetParams; height: number; epoch: number; nextEpochAt: number;
  activeSet: string[]; consensusValidators: string[]; validators: ValidatorSetEntry[];
}

export async function getValidatorSet(): Promise<ValidatorSetView> {
  const rpc = getDefaultChain().rpcUrls[0];
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mersennet_validatorSet', params: [] }),
  });
  const { result } = await res.json();
  return result as ValidatorSetView;
}

/** Register a node as a validator. `proof` comes from the node (whoami /
 * mersennet_nodeIdentity); `selfStakeMrsn` is escrowed from the caller. */
export function registerValidator(signerSource: unknown, identity: string, selfStakeMrsn: string, commissionBps: number, proof: string): Promise<string> {
  return sendStaking(signerSource, 'registerValidator', [identity, mrsnToWei(selfStakeMrsn), BigInt(commissionBps), proof], 400_000);
}
export function addSelfStake(signerSource: unknown, identity: string, amountMrsn: string): Promise<string> {
  return sendStaking(signerSource, 'addSelfStake', [identity, mrsnToWei(amountMrsn)], 200_000);
}
export function unregisterValidator(signerSource: unknown, identity: string): Promise<string> {
  return sendStaking(signerSource, 'unregisterValidator', [identity], 200_000);
}
export function rotateValidatorKey(signerSource: unknown, identity: string, newIdentity: string, proof: string): Promise<string> {
  return sendStaking(signerSource, 'rotateValidatorKey', [identity, newIdentity, proof], 200_000);
}

