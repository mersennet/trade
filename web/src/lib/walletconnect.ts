/**
 * WalletConnect (Reown) integration.
 *
 * Exposes an EIP-1193 provider backed by a WalletConnect v2 session so users
 * can connect mobile/desktop wallets by QR code, in addition to the injected
 * (MetaMask-style) path in useWallet.
 *
 * The project ID is public by design (it identifies the app to Reown's relay,
 * like an analytics key); override via NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
 */
import { MERSENNET_TESTNET } from '@/lib/chain';

export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'd35765aa92aa48a9c4b980f9ee8922a4';

/** Minimal EIP-1193 surface of the WalletConnect provider that we use. */
export interface WcProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  session?: unknown;
  accounts: string[];
  chainId: number;
}

let providerPromise: Promise<WcProvider> | null = null;

/**
 * Lazy singleton. `init` restores any persisted session from localStorage,
 * so a page reload keeps the user connected without re-scanning the QR code.
 */
export function getWalletConnectProvider(): Promise<WcProvider> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      const provider = await EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        // Mersennet is not in wallets' default chain lists, so it must be
        // optional — a required chain the wallet doesn't know would make
        // every wallet reject the session outright.
        optionalChains: [MERSENNET_TESTNET.chainId],
        rpcMap: { [MERSENNET_TESTNET.chainId]: MERSENNET_TESTNET.rpcUrls[0] },
        showQrModal: true,
        metadata: {
          name: 'Mersennet Trade',
          description: 'On-chain CLOB trading on the Mersennet testnet',
          // Must match the actual page origin, or wallets flag the dApp as unverified.
          url: typeof window !== 'undefined' ? window.location.origin : 'https://trade.mersennet.com',
          icons: ['https://mersennet.com/favicon.svg'],
        },
      });
      return provider as unknown as WcProvider;
    })();
    // If init fails (e.g. relay unreachable), allow a retry on next call.
    providerPromise.catch(() => { providerPromise = null; });
  }
  return providerPromise;
}
