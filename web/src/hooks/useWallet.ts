'use client';
import { useCallback, useRef, useEffect } from 'react';
import { useStore } from '@/stores/useStore';
import { ensureMersennetNetwork, MERSENNET_TESTNET } from '@/lib/chain';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export function useWallet() {
  const { wallet, setWallet } = useStore();
  const listenerRef = useRef<((accs: unknown) => void) | null>(null);

  const chainListenerRef = useRef<((id: unknown) => void) | null>(null);

  const removeAccountListener = useCallback(() => {
    if (window.ethereum) {
      if (listenerRef.current) {
        window.ethereum.removeListener('accountsChanged', listenerRef.current);
        listenerRef.current = null;
      }
      if (chainListenerRef.current) {
        window.ethereum.removeListener('chainChanged', chainListenerRef.current);
        chainListenerRef.current = null;
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    removeAccountListener();
    setWallet({ address: null, provider: null, signer: null, balance: '0', collateral: '0' });
  }, [setWallet, removeAccountListener]);

  const connect = useCallback(async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new Error('MetaMask not found');
    }

    const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts[0]) throw new Error('No account');

    // Trading uses the Mersennet CLOB precompile, which only exists on Mersennet.
    // Require the wallet to be on Mersennet — there is no "use another chain".
    try {
      const selected = await ensureMersennetNetwork(window.ethereum);
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
    const provider = new ethers.providers.Web3Provider(window.ethereum as never);
    const signer = provider.getSigner();
    const address = accounts[0];

    const balance = (await provider.getBalance(address)).toString();

    setWallet({ address, provider, signer, balance });

    removeAccountListener();
    const handler = (accs: unknown) => {
      const a = accs as string[];
      if (a.length === 0) disconnect();
      else setWallet({ address: a[0] });
    };
    listenerRef.current = handler;
    window.ethereum.on('accountsChanged', handler);

    // If the wallet leaves Mersennet, the session can no longer trade — drop it
    // so the UI returns to a clean "connect" state instead of silently failing.
    const chainHandler = (id: unknown) => {
      const hex = typeof id === 'string' ? id : '';
      if (parseInt(hex, 16) !== MERSENNET_TESTNET.chainId) disconnect();
    };
    chainListenerRef.current = chainHandler;
    window.ethereum.on('chainChanged', chainHandler);

    return address;
  }, [setWallet, disconnect, removeAccountListener]);

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

  useEffect(() => {
    return () => {
      removeAccountListener();
    };
  }, [removeAccountListener]);

  return { ...wallet, connect, connectWithEmail, disconnect, isConnected: !!wallet.address };
}
