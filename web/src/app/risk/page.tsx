import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Risk Disclosure · Mersennet Trade',
  description: 'Important risk information for traders using Mersennet Trade beta on Mersennet.',
};

export default function RiskPage() {
  return (
    <div className="flex-1 px-4 py-8 md:py-10">
      <div className="max-w-3xl mx-auto prose prose-invert prose-sm sm:prose-base">
        <h1 className="text-3xl font-bold text-white">Risk Disclosure</h1>
        <p className="text-white/60 text-sm">Last updated: 2026-05-06 · Public Beta</p>

        <div className="mt-6 p-4 rounded-lg border border-amber-500/40 bg-amber-500/5 text-amber-100">
          <strong>READ CAREFULLY.</strong> Trading derivatives is risky. You can lose your entire deposit
          rapidly due to leverage, liquidation, or contract bugs. Mersennet Trade is in <strong>public beta</strong>.
        </div>

        <h2 className="text-white mt-8">1. Beta software</h2>
        <p className="text-white/75">
          Mersennet Trade runs on the <strong>Mersennet testnet</strong> and has not undergone a
          third-party security audit. Bugs may exist that result in total loss of deposited funds.
          Do not deposit more than you can afford to lose.
        </p>

        <h2 className="text-white mt-8">2. Protocol risk</h2>
        <p className="text-white/75">
          Order matching, margin, and collateral accounting run inside Mersennet&rsquo;s native order-book
          engine (the CLOB precompile at 0x…0100). Despite best practices, undiscovered vulnerabilities may
          exist in the chain engine or this interface. The network is a testnet and may be reset at any time.
        </p>

        <h2 className="text-white mt-8">3. Market risk</h2>
        <p className="text-white/75">
          Perpetual futures use leverage of up to 10x on every market. Adverse price movements can cause partial or full
          liquidation. Funding payments (positive or negative) may meaningfully affect your PnL over time.
          Markets in beta may have wide bid-ask spreads and shallow depth.
        </p>

        <h2 className="text-white mt-8">4. Price-reference risk</h2>
        <p className="text-white/75">
          Mark prices derive from the on-chain order book mid, with external reference feeds used for display
          and chart seeding. Thin books can produce stale or skewed marks, which may affect liquidation
          timing.
        </p>

        <h2 className="text-white mt-8">5. Infrastructure risk</h2>
        <p className="text-white/75">
          Matching happens atomically on-chain. There is no off-chain sequencer. However, RPC or indexer
          downtime means this interface may not reflect live state or accept new orders, though you can
          always <strong>interact with the Mersennet order-book engine directly over RPC</strong>.
        </p>

        <h2 className="text-white mt-8">6. Counterparty risk</h2>
        <p className="text-white/75">
          PnL is settled from a shared on-chain pool. In extreme scenarios where a liquidation cannot recover
          enough collateral to cover the counterparty&rsquo;s profit, the deficit is absorbed by the
          insurance fund. If the insurance fund is depleted, profitable trades may experience socialized losses.
        </p>

        <h2 className="text-white mt-8">7. Network risk</h2>
        <p className="text-white/75">
          Mersennet Trade is deployed on the Mersennet testnet. Chain reorgs, RPC outages, or fee spikes may temporarily
          affect order placement, settlement, and withdrawals. Mersennet has 6-second finality but is
          not immune to short reorganizations.
        </p>

        <h2 className="text-white mt-8">8. Regulatory risk</h2>
        <p className="text-white/75">
          Crypto derivatives are unregulated or restricted in many jurisdictions. You are responsible for
          ensuring your use of Mersennet Trade complies with applicable laws in your country, state, or region.
          Mersennet Trade does not provide investment, tax, or legal advice.
        </p>

        <h2 className="text-white mt-8">9. No warranty</h2>
        <p className="text-white/75">
          Mersennet Trade is provided <strong>AS-IS</strong> with no warranty of any kind. By using the platform you
          accept all risks. The protocol developers are not liable for any losses arising from use of the
          software, smart contracts, or front end.
        </p>

        <h2 className="text-white mt-8">10. Reporting issues</h2>
        <p className="text-white/75">
          If you discover a security vulnerability, <strong>do not exploit it</strong>. Report to{' '}
          <a href="mailto:security@mersennet.com" className="text-primary underline">
            security@mersennet.com
          </a>
          . Bug bounties may be paid case-by-case during beta.
        </p>

        <p className="mt-12 text-white/55 text-sm">
          By using Mersennet Trade you acknowledge that you have read, understood, and accept all of the above risks.
        </p>
      </div>
    </div>
  );
}
