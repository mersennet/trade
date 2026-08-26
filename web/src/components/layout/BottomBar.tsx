'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';

const ITEMS = [
  {
    href: '/trade',
    label: 'Trade',
    tKey: 'nav.trade',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    href: '/markets',
    label: 'Markets',
    tKey: 'nav.markets',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
      </svg>
    ),
  },
  {
    href: '/portfolio',
    label: 'Portfolio',
    tKey: 'nav.portfolio',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
      </svg>
    ),
  },
  {
    href: '/vault',
    label: 'Earn',
    tKey: 'nav.vault',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M12 2v20M2 12h20" />
      </svg>
    ),
  },
  {
    href: '/more',
    label: 'More',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
      </svg>
    ),
  },
];

// Destinations reachable only through the "More" sheet on mobile. Scoped to
// live features (matching the desktop sidebar) so mobile users aren't shown
// a wall of empty roadmap screens.
const MORE_LINKS = [
  { href: '/staking', label: 'Staking', tKey: 'nav.staking' },
  { href: '/leaderboard', label: 'Leaderboard', tKey: 'nav.leaderboard' },
  { href: '/points', label: 'Points', tKey: 'nav.points' },
  { href: '/api', label: 'API', tKey: 'nav.api' },
  { href: '/feedback', label: 'Feedback' },
];

const MORE_PAGES = MORE_LINKS.map((l) => l.href);

export default function BottomBar() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the sheet on navigation.
  useEffect(() => { setMoreOpen(false); }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  return (
    <>
      {moreOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end"
          onClick={() => setMoreOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More navigation"
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-surface border-t border-border rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+0.5rem)] max-h-[70vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-surface">
              <span className="text-sm font-semibold text-foreground">More</span>
              <button
                onClick={() => setMoreOpen(false)}
                aria-label="Close menu"
                className="text-dim hover:text-foreground p-1 rounded-lg hover:bg-surface-2 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1 p-2">
              {MORE_LINKS.map((l) => {
                const active = pathname === l.href;
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      'px-3 py-2.5 rounded-lg text-sm transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-surface-2'
                    )}
                  >
                    {l.tKey ? t(l.tKey, l.label) : l.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-xl border-t border-border flex items-stretch z-40 safe-bottom">
        {ITEMS.map((item) => {
          const isMore = item.href === '/more';
          const isActive = isMore
            ? moreOpen || MORE_PAGES.includes(pathname)
            : pathname === item.href;
          const label = item.tKey ? t(item.tKey, item.label) : item.label;
          const className = cn(
            'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors',
            isActive ? 'text-primary' : 'text-muted active:text-foreground'
          );

          if (isMore) {
            return (
              <button
                key={item.href}
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                aria-label="More navigation"
                className={className}
              >
                <span className={cn(isActive && 'text-primary')}>{item.icon}</span>
                <span className="text-[9px] font-medium">{label}</span>
              </button>
            );
          }

          return (
            <Link key={item.href} href={item.href} className={className}>
              <span className={cn(isActive && 'text-primary')}>{item.icon}</span>
              <span className="text-[9px] font-medium">{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
