'use client';
import TokenLogo from '@/components/TokenLogo';

/**
 * Mersennet testnet faucet pointer. Trading collateral is native MRSN —
 * claim it from the Mersennet Faucet, then deposit it as collateral from
 * the trade page's account panel.
 */
export default function FaucetPage() {
  return (
    <main className="page-shell min-h-[70vh] flex items-center justify-center">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 sm:p-8 text-center">
        <div className="mx-auto mb-5 inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10">
          <TokenLogo symbol="MRSN" size={36} />
        </div>

        <h1 className="page-title">
          Get testnet MRSN
        </h1>
        <p className="page-sub">
          Mersennet Trade settles in <strong className="text-foreground">native MRSN</strong> on the
          Mersennet testnet. Claim free MRSN from the faucet, then deposit it as trading
          collateral from the account panel.
        </p>

        <div className="grid gap-2 text-left mb-6">
          <a
            href="https://faucet.mersennet.com"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border bg-surface-2 hover:border-primary/40 px-4 py-3 transition"
          >
            <div className="text-[13px] font-semibold text-foreground">Mersennet Faucet</div>
            <div className="text-[11px] text-dim mt-0.5">Claim free testnet MRSN straight to your wallet.</div>
          </a>
          <a
            href="https://docs.mersennet.com"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border bg-surface-2 hover:border-primary/40 px-4 py-3 transition"
          >
            <div className="text-[13px] font-semibold text-foreground">Read the docs</div>
            <div className="text-[11px] text-dim mt-0.5">Network details, RPC endpoints, and getting-started guides.</div>
          </a>
        </div>

        <p className="text-[11px] text-dim">
          Chain ID 131071 · native MRSN · explorer.mersennet.com
        </p>
      </div>
    </main>
  );
}
