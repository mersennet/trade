/**
 * MakerVault — pooled market making on the Mersennet CLOB.
 *
 * Depositors send native MRSN to the vault contract and receive mvMRSN shares
 * at the current NAV; the vault holds the pool as collateral on the orders
 * precompile and the market-maker bot quotes for it through agent delegation
 * (orders and positions belong to the vault, the bot can never withdraw).
 * Withdrawals burn shares for MRSN at NAV, paid from the vault's free reserve
 * (10 % of NAV) and, beyond that, from collateral not backing positions.
 */
import { getDefaultChain } from './chain';

export const MAKER_VAULT_ADDRESS = (process.env.NEXT_PUBLIC_VAULT_ADDRESS || '0x2ccc6FB9a1853Ad4C217047CC74Bd0D032325284') as `0x${string}`;

const ABI = [
  'function deposit() payable returns (uint256 shares)',
  'function withdraw(uint256 shares) returns (uint256 amount)',
  'function nav() view returns (uint256)',
  'function sharePrice() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function sharesOf(address) view returns (uint256)',
  'function freeBalance() view returns (uint256)',
  'function collateral() view returns (uint256)',
  'function unrealizedPnl() view returns (int256)',
  'function depositors() view returns (uint256)',
  'function depositCap() view returns (uint256)',
  'function minDeposit() view returns (uint256)',
  'function paused() view returns (bool)',
  'function agent() view returns (address)',
];

export interface VaultOnChain {
  nav: number;            // MRSN
  sharePrice: number;     // MRSN per share
  totalShares: number;
  freeBalance: number;
  collateral: number;
  unrealizedPnl: number;
  depositors: number;
  depositCap: number;     // 0 = unlimited
  minDeposit: number;
  paused: boolean;
  agent: string;
  myShares: number;
  myValue: number;
}

async function contract(readonly = true, provider?: unknown) {
  const { ethers } = await import('ethers');
  if (readonly || !provider) {
    const rpc = new ethers.JsonRpcProvider(getDefaultChain().rpcUrls[0], undefined, { staticNetwork: true });
    return { ethers, c: new ethers.Contract(MAKER_VAULT_ADDRESS, ABI, rpc) };
  }
  const signer = await (provider as InstanceType<typeof ethers.BrowserProvider>).getSigner();
  return { ethers, c: new ethers.Contract(MAKER_VAULT_ADDRESS, ABI, signer) };
}

const f = (v: bigint) => Number(v) / 1e18;

export async function readVault(account?: string | null): Promise<VaultOnChain> {
  const { c } = await contract(true);
  const [nav, sharePrice, totalShares, freeBalance, collateral, pnl, depositors, cap, minDep, paused, agent, mine] = await Promise.all([
    c.nav(), c.sharePrice(), c.totalShares(), c.freeBalance(), c.collateral(), c.unrealizedPnl(), c.depositors(), c.depositCap(), c.minDeposit(), c.paused(), c.agent(),
    account ? c.sharesOf(account) : Promise.resolve(0n),
  ]);
  const myShares = f(mine as bigint);
  return {
    nav: f(nav), sharePrice: f(sharePrice), totalShares: f(totalShares), freeBalance: f(freeBalance), collateral: f(collateral),
    unrealizedPnl: Number(pnl as bigint) / 1e18, depositors: Number(depositors), depositCap: f(cap), minDeposit: f(minDep),
    paused: Boolean(paused), agent: String(agent), myShares, myValue: myShares * f(sharePrice),
  };
}

/** Deposit `humanMrsn` MRSN; returns the tx hash. One wallet confirmation. */
export async function depositToMakerVault(provider: unknown, humanMrsn: string): Promise<string> {
  const { ethers, c } = await contract(false, provider);
  const value = ethers.parseEther(String(humanMrsn).trim());
  const tx = await c.deposit({ value, gasLimit: 450_000 });
  await tx.wait(1);
  return tx.hash as string;
}

/** Burn `shares` (human, 18-dec) for MRSN; returns the tx hash. */
export async function withdrawFromMakerVault(provider: unknown, shares: number): Promise<string> {
  const { ethers, c } = await contract(false, provider);
  const amount = ethers.parseEther(shares.toFixed(18));
  const tx = await c.withdraw(amount, { gasLimit: 400_000 });
  await tx.wait(1);
  return tx.hash as string;
}

/** Turn a contract revert into a sentence a depositor can act on. */
export function vaultErrorMessage(e: unknown): string {
  const raw = (e as Error)?.message || String(e);
  if (/user (rejected|denied)/i.test(raw)) return 'Cancelled in wallet.';
  if (/below minimum/i.test(raw)) return 'Below the minimum deposit (1 MRSN).';
  if (/vault is full/i.test(raw)) return 'The vault is at its deposit cap right now.';
  if (/paused/i.test(raw)) return 'Deposits are paused (withdrawals still work).';
  if (/collateral in use|margin|insufficient/i.test(raw)) return 'That amount is backing open maker positions right now — try a smaller withdrawal or again in a few minutes (the vault keeps 10 % of NAV free).';
  if (/bad shares/i.test(raw)) return 'You do not hold that many shares.';
  return raw.length > 180 ? raw.slice(0, 180) + '…' : raw;
}
