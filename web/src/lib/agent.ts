/**
 * Agent wallets (one-click trading).
 *
 * The CLOB precompile lets an account grant a second key permission to trade
 * for it: `setAgent(agent, expiresAtBlock)`. Transactions signed by the agent
 * place and cancel orders *as the owner* — positions, collateral and history
 * stay on the main wallet — while deposits and withdrawals are never
 * delegated. The terminal keeps the agent key in this browser (per owner,
 * localStorage; it can move nothing out of the account) and uses it to sign
 * orders, brackets and conditional orders without a wallet popup.
 *
 * Setup is two wallet confirmations, once per grant: the grant itself and a
 * small native transfer so the agent can pay gas.
 */
import { MERSENNET_ORDERS_PRECOMPILE, getDefaultChain } from './chain';

export const AGENT_GRANT_BLOCKS = 7 * 24 * 1800; // ~7 days at 2 s blocks
// Gas the owner sends to the agent key. An order costs ~70k gas; at the 1 gwei
// floor that is 0.00007 MRSN, so 0.5 MRSN is roughly 7,000 orders — plenty for
// a week, and small enough to mean something once MRSN has a price (the
// earlier 3 MRSN was sized for the pre-floor era, when it bought ~40,000).
// Leftover gas is never lost: Revoke sweeps it back, re-enabling reuses the key.
export const AGENT_GAS_TOPUP_MRSN = '0.5';
export const AGENT_GAS_LOW_MRSN = 0.05;
/** Gas one order roughly costs; used only to estimate "orders left". */
export const AGENT_GAS_PER_ORDER = 70_000n;

const ABI = [
  'function setAgent(address agent, uint64 expiresAtBlock) returns (bool)',
  'function revokeAgent(address agent) returns (bool)',
  'function agentOf(address agent) view returns (address owner, uint64 expiresAtBlock)',
];

export interface AgentRecord { key: string; address: string; owner: string; createdAt: number; }
export interface AgentStatus {
  active: boolean;              // switch reached on-chain
  agentDelegationHeight: number;
  height: number;
  granted: boolean;             // this browser's key is granted on-chain and not expired
  expiresAtBlock: number | null;
  gasMrsn: number | null;
  /** Orders the current gas balance pays for at the current gas price (null = unknown). */
  ordersLeft: number | null;
}

const storeKey = (owner: string) => `mersennet-trade_agent_${owner.toLowerCase()}`;

export function loadAgent(owner: string): AgentRecord | null {
  try {
    const raw = localStorage.getItem(storeKey(owner));
    if (!raw) return null;
    const r = JSON.parse(raw) as AgentRecord;
    return r && r.key && r.address ? r : null;
  } catch { return null; }
}

