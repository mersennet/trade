'use client';
import { useCallback, useRef, useEffect } from 'react';
import { useStore } from '@/stores/useStore';
import { ensureMersennetNetwork, MERSENNET_TESTNET } from '@/lib/chain';

/** Re-attempt the network switch from the WrongNetwork modal's Retry button. */
export async function retryMersennetSwitch(eip: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  return ensureMersennetNetwork(eip);
}
import { getWalletConnectProvider, type WcProvider } from '@/lib/walletconnect';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

/** EIP-1193 surface shared by injected wallets and WalletConnect. */
interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

const WALLET_TYPE_KEY = 'pt_wallet_type'; // 'injected' | 'walletconnect'

export function useWallet() {
  const { wallet, setWallet } = useStore();
  const eipRef = useRef<Eip1193 | null>(null);
  const wcRef = useRef<WcProvider | null>(null);
  const listenerRef = useRef<((accs: unknown) => void) | null>(null);
  const chainListenerRef = useRef<((id: unknown) => void) | null>(null);
  const disconnectListenerRef = useRef<(() => void) | null>(null);

  const removeListeners = useCallback(() => {
    const eip = eipRef.current;
    if (eip) {
      if (listenerRef.current) {
        eip.removeListener('accountsChanged', listenerRef.current);
        listenerRef.current = null;
      }
      if (chainListenerRef.current) {
        eip.removeListener('chainChanged', chainListenerRef.current);
        chainListenerRef.current = null;
      }
      if (disconnectListenerRef.current) {
        eip.removeListener('disconnect', disconnectListenerRef.current);
        disconnectListenerRef.current = null;
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    removeListeners();
    // Kill the WalletConnect session too, otherwise the wallet app keeps
    // showing the dApp as connected and a reload silently re-attaches.
    const wc = wcRef.current;
    if (wc) {
      wc.disconnect().catch(() => {});
      wcRef.current = null;
    }
    eipRef.current = null;
    if (typeof window !== 'undefined') localStorage.removeItem(WALLET_TYPE_KEY);
    setWallet({ address: null, provider: null, signer: null, balance: '0', collateral: '0', collateralNative: '0' });
  }, [setWallet, removeListeners]);

  /**
   * Shared tail of every connect path: verify Mersennet, build the ethers
   * provider/signer, publish wallet state, attach session listeners.
   */
  const finishConnect = useCallback(async (eip: Eip1193, address: string) => {
    // Trading uses the Mersennet CLOB precompile, which only exists on
    // Mersennet. Require the wallet to be on Mersennet — no "other chain".
    try {
      const selected = await ensureMersennetNetwork(eip);
      if (selected !== MERSENNET_TESTNET.chainId) {
        throw new Error('wrong-chain');
      }
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code === 4001 || (e as Error)?.message === 'wrong-chain') {
        throw new Error('Please switch your wallet to the Mersennet network to trade.');
      }
      throw e;
    }

    const { ethers } = await import('ethers');
    const provider = new ethers.BrowserProvider(eip as never);
    const signer = await provider.getSigner(address);
    // Read the balance from the Mersennet RPC directly, NOT the wallet
    // provider: right after a chain add/switch some wallets (Rabby) still
    // briefly serve the previous chain, which made the header show the
    // address's mainnet balance (0) instead of its Mersennet balance.
    const rpc = new ethers.JsonRpcProvider(MERSENNET_TESTNET.rpcUrls[0]);
    const balance = (await rpc.getBalance(address)).toString();

    eipRef.current = eip;
    setWallet({ address, provider, signer, balance });

    removeListeners();
    const handler = async (accs: unknown) => {
      const a = accs as string[];
      if (!a || a.length === 0) { disconnect(); return; }
      const next = a[0];
      // Another account: none of the previous one's numbers may linger, and the
      // signer must be the new account's (the wallet refuses a mismatched sender).
      setWallet({ address: next, balance: '0', collateral: '0', collateralNative: '0', signer: null });
      useStore.setState({ positions: [], orders: [] });
      const [nextSigner, nextBalance] = await Promise.all([
        provider.getSigner(next).catch(() => null),
        rpc.getBalance(next).then((b) => b.toString()).catch(() => '0'),
      ]);
      if (useStore.getState().wallet.address === next) setWallet({ signer: nextSigner, balance: nextBalance });
    };
    listenerRef.current = handler;
    eip.on('accountsChanged', handler);

    // If the wallet leaves Mersennet, the session can no longer trade — drop
    // it so the UI returns to a clean "connect" state instead of failing.
    const chainHandler = (id: unknown) => {
      const raw = typeof id === 'string' ? parseInt(id, 16) : Number(id);
      if (raw !== MERSENNET_TESTNET.chainId) disconnect();
    };
    chainListenerRef.current = chainHandler;
    eip.on('chainChanged', chainHandler);

    // WalletConnect emits 'disconnect' when the user kills the session from
    // the wallet app; injected providers emit it on fatal RPC disconnects.
    const discHandler = () => disconnect();
    disconnectListenerRef.current = discHandler;
    eip.on('disconnect', discHandler);

    return address;
  }, [setWallet, disconnect, removeListeners]);

  /** Connect an injected (MetaMask-style) browser wallet. */
  const connect = useCallback(async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new Error('MetaMask not found');
    }
    const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts[0]) throw new Error('No account');
    try {
      const address = await finishConnect(window.ethereum, accounts[0]);
      localStorage.setItem(WALLET_TYPE_KEY, 'injected');
      useStore.getState().setWrongChain(false);
      return address;
    } catch (e) {
      // Surface the WrongNetwork modal (with manual-add details) instead of a
      // bare toast when the wallet can't switch to Mersennet.
      if ((e as Error)?.message === 'wrong-chain' || /Mersennet network/i.test((e as Error)?.message || '')) {
        useStore.getState().setWrongChain(true);
        return accounts[0];
      }
      throw e;
    }
  }, [finishConnect]);

  /** Connect a mobile/desktop wallet over WalletConnect (Reown QR modal). */
  const connectWalletConnect = useCallback(async () => {
    const wc = await getWalletConnectProvider();
    wcRef.current = wc;
    if (!wc.session) {
      await wc.connect(); // opens the QR modal, resolves on approval
    }
    const accounts = (await wc.request({ method: 'eth_requestAccounts' })) as string[];
    const address = accounts?.[0] || wc.accounts?.[0];
    if (!address) throw new Error('No account approved in the wallet');
    try {
      const out = await finishConnect(wc, address);
      localStorage.setItem(WALLET_TYPE_KEY, 'walletconnect');
      return out;
    } catch (e) {
      // Wrong chain: KEEP the session alive and wait for the user to switch
      // networks inside their wallet (many mobile wallets can't add a custom
      // chain over WC, so tearing down the session just forces a pointless
      // re-scan). The WrongNetwork modal guides the manual add, and the
      // chainChanged listener completes the connection the moment they land
      // on Mersennet.
      if ((e as Error)?.message === 'wrong-chain' || /Mersennet network/i.test((e as Error)?.message || '')) {
        useStore.getState().setWrongChain(true);
        const onChain = async (id: unknown) => {
          const raw = typeof id === 'string' ? parseInt(id, 16) : Number(id);
          if (raw === MERSENNET_TESTNET.chainId) {
            wc.removeListener('chainChanged', onChain);
            try {
              await finishConnect(wc, address);
              localStorage.setItem(WALLET_TYPE_KEY, 'walletconnect');
              useStore.getState().setWrongChain(false);
            } catch { /* still wrong — modal stays up */ }
          }
        };
        wc.on('chainChanged', onChain);
        // Return the address so the UI shows the connected-but-wrong-chain
        // state instead of an error toast.
        return address;
      }
      // Any other failure: drop the session so the next attempt re-pairs.
      wc.disconnect().catch(() => {});
      wcRef.current = null;
      throw e;
    }
  }, [finishConnect]);

  // Email / embedded-wallet login is not implemented yet. The previous version
  // minted a plaintext private key into localStorage and "logged in" an
  // unfunded random address with no signer (so it could never actually trade) —
  // that was unsafe and misleading, so it is disabled until a real embedded
  // wallet / magic-link flow ships. See trade/api auth.js (/auth/magic-link).
  const connectWithEmail = useCallback(async (_email: string) => {
    // Clean up any key minted by the old broken implementation.
    if (typeof window !== 'undefined') localStorage.removeItem('pt_embedded_wallet');
    throw new Error('Email login is coming soon — please connect a browser wallet for now.');
  }, []);

  // Restore a persisted session on page load. WalletConnect sessions are kept
  // alive by the relay; injected wallets are re-attached silently via
  // eth_accounts (no popup) when the wallet still has this site authorized —
  // otherwise a hard refresh would drop a connected wallet on every reload.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || wallet.address) return;
    restoredRef.current = true;
    if (typeof window === 'undefined') return;
    const type = localStorage.getItem(WALLET_TYPE_KEY);
    if (type === 'walletconnect') {
      (async () => {
        try {
          const wc = await getWalletConnectProvider();
          if (!wc.session || !wc.accounts?.[0]) {
            localStorage.removeItem(WALLET_TYPE_KEY);
            return;
          }
          wcRef.current = wc;
          await finishConnect(wc, wc.accounts[0]);
        } catch {
          localStorage.removeItem(WALLET_TYPE_KEY);
        }
      })();
    } else if (type === 'injected' && window.ethereum) {
      (async () => {
        try {
          // eth_accounts is non-interactive: it returns the already-authorized
          // account(s) without prompting, or [] if the user disconnected.
          const accounts = (await window.ethereum!.request({ method: 'eth_accounts' })) as string[];
          if (!accounts?.[0]) {
            localStorage.removeItem(WALLET_TYPE_KEY);
            return;
          }
          await finishConnect(window.ethereum!, accounts[0]);
        } catch {
          localStorage.removeItem(WALLET_TYPE_KEY);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      removeListeners();
    };
  }, [removeListeners]);

  return {
    ...wallet,
    connect,
    connectWalletConnect,
    connectWithEmail,
    disconnect,
    isConnected: !!wallet.address,
  };
}
