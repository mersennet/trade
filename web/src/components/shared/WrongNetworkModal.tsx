'use client';
import { useState } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { MERSENNET_TESTNET } from '@/lib/chain';
import { getWalletConnectProvider } from '@/lib/walletconnect';

/**
 * Shown when a wallet connected on the wrong chain and couldn't switch to
 * Mersennet automatically (common for mobile WalletConnect wallets like Trust
 * that can't add a custom chain over WC). Keeps the session alive, gives the
 * exact network details to add manually, and retries on demand — the
 * chainChanged listener in useWallet completes the connection once the wallet
 * lands on Mersennet.
 */
export default function WrongNetworkModal() {
  const wrongChain = useStore((s) => s.wrongChain);
  const setWrongChain = useStore((s) => s.setWrongChain);
  const { disconnect } = useWallet();
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  if (!wrongChain) return null;

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };

  const retry = async () => {
    setRetrying(true);
    try {
      const type = localStorage.getItem('pt_wallet_type');
      const eip = type === 'walletconnect'
        ? await getWalletConnectProvider()
        : window.ethereum;
      if (eip) {
        const { ensureMersennetNetwork } = await import('@/lib/chain');
        const selected = await ensureMersennetNetwork(eip as never);
        if (selected === MERSENNET_TESTNET.chainId) setWrongChain(false);
      }
    } catch { /* wallet still can't switch — modal stays up */ }
    finally { setRetrying(false); }
  };

  const rows: [string, string][] = [
    ['Network name', MERSENNET_TESTNET.name],
    ['Chain ID', String(MERSENNET_TESTNET.chainId)],
    ['RPC URL', MERSENNET_TESTNET.rpcUrls[0]],
    ['Currency symbol', MERSENNET_TESTNET.nativeCurrency.symbol],
    ['Block explorer', MERSENNET_TESTNET.blockExplorerUrls[0]],
  ];

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wrong-network-title"
        className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-2xl overflow-hidden"
      >
        <div className="p-5 border-b border-border flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-yellow/10 border border-yellow/30 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <h2 id="wrong-network-title" className="text-[15px] font-semibold text-foreground">Wrong network</h2>
            <p className="text-[12px] text-dim mt-0.5 leading-relaxed">
              Your wallet connected on a different chain. Trading on Mersennet requires the Mersennet network.
            </p>
          </div>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-[11px] text-dim">
            We asked your wallet to switch, but it couldn&apos;t add the network automatically.
            Add it manually in your wallet&apos;s network settings:
          </p>
          <div className="bg-surface-2 border border-border rounded-lg divide-y divide-border/50">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between px-3 py-2 gap-3">
                <span className="text-[10.5px] text-dim shrink-0">{label}</span>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[11px] font-mono text-foreground truncate">{value}</span>
                  <button
                    onClick={() => copy(label, value)}
                    aria-label={`Copy ${label}`}
                    className="text-[9.5px] text-primary hover:underline shrink-0 font-medium"
                  >{copied === label ? 'Copied' : 'Copy'}</button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10.5px] text-dim leading-relaxed">
            Using Trust Wallet or another wallet without custom-network support?
            Try MetaMask mobile, or a browser wallet on desktop — the connection
            stays open while you switch.
          </p>
        </div>

        <div className="px-5 pb-5 flex gap-2">
          <button
            onClick={() => { setWrongChain(false); disconnect(); }}
            className="flex-1 py-2.5 rounded-lg bg-surface-2 border border-border text-[12px] font-medium text-dim hover:text-foreground transition-colors"
          >Disconnect</button>
          <button
            onClick={retry}
            disabled={retrying}
            className="flex-1 py-2.5 rounded-lg bg-primary text-black text-[12px] font-semibold hover:brightness-110 disabled:opacity-50 transition-all"
          >{retrying ? 'Switching…' : 'Try switching again'}</button>
        </div>
      </div>
    </div>
  );
}
