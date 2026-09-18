'use client';
import { useEffect } from 'react';
import TokenLogo from '@/components/TokenLogo';
import { useWallet } from '@/hooks/useWallet';
import { faucetUrl } from '@/lib/links';

/**
 * /faucet is a hop, not a page: it sends the visitor to the public faucet
 * with their connected wallet prefilled, so every in-app "claim MRSN" link
 * lands in the same place (the faucet links back to /trade?deposit=1 after a
 * claim). The card below only shows while the redirect is in flight or if
 * the browser blocked it.
 */
export default function FaucetPage() {
  const { address } = useWallet();
  const href = faucetUrl(address);

  useEffect(() => {
    const t = setTimeout(() => { window.location.replace(href); }, 150);
    return () => clearTimeout(t);
  }, [href]);

  return (
    <main className="page-shell min-h-[70vh] flex items-center justify-center">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 sm:p-8 text-center">
        <div className="mx-auto mb-5 inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10">
          <TokenLogo symbol="MRSN" size={36} />
        </div>
        <h1 className="page-title">Opening the faucet…</h1>
        <p className="page-sub">
          Claim 1,001 MRSN (1,000 plus 1 for gas, once an hour), then come back and deposit it as
          collateral from the account panel.
        </p>
        <a
          href={href}
          className="inline-flex items-center justify-center px-5 h-10 premium-gradient text-[11px] font-extrabold uppercase tracking-[0.16em]"
        >
          Continue to faucet.mersennet.com
        </a>
        <p className="text-[11px] text-dim mt-4">Chain ID 131071 · native MRSN · one claim per address per hour</p>
      </div>
    </main>
  );
}
