'use client';
import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { MERSENNET_TESTNET, ensureMersennetNetwork } from '@/lib/chain';
import { useToast } from '@/components/shared/Toast';

/**
 * Mersennet testnet network information. Trading collateral is native MRSN
 * (18 decimals) on chain id 131071 (0x1FFFF). Users can copy network params
 * or add the chain to a browser wallet in one click.
 */

const NET = MERSENNET_TESTNET;

const PARAMS: { label: string; value: string; copy?: string }[] = [
  { label: 'Network name', value: NET.name },
  { label: 'Chain ID', value: `${NET.chainId} (${NET.chainIdHex.toUpperCase().replace('0X', '0x')})`, copy: String(NET.chainId) },
  { label: 'RPC URL', value: NET.rpcUrls[0], copy: NET.rpcUrls[0] },
  // No WebSocket row: the node's WS port is not publicly proxied yet, and
  // publishing a dead endpoint as a copyable network parameter wastes
  // developers' time. Market-data streaming is available via the trade API.
  { label: 'Currency symbol', value: NET.nativeCurrency.symbol },
  { label: 'Decimals', value: String(NET.nativeCurrency.decimals) },
  { label: 'Block explorer', value: NET.blockExplorerUrls[0], copy: NET.blockExplorerUrls[0] },
];

export default function TestnetPage() {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast(`${label} copied`, 'info');
  };

  const addToWallet = async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      toast('No browser wallet found. Install MetaMask to continue.', 'error');
      return;
    }
    setAdding(true);
    try {
      await ensureMersennetNetwork(window.ethereum);
      toast('Mersennet Testnet added to your wallet', 'success');
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code === 4001) toast('Request rejected in wallet', 'error');
      else toast('Could not add network. Try the manual settings below.', 'error');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page-shell">
      <div className="max-w-3xl space-y-8">
      {/* Hero */}
      <div className="text-center py-8">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 mb-4 rounded-full bg-cyan/10 border border-cyan/20 text-[10px] font-medium text-cyan uppercase tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-pulse" />
          Testnet
        </div>
        <h1 className="page-title">{NET.name}</h1>
        <p className="page-sub">
          Mersennet is a zero-knowledge L1 with a native on-chain order book. Trading settles in
          native <span className="text-foreground font-medium">MRSN</span> collateral. Add the
          network to your wallet, then claim test MRSN from the faucet to start trading.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
          <button
            onClick={addToWallet}
            disabled={adding}
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary hover:bg-primary-hover disabled:opacity-60 text-white font-semibold rounded-lg text-sm hover:shadow-[0_0_16px_rgba(43,217,106,0.15)] transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {adding ? 'Adding…' : 'Add Mersennet to wallet'}
          </button>
          <Link
            href="/faucet"
            className="inline-flex items-center gap-2 px-6 py-3 bg-surface-2 hover:bg-surface border border-border hover:border-primary/40 text-foreground font-semibold rounded-lg text-sm transition-all duration-200"
          >
            <svg className="w-4 h-4 text-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            Get testnet MRSN
          </Link>
        </div>
      </div>

      {/* Network parameters */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Network Parameters</h3>
          <span className="text-[10px] text-dim">Click a value to copy</span>
        </div>
        <div className="divide-y divide-border">
          {PARAMS.map((p) => (
            <div key={p.label} className="px-4 py-3 flex items-center justify-between gap-4">
              <span className="text-xs text-dim shrink-0">{p.label}</span>
              {p.copy ? (
                <button
                  onClick={() => copy(p.copy!, p.label)}
                  className="group flex items-center gap-2 text-xs font-mono text-foreground hover:text-primary transition-colors text-right break-all"
                  title="Copy"
                >
                  <span>{p.value}</span>
                  <svg className="w-3.5 h-3.5 text-dim group-hover:text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                  </svg>
                </button>
              ) : (
                <span className="text-xs font-mono text-foreground text-right break-all">{p.value}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Resource links */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <a
          href={NET.blockExplorerUrls[0]}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 hover:border-primary/20 transition-colors duration-200"
        >
          <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center mb-3">
            <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">Block Explorer</h3>
          <p className="text-xs text-dim leading-relaxed">Inspect blocks, transactions, and accounts on Mersennet.</p>
        </a>
        <Link
          href="/faucet"
          className="bg-surface border border-border rounded-xl p-5 hover:border-primary/20 transition-colors duration-200"
        >
          <div className="w-8 h-8 bg-cyan/10 rounded-lg flex items-center justify-center mb-3">
            <svg className="w-4 h-4 text-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H8.25m6.75 0H18a2.25 2.25 0 002.25-2.25V11.25a9 9 0 00-9-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125H15z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">Faucet</h3>
          <p className="text-xs text-dim leading-relaxed">Claim free testnet MRSN to use as trading collateral.</p>
        </Link>
        <a
          href="https://docs.mersennet.com"
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface border border-border rounded-xl p-5 hover:border-primary/20 transition-colors duration-200"
        >
          <div className="w-8 h-8 bg-green/10 rounded-lg flex items-center justify-center mb-3">
            <svg className="w-4 h-4 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">Documentation</h3>
          <p className="text-xs text-dim leading-relaxed">Network details, RPC endpoints, and getting-started guides.</p>
        </a>
      </div>

      {/* Note */}
      <div className={cn('bg-surface border border-border rounded-xl px-5 py-4')}>
        <p className="text-[11px] text-dim leading-relaxed">
          Mersennet is a test network. Tokens hold no monetary value and the network may be reset.
          Native collateral is <span className="text-foreground">MRSN</span> (18 decimals). Test
          USDC is also accepted as margin collateral on-chain (90% weight) via the CLOB
          precompile&apos;s <span className="font-mono">depositTokenCollateral</span> — claim it
          from the faucet.
        </p>
      </div>
      </div>
    </div>
  );
}
