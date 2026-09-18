/**
 * Collateral deposit / withdraw helpers.
 *
 * Deposits and withdrawals are wallet-signed transactions to the MersennetOrders
 * precompile (0x…0100). The chain credits/debits the *verified signer's*
 * collateral — there is no server-side gasless credit anymore (that trusted an
 * unsigned `owner` and let anyone fund/mutate any account). Standard
 * Ethereum-format signed txs are accepted by the node and tracked by the wallet.
 * The CLOB tracks collateral in plain integer units. One unit is one MRSN from
 * the settlement switch (block 1,605,600) and one wei before it; the live factor
 * comes from `mersennet_orders_getProtocol` (`weiPerCollateralUnit`), so a
 * deposit of "10" always moves 10 MRSN and survives the switch as 10 MRSN.
 */

import { MERSENNET_ORDERS_PRECOMPILE, getDefaultChain } from './chain';
import { api } from './api';

export interface VaultTxResult {
  approveTx?: string;
  vaultTx: string;
}

const PRECOMPILE_ABI = [
  'function depositCollateral(uint256 amount) returns (bool)',
  'function withdrawCollateral(uint256 amount) returns (bool)',
  'function depositTokenCollateral(address token, uint256 amount) returns (bool)',
  'function withdrawTokenCollateral(address token, uint256 amount) returns (bool)',
  'function getTokenCollateral(address account, address token) view returns (uint256)',
];

const WEI_PER_MRSN = 10n ** 18n;

/** Wei per collateral unit right now (1 before the settlement switch, 1e18 after). */
async function weiPerCollateralUnit(): Promise<bigint> {
  try {
    const p = await api.getProtocol();
    const v = BigInt(p?.weiPerCollateralUnit ?? 1);
    return v > 0n ? v : 1n;
  } catch {
    return 1n;
  }
}

/** Human MRSN amount -> integer collateral units for the current era (floor). */
async function toChainAmount(human: string): Promise<bigint> {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) throw new Error('Amount must be positive');
  const [int, frac = ''] = s.split('.');
  const wei = BigInt(int) * WEI_PER_MRSN + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  const units = wei / (await weiPerCollateralUnit());
  if (units <= 0n) throw new Error('Amount is below one collateral unit');
  return units;
}

async function getSigner(provider: unknown) {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;
  if (!provider) throw new Error('Connect your wallet first');
  const p = provider as InstanceType<EthersLike['BrowserProvider']>;
  return { e, signer: await p.getSigner() };
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
  const amount = await toChainAmount(humanAmount);
  const iface = new e.Interface(PRECOMPILE_ABI);
  const data = iface.encodeFunctionData('depositCollateral', [amount]);
  const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data, gasLimit: 200_000 });
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
  const amount = await toChainAmount(humanAmount);
  const iface = new e.Interface(PRECOMPILE_ABI);
  const data = iface.encodeFunctionData('withdrawCollateral', [amount]);
  const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data, gasLimit: 200_000 });
  await tx.wait(1);
  return { vaultTx: tx.hash };
}

/* --------------------------------------------------------------------- */
/*  Multi-collateral (registered ERC-20 tokens, e.g. USDC at 90% weight)   */
/* --------------------------------------------------------------------- */

export interface CollateralAsset {
  /** ERC-20 token address. */
  token: string;
  symbol: string;
  decimals: number;
  /** Margin weight in basis points (9000 = counted at 90% of value). */
  weightBps: number;
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function readProvider() {
  const { ethers } = await import('ethers');
  type EthersLike = typeof import('ethers');
  const e = ethers as EthersLike;
  return { e, rpc: new e.JsonRpcProvider(getDefaultChain().rpcUrls[0]) };
}

/**
 * Registered collateral tokens from `mersennet_orders_getCollateralAssets`,
 * enriched with symbol/decimals from the token contracts. Registration is a
 * chain-level allowlist, so the result is cached for the session.
 */
let _assetsCache: CollateralAsset[] | null = null;
export async function getCollateralAssets(): Promise<CollateralAsset[]> {
  if (_assetsCache) return _assetsCache;
  const { e, rpc } = await readProvider();
  const raw = (await rpc.send('mersennet_orders_getCollateralAssets', [])) as
    { token: string; weightBps: number }[];
  const assets = await Promise.all(
    (raw || []).map(async (a) => {
      const c = new e.Contract(a.token, ERC20_ABI, rpc);
      const [symbol, decimals] = await Promise.all([
        c.symbol().catch(() => 'TOKEN') as Promise<string>,
        c.decimals().catch(() => 18) as Promise<number>,
      ]);
      return { token: a.token, symbol, decimals: Number(decimals), weightBps: Number(a.weightBps) };
    }),
  );
  _assetsCache = assets;
  return assets;
}

/** Wallet ERC-20 balance in human units. */
export async function getTokenWalletBalance(account: string, asset: CollateralAsset): Promise<number> {
  const { e, rpc } = await readProvider();
  const c = new e.Contract(asset.token, ERC20_ABI, rpc);
  const bal = await c.balanceOf(account);
  return Number(e.formatUnits(bal, asset.decimals));
}

/** Deposited token collateral held by the CLOB precompile, in human units. */
export async function getTokenCollateralBalance(account: string, asset: CollateralAsset): Promise<number> {
  const { e, rpc } = await readProvider();
  const c = new e.Contract(MERSENNET_ORDERS_PRECOMPILE, PRECOMPILE_ABI, rpc);
  const amt = await c.getTokenCollateral(account, asset.token);
  return Number(e.formatUnits(amt, asset.decimals));
}

function toTokenUnits(human: string, decimals: number): bigint {
  const n = Number(String(human).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error('Amount must be positive');
  return BigInt(Math.floor(n * 10 ** decimals));
}

/**
 * Deposit a registered ERC-20 (e.g. USDC) as margin collateral. The precompile
 * moves the token balance directly in contract storage — no approve step.
 */
export async function depositTokenToVault(
  provider: unknown,
  asset: CollateralAsset,
  humanAmount: string,
): Promise<VaultTxResult> {
  const { e, signer } = await getSigner(provider);
  const amount = toTokenUnits(humanAmount, asset.decimals);
  const iface = new e.Interface(PRECOMPILE_ABI);
  const data = iface.encodeFunctionData('depositTokenCollateral', [asset.token, amount]);
  const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data, gasLimit: 250_000 });
  await tx.wait(1);
  return { vaultTx: tx.hash };
}

/** Withdraw deposited token collateral back to the signer's wallet. */
export async function withdrawTokenFromVault(
  provider: unknown,
  asset: CollateralAsset,
  humanAmount: string,
): Promise<VaultTxResult> {
  const { e, signer } = await getSigner(provider);
  const amount = toTokenUnits(humanAmount, asset.decimals);
  const iface = new e.Interface(PRECOMPILE_ABI);
  const data = iface.encodeFunctionData('withdrawTokenCollateral', [asset.token, amount]);
  const tx = await signer.sendTransaction({ to: MERSENNET_ORDERS_PRECOMPILE, data, gasLimit: 250_000 });
  await tx.wait(1);
  return { vaultTx: tx.hash };
}
