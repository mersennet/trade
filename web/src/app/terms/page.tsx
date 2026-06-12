import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Use · Mersennet Trade',
  description: 'Terms of use for Mersennet Trade public beta.',
};

export default function TermsPage() {
  return (
    <div className="flex-1 px-4 sm:px-6 py-8">
      <div className="max-w-3xl mx-auto prose prose-invert prose-sm sm:prose-base">
        <h1 className="text-3xl font-bold text-white">Terms of Use</h1>
        <p className="text-white/60 text-sm">Last updated: 2026-05-06 · Public Beta</p>

        <h2 className="text-white mt-8">1. Eligibility</h2>
        <p className="text-white/75">
          You must be at least 18 years old (or the age of majority in your jurisdiction) and legally
          permitted to use derivatives and decentralized finance protocols where you reside. You may not use
          Mersennet Trade if you are a resident of, or located in, a jurisdiction where this is prohibited.
        </p>

        <h2 className="text-white mt-8">2. Beta status</h2>
        <p className="text-white/75">
          Mersennet Trade is in public beta. Features may change, break, or be removed without notice.
          Read the <Link href="/risk" className="text-primary underline">Risk Disclosure</Link> in full before
          depositing funds.
        </p>

        <h2 className="text-white mt-8">3. Custody</h2>
        <p className="text-white/75">
          Mersennet Trade is non-custodial. The protocol team never holds your private keys. Native MRSN collateral
          you deposit is held by Mersennet&rsquo;s on-chain order-book engine (the <code className="text-amber-300">MersennetOrders</code> CLOB
          precompile at 0x…0100), accessible only via your wallet signature or the on-chain liquidation engine.
        </p>

        <h2 className="text-white mt-8">4. Acceptable use</h2>
        <ul className="text-white/75">
          <li>You will not exploit smart-contract bugs to extract value beyond what the protocol intends.</li>
          <li>You will not perform wash trading, spoofing, layering, or other manipulative behaviour.</li>
          <li>You will not use the platform to launder funds or evade sanctions.</li>
          <li>You will not attempt to disrupt the API or RPC infrastructure.</li>
        </ul>

        <h2 className="text-white mt-8">5. Service availability</h2>
        <p className="text-white/75">
          We make best efforts to keep the front end and API online but provide no uptime SLA
          during beta. If the front end is down, you may still interact with the on-chain order-book engine directly.
        </p>

        <h2 className="text-white mt-8">6. Disclaimer</h2>
        <p className="text-white/75">
          THE SERVICE IS PROVIDED &ldquo;AS-IS&rdquo; AND &ldquo;AS-AVAILABLE&rdquo; WITH ALL FAULTS AND
          WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. THE PROTOCOL DEVELOPERS AND OPERATORS DISCLAIM
          ALL WARRANTIES, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
          AND NON-INFRINGEMENT.
        </p>

        <h2 className="text-white mt-8">7. Limitation of liability</h2>
        <p className="text-white/75">
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL THE PROTOCOL DEVELOPERS, OPERATORS,
          OR CONTRIBUTORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, OR EXEMPLARY
          DAMAGES, INCLUDING LOST PROFITS, ARISING FROM USE OF OR INABILITY TO USE MERSENNET TRADE.
        </p>

        <h2 className="text-white mt-8">8. Modifications</h2>
        <p className="text-white/75">
          These terms may be updated. Material changes will be announced on the front end. Continued use
          after such announcement constitutes acceptance.
        </p>

        <h2 className="text-white mt-8">9. Contact</h2>
        <p className="text-white/75">
          Questions? <a href="mailto:hello@trade.mersennet.com" className="text-primary underline">hello@trade.mersennet.com</a>
        </p>
      </div>
    </div>
  );
}
