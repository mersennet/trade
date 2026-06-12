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
  { href: '/vault', label: 'Vault', tKey: 'nav.vault', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="4" /><path d="M12 8v8M8 12h8" />
    </svg>
  )},
  { href: '/analytics', label: 'Analytics', tKey: 'nav.analytics', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
    </svg>
  )},
  { href: '/copy-trading', label: 'Copy Trade', tKey: 'nav.copyTrading', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5" /><path d="m21 3-9 9" /><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
    </svg>
  )},
  { href: '/ai-agents', label: 'AI Agents', tKey: 'nav.aiAgents', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  )},
  { href: '/whales', label: 'Whales', tKey: 'nav.whales', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
    </svg>
  )},
  { href: '/otc', label: 'OTC', tKey: 'nav.otc', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3h5v5" /><path d="M8 21H3v-5" /><path d="m21 3-9 9" /><path d="m3 21 9-9" />
    </svg>
  )},
  { href: '/leaderboard', label: 'Leaderboard', tKey: 'nav.leaderboard', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5C7 4 6 9 6 9ZM18 9h1.5a2.5 2.5 0 0 0 0-5C17 4 18 9 18 9Z" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  )},
  { href: '/competitions', label: 'Competitions', tKey: 'nav.competitions', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )},
  { href: '/points', label: 'Points', tKey: 'nav.points', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )},
  { href: '/governance', label: 'Governance', tKey: 'nav.governance', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </svg>
  )},
  { href: '/sub-accounts', label: 'Sub-Accts', tKey: 'nav.subAccounts', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  )},
];

const BOTTOM_ITEMS = [
  { href: '/feedback', label: 'Feedback', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )},
  { href: '/referrals', label: 'Referrals', tKey: 'nav.referrals', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" />
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
          <Image src="/logo.png" alt="Mersennet Trade" width={32} height={32} className="shrink-0 drop-shadow-[0_0_10px_rgba(139,92,246,0.35)]" priority />
          <span className="hidden xl:block font-semibold text-foreground tracking-tight text-sm">Mersennet Trade</span>
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
                'flex items-center justify-center xl:justify-start gap-2.5 px-0 xl:px-3 py-2 text-[12px] rounded-lg transition-all duration-200',
                active
                  ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(125,255,155,0.15)] font-medium'
                  : 'text-muted hover:text-foreground hover:bg-surface-2'
              )}
            >
              <span className={cn('w-5 flex items-center justify-center shrink-0', active && 'text-primary')}>{item.icon}</span>
              <span className="hidden xl:block truncate">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border py-1.5 px-1.5 xl:px-2 space-y-0.5">
        {BOTTOM_ITEMS.map((item) => {
          const label = item.tKey ? t(item.tKey, item.label) : item.label;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={label}
              className={cn(
                'flex items-center justify-center xl:justify-start gap-2.5 px-0 xl:px-3 py-2 text-[12px] rounded-lg transition-all duration-200',
                pathname === item.href
                  ? 'text-primary bg-primary/10'
                  : 'text-muted hover:text-foreground hover:bg-surface-2'
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
