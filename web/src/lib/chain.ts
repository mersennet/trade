/**
 * Mersennet chain configuration & helpers.
 *
 * Mersennet testnet: chainId 131071 (0x1ffff) — zero-knowledge L1 with the
 * native MersennetOrders CLOB precompile at 0x...0100. Standard 0x addresses.
 */

export type ChainId = 131071;

export interface ChainConfig {
  chainId: ChainId;
  chainIdHex: string;
  name: string;
  shortName: string;
  rpcUrls: string[];
  wsUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  isTestnet: boolean;
}

export const MERSENNET_TESTNET: ChainConfig = {
  chainId: 131071,
  chainIdHex: '0x1ffff',
  name: 'Mersennet Testnet',
  shortName: 'MRSN',
  rpcUrls: [process.env.NEXT_PUBLIC_RPC_URL || 'https://rpc.mersennet.com'],
  wsUrls: [process.env.NEXT_PUBLIC_CHAIN_WS_URL || 'wss://rpc.mersennet.com'],
  blockExplorerUrls: ['https://explorer.mersennet.com'],
  nativeCurrency: { name: 'MRSN', symbol: 'MRSN', decimals: 18 },
  isTestnet: true,
};

/** Default chain selection. Mersennet currently runs a single testnet. */
export function getDefaultChain(): ChainConfig {
  return MERSENNET_TESTNET;
}

/* --------------------------------------------------------------------- */
/*  Address format helpers                                                */
/* --------------------------------------------------------------------- */

/** Normalise an address to `0x...` form (no-op on Mersennet). */
export function toEthAddress(addr: string): string {
  return addr;
}

/** Display address with ellipsis. */
export function formatAddress(addr: string, chars = 6): string {
  if (!addr) return '';
  return `${addr.slice(0, chars + 2)}…${addr.slice(-4)}`;
}

/** Explorer tx URL. */
export function explorerTx(hash: string, chain: ChainConfig = getDefaultChain()): string {
  return `${chain.blockExplorerUrls[0]}/tx/${hash}`;
}

/** Explorer address URL. */
export function explorerAddress(addr: string, chain: ChainConfig = getDefaultChain()): string {
  return `${chain.blockExplorerUrls[0]}/address/${addr}`;
}

/* --------------------------------------------------------------------- */
/*  Wallet network management                                             */
/* --------------------------------------------------------------------- */

/**
 * Add the Mersennet network to MetaMask if not already configured, then
 * switch to it. Returns the chainId that was actually selected.
 */
export async function ensureMersennetNetwork(
  ethereum: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> },
  target: ChainConfig = getDefaultChain()
): Promise<number> {
  const addChain = () => ethereum.request({
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: target.chainIdHex,
      chainName: target.name,
      nativeCurrency: target.nativeCurrency,
      rpcUrls: target.rpcUrls,
      blockExplorerUrls: target.blockExplorerUrls,
    }],
  });
  const switchChain = () => ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: target.chainIdHex }],
  });

  try {
    await switchChain();
  } catch (err) {
    const e = err as { code?: number; message?: string };
    // 4001 = user rejected — surface as-is (caller shows the switch prompt).
    if (e.code === 4001) throw err;
    // "Chain not added yet" is signalled inconsistently across wallets:
    //  - MetaMask: code 4902
    //  - Rabby: code -32603 with "Unrecognized chain ID … Try adding the chain"
    //  - others: -32602 / plain messages mentioning "add"/"unrecognized".
    // Any of these means: add the chain, then switch again. We attempt the add
    // regardless (idempotent) and only give up if BOTH add and re-switch fail.
    const looksUnknownChain =
      e.code === 4902 || e.code === -32603 || e.code === -32602 ||
      /unrecognized|add(ing)? (the )?chain|not\s+added|unknown chain/i.test(e.message || '');
    if (!looksUnknownChain) throw err;
    try {
      await addChain();
    } catch (addErr) {
      const ae = addErr as { code?: number };
      if (ae.code === 4001) throw addErr; // user declined the add prompt
      // Some wallets (Rabby included) throw on add even when it succeeds, or
      // add without switching — fall through and re-check the chain below.
    }
    try {
      await switchChain();
    } catch {
      // ignore — the wallet may have switched as part of the add, or may need
      // a manual switch; the chainId read below is the source of truth.
    }
  }
  const chainIdHex = (await ethereum.request({ method: 'eth_chainId' })) as string;
  return parseInt(chainIdHex, 16);
}

/* --------------------------------------------------------------------- */
/*  On-chain integration points                                           */
/* --------------------------------------------------------------------- */

/** The MersennetOrders CLOB precompile — order placement, collateral, positions. */
export const MERSENNET_ORDERS_PRECOMPILE = '0x0000000000000000000000000000000000000100';

/** Delegated staking precompile — delegate/undelegate/claim, staking views. */
export const MERSENNET_STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000400';

export interface DeployedContracts {
  MersennetOrders: string;
}

export function getContracts(): DeployedContracts {
  return {
    MersennetOrders: MERSENNET_ORDERS_PRECOMPILE,
  };
}
