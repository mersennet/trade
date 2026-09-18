'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

// Primary navigation is scoped to the features that are live and backed by
// real on-chain data — Trade, Markets, Portfolio, Vault, Leaderboard,
// Points. Exploratory/roadmap pages (analytics, copy-trading, AI agents,
// whales, OTC, competitions, governance, sub-accounts) still exist as
// routes but are not advertised here: surfacing a dozen empty "coming
// soon" screens made the flagship feel unfinished.
const NAV_ITEMS = [
  { href: '/trade', label: 'Trade', tKey: 'nav.trade', icon: <Icon d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM17.5 14v7M14 17.5h7" /> },
  { href: '/markets', label: 'Markets', tKey: 'nav.markets', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )},
  { href: '/portfolio', label: 'Portfolio', tKey: 'nav.portfolio', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  )},
  { href: '/vault', label: 'Maker Vault', tKey: 'nav.vault', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="4" /><path d="M12 8v8M8 12h8" />
    </svg>
  )},
  { href: '/leaderboard', label: 'Leaderboard', tKey: 'nav.leaderboard', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5C7 4 6 9 6 9ZM18 9h1.5a2.5 2.5 0 0 0 0-5C17 4 18 9 18 9Z" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  )},
  { href: '/points', label: 'Points', tKey: 'nav.points', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )},
  { href: '/staking', label: 'Staking', tKey: 'nav.staking', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" />
    </svg>
  )},
];

const BOTTOM_ITEMS = [
  { href: '/feedback', label: 'Feedback', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )},
  { href: '/api', label: 'API', tKey: 'nav.api', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  )},
];

export default function Sidebar() {
  const pathname = usePathname();
  const { t } = useTranslation();

  return (
    <aside className="hidden md:flex flex-col h-screen bg-surface border-r border-border fixed left-0 top-0 z-40 w-[52px] xl:w-[180px] transition-all duration-200">
      <div className="h-12 border-b border-border flex items-center justify-center xl:justify-start gap-2 px-2 xl:px-3 shrink-0">
        <Link href="/trade" className="flex items-center gap-2 group">
          <Image src="/logo.png" alt="Mersennet Trade" width={30} height={30} className="shrink-0 drop-shadow-[0_0_10px_rgba(43,217,106,0.35)]" priority />
          <span className="hidden xl:block font-extrabold text-primary-bright tracking-[0.08em] text-[12px] crt-glow">MERSENNET</span>
        </Link>
      </div>

      <nav className="flex-1 py-1.5 overflow-y-auto space-y-0.5 px-1.5 xl:px-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          const label = item.tKey ? t(item.tKey, item.label) : item.label;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={label}
              className={cn(
                'flex items-center justify-center xl:justify-start gap-2.5 px-0 xl:px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] transition-all duration-200',
                active
                  ? 'bg-[var(--primary-dim)] text-primary-bright'
                  : 'text-dim hover:text-foreground hover:bg-surface-2'
              )}
            >
              <span className={cn('w-5 flex items-center justify-center shrink-0', active && 'text-primary-bright')}>{item.icon}</span>
              <span className="hidden xl:block truncate">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* pb-7 keeps the last item clear of the fixed 24px status line. */}
      <div className="border-t border-border pt-1.5 pb-7 px-1.5 xl:px-2 space-y-0.5">
        {BOTTOM_ITEMS.map((item) => {
          const label = item.tKey ? t(item.tKey, item.label) : item.label;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={label}
              className={cn(
                'flex items-center justify-center xl:justify-start gap-2.5 px-0 xl:px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] transition-all duration-200',
                pathname === item.href
                  ? 'bg-[var(--primary-dim)] text-primary-bright'
                  : 'text-dim hover:text-foreground hover:bg-surface-2'
              )}
            >
              <span className="w-5 flex items-center justify-center shrink-0">{item.icon}</span>
              <span className="hidden xl:block truncate">{label}</span>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