export function forgetAgent(owner: string) {
  try { localStorage.removeItem(storeKey(owner)); } catch { /* ignore */ }
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(getDefaultChain().rpcUrls[0], {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'rpc error');
  return body.result as T;
}

/** Switch state + whether this browser's agent for `owner` is granted. */
export async function agentStatus(owner: string): Promise<AgentStatus> {
  const view = await rpc<{ active: boolean; agentDelegationHeight: number; height: number; agents: { agent: string; expiresAtBlock: number; expired: boolean }[] }>('mersennet_orders_getAgents', [owner]);
  const rec = loadAgent(owner);
  const mine = rec ? view.agents.find((a) => a.agent.toLowerCase() === rec.address.toLowerCase()) : undefined;
  let gasMrsn: number | null = null;
  let ordersLeft: number | null = null;
  if (rec) {
    try {
      const [bal, price] = await Promise.all([
        rpc<string>('eth_getBalance', [rec.address, 'latest']),
        rpc<string>('eth_gasPrice', []),
      ]);
      const balWei = BigInt(bal);
      gasMrsn = Number(balWei) / 1e18;
      const perOrder = BigInt(price) * AGENT_GAS_PER_ORDER;
      ordersLeft = perOrder > 0n ? Number(balWei / perOrder) : null;
    } catch { /* leave unknown */ }
  }
  return {
    active: !!view.active,
    agentDelegationHeight: Number(view.agentDelegationHeight || 0),
    height: Number(view.height || 0),
    granted: !!mine && !mine.expired,
    expiresAtBlock: mine ? Number(mine.expiresAtBlock) : null,
    gasMrsn,
    ordersLeft,
  };
}

/**
 * Create (or reuse) the browser's agent key for `owner`, grant it on-chain and
 * fund it with gas. `provider` is the connected wallet's ethers BrowserProvider.
 * Returns the agent record; throws with a readable message on rejection.
 */
export async function enableAgent(provider: unknown, owner: string, onStep?: (s: string) => void): Promise<AgentRecord> {
  const { ethers } = await import('ethers');
  const p = provider as InstanceType<typeof ethers.BrowserProvider>;
  const signer = await p.getSigner();
  let rec = loadAgent(owner);
  if (!rec) {
    const w = ethers.Wallet.createRandom();
    rec = { key: w.privateKey, address: w.address, owner: owner.toLowerCase(), createdAt: Date.now() };
    localStorage.setItem(storeKey(owner), JSON.stringify(rec));
  }
  const status = await agentStatus(owner);
  if (!status.active) {
    throw new Error(`Agent trading activates at block ${status.agentDelegationHeight.toLocaleString()} (now ${status.height.toLocaleString()})`);
  }
  if (!status.granted) {
    onStep?.('Confirm the trading permission in your wallet (1 of 2)');
    const iface = new ethers.Interface(ABI);
    const expires = status.height + AGENT_GRANT_BLOCKS;
    const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data: iface.encodeFunctionData('setAgent', [rec.address, expires]), gasLimit: 120_000 });
    await tx.wait(1);
  }
  if ((status.gasMrsn ?? 0) < AGENT_GAS_LOW_MRSN) {
    onStep?.(`Send ${AGENT_GAS_TOPUP_MRSN} MRSN of gas to the agent (2 of 2)`);
    const tx2 = await signer.sendTransaction({ to: rec.address, value: ethers.parseEther(AGENT_GAS_TOPUP_MRSN) });
    await tx2.wait(1);
  }
  return rec;
}

/** Send more gas to the agent (one wallet confirmation). */
export async function topUpAgentGas(provider: unknown, owner: string, mrsn = AGENT_GAS_TOPUP_MRSN): Promise<void> {
  const { ethers } = await import('ethers');
  const rec = loadAgent(owner);
  if (!rec) throw new Error('No agent key in this browser');
  const signer = await (provider as InstanceType<typeof ethers.BrowserProvider>).getSigner();
  const tx = await signer.sendTransaction({ to: rec.address, value: ethers.parseEther(mrsn) });
  await tx.wait(1);
}

/** Revoke on-chain and forget the key. Leftover gas is returned to the owner first. */
export async function disableAgent(provider: unknown, owner: string): Promise<void> {
  const { ethers } = await import('ethers');
  const rec = loadAgent(owner);
  const p = provider as InstanceType<typeof ethers.BrowserProvider>;
  if (rec) {
    // Sweep the agent's remaining gas back to the owner (best effort).
    try {
      const rpcProvider = new ethers.JsonRpcProvider(getDefaultChain().rpcUrls[0]);
      const agent = new ethers.Wallet(rec.key, rpcProvider);
      const bal = await rpcProvider.getBalance(rec.address);
      const fee = await rpcProvider.getFeeData();
      const gasPrice = fee.gasPrice ?? 1n;
      const cost = gasPrice * 21_000n;
      if (bal > cost * 2n) {
        const tx = await agent.sendTransaction({ to: owner, value: bal - cost * 2n, gasLimit: 21_000, gasPrice });
        await tx.wait(1);
      }
    } catch { /* sweeping is a courtesy */ }
    try {
      const signer = await p.getSigner();
      const iface = new ethers.Interface(ABI);
      const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data: iface.encodeFunctionData('revokeAgent', [rec.address]), gasLimit: 120_000 });
      await tx.wait(1);
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/user (rejected|denied)/i.test(msg)) throw new Error('Revocation cancelled in wallet');
      // Not granted on-chain (e.g. never activated) — nothing to revoke.
    }
  }
  forgetAgent(owner);
}
