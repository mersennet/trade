'use client';
import { useCallback, useRef, useEffect } from 'react';
import { useStore } from '@/stores/useStore';
import { ensureMersennetNetwork, MERSENNET_TESTNET } from '@/lib/chain';
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
    setWallet({ address: null, provider: null, signer: null, balance: '0', collateral: '0' });
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
    const provider = new ethers.providers.Web3Provider(eip as never);
    const signer = provider.getSigner(address);
    const balance = (await provider.getBalance(address)).toString();

    eipRef.current = eip;
    setWallet({ address, provider, signer, balance });

    removeListeners();
    const handler = (accs: unknown) => {
      const a = accs as string[];
      if (!a || a.length === 0) disconnect();
      else setWallet({ address: a[0] });
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
    const address = await finishConnect(window.ethereum, accounts[0]);
    localStorage.setItem(WALLET_TYPE_KEY, 'injected');
    return address;
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
      // A session pinned to the wrong chain is useless here — drop it so the
      // next attempt starts a fresh pairing instead of re-attaching to it.
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
