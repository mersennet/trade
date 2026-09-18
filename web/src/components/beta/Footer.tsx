'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import ChainStatusChip from './ChainStatusChip';

const FOOTER_LINKS = [
  {
    title: 'Product',
    links: [
      { label: 'Trade', href: '/trade' },
      { label: 'Markets', href: '/markets' },
      { label: 'Maker Vault', href: '/vault' },
      { label: 'Staking & validators', href: '/staking' },
      { label: 'Points', href: '/points' },
    ],
  },
  {
    title: 'Build',
    links: [
      { label: 'API docs', href: '/api' },
      { label: 'Docs', href: 'https://docs.mersennet.com', external: true },
      { label: 'Status', href: 'https://status.mersennet.com', external: true },
      { label: 'Contracts (MersennetOrders precompile)', href: 'https://explorer.mersennet.com/address/0x0000000000000000000000000000000000000100', external: true },
    ],
  },
  {
    // Social links (X / Discord / Telegram) are intentionally absent until the
    // official handles exist and are verified — unowned vanity URLs on a
    // trading product are a phishing vector for squatters.
    title: 'Community',
    links: [
      { label: 'Explorer', href: 'https://explorer.mersennet.com', external: true },
      { label: 'Faucet', href: '/faucet' },
      { label: 'Testnet', href: '/testnet' },
      { label: 'Run a node', href: 'https://docs.mersennet.com/validators/run-a-node/', external: true },
      { label: 'Downloads', href: 'https://mersennet.com/downloads/', external: true },
      { label: 'Feedback', href: '/feedback' },
      { label: 'Telegram chat', href: 'https://t.me/Mersennet', external: true },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Risk disclosure', href: '/risk' },
      { label: 'Terms of use', href: '/terms' },
      { label: 'Privacy policy', href: '/privacy' },
    ],
  },
];

export default function Footer() {
  // The terminal is a fixed-height workspace (chart, book, ticket, positions
  // fill the viewport); a site footer underneath made the page scroll and
  // squeezed the positions panel to ~100px. Every other page keeps it.
  const pathname = usePathname();
  if (pathname === '/trade') return null;
  // mt-auto pushes the footer to the bottom of the flex column when the page
  // content is shorter than the viewport (e.g. /markets with just 5 cards).
  // Without it the footer floats mid-page with a void of empty surface below.
  return (
    <footer className="mt-auto border-t border-border bg-surface/50 px-4 sm:px-6 py-10">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
          {FOOTER_LINKS.map((section) => (
            <div key={section.title}>
              <div className="text-[10px] uppercase tracking-wider text-dim mb-3 font-semibold">
                {section.title}
              </div>
              <ul className="space-y-2">
                {section.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12.5px] text-foreground/65 hover:text-foreground transition-colors"
                      >
                        {link.label} ↗
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-[12.5px] text-foreground/65 hover:text-foreground transition-colors"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-8 pt-6 border-t border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-[12.5px] text-foreground/60">
            <Image src="/logo.png" alt="Mersennet Trade" width={28} height={28} className="shrink-0" />
            <span className="font-semibold text-foreground/80">Mersennet Trade</span>
            <span className="text-dim">· public testnet</span>
          </div>
          <div className="flex items-center gap-3">
            <ChainStatusChip />
          </div>
          <div className="text-[11px] text-dim">
            © {new Date().getFullYear()} Mersennet Trade ·{' '}
            <a
              href="https://explorer.mersennet.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              Powered by Mersennet
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
