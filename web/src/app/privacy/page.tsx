import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy · Mersennet Trade',
  description: 'Privacy policy for Mersennet Trade public beta.',
};

export default function PrivacyPage() {
  return (
    <div className="flex-1 px-4 sm:px-6 py-8">
      <div className="max-w-3xl mx-auto prose prose-invert prose-sm sm:prose-base">
        <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
        <p className="text-white/60 text-sm">Last updated: 2026-05-06 · Public Beta</p>

        <h2 className="text-white mt-8">What we collect</h2>
        <ul className="text-white/75">
          <li><strong>On-chain data</strong>: wallet addresses, deposits, trades, positions. This is public on the Mersennet blockchain regardless of Mersennet Trade.</li>
          <li><strong>API request logs</strong>: source IP, user agent, request path, timestamp. Retained 30 days for abuse prevention and capacity planning.</li>
          <li><strong>Local storage</strong>: trading preferences (theme, language, layout), beta-acknowledgement flag. This data never leaves your browser.</li>
        </ul>

        <h2 className="text-white mt-8">What we do NOT collect</h2>
        <ul className="text-white/75">
          <li>Names, emails, phone numbers, or any KYC data.</li>
          <li>Passwords or private keys.</li>
          <li>Persistent user identifiers via cookies (no third-party tracking pixels).</li>
        </ul>

        <h2 className="text-white mt-8">Third parties</h2>
        <p className="text-white/75">
          Mersennet Trade uses the Mersennet RPC endpoint which may log
          requests according to its own privacy policy. The frontend is served from our infrastructure
          at <code className="text-amber-300">trade.mersennet.com</code>; we use Cloudflare for DDoS protection
          and Let&rsquo;s Encrypt for TLS certificates.
        </p>

        <h2 className="text-white mt-8">Cookies</h2>
        <p className="text-white/75">
          We use <strong>no</strong> tracking cookies. We use no first-party or third-party analytics.
          (We may add privacy-respecting analytics like Plausible later. This page will be updated.)
        </p>

        <h2 className="text-white mt-8">Your rights</h2>
        <p className="text-white/75">
          Because we do not collect personally identifiable information, there is generally nothing for us to
          delete on your behalf. On-chain data cannot be deleted by anyone. To clear your local browser state,
          use your browser&rsquo;s site-data controls.
        </p>

        <h2 className="text-white mt-8">Contact</h2>
        <p className="text-white/75">
          Questions or concerns:{' '}
          <a href="mailto:privacy@trade.mersennet.com" className="text-primary underline">privacy@trade.mersennet.com</a>
        </p>
      </div>
    </div>
  );
}
