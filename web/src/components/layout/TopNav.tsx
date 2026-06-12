'use client';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useLocale, type Locale } from '@/i18n';
import { useStore } from '@/stores/useStore';
import WalletButton from './WalletButton';
import ThemeToggle from './ThemeToggle';
import NotificationCenter from '../shared/NotificationCenter';

const LANGS: { code: Locale; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'es', label: 'ES' },
  { code: 'zh', label: '中文' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
];

const PRIMARY_NAV = [
  { href: '/trade', tKey: 'nav.trade', label: 'Trade' },
  { href: '/markets', tKey: 'nav.markets', label: 'Markets' },
  { href: '/portfolio', tKey: 'nav.portfolio', label: 'Portfolio' },
];

const EARN_NAV = [
  { href: '/vault', tKey: 'nav.vault', label: 'Vault' },
];

const MORE_NAV = [
  { href: '/leaderboard', tKey: 'nav.leaderboard', label: 'Leaderboard' },
  { href: '/analytics', tKey: 'nav.analytics', label: 'Analytics' },
  { href: '/copy-trading', tKey: 'nav.copyTrading', label: 'Copy Trading' },
  { href: '/ai-agents', tKey: 'nav.aiAgents', label: 'AI Agents' },
  { href: '/whales', tKey: 'nav.whales', label: 'Whales' },
  { href: '/otc', tKey: 'nav.otc', label: 'OTC' },
  { href: '/competitions', tKey: 'nav.competitions', label: 'Competitions' },
  { href: '/points', tKey: 'nav.points', label: 'Points' },
  { href: '/governance', tKey: 'nav.governance', label: 'Governance' },
  { href: '/sub-accounts', tKey: 'nav.subAccounts', label: 'Sub-Accounts' },
  { href: '/referrals', tKey: 'nav.referrals', label: 'Referrals' },
  { href: '/funding-arb', tKey: 'nav.fundingArb', label: 'Funding Arb' },
  { href: '/paper-trading', tKey: 'nav.paperTrading', label: 'Paper Trading' },
  { href: '/create-market', tKey: 'nav.createMarket', label: 'List Market' },
  { href: '/api', tKey: 'nav.api', label: 'API' },
];

function Dropdown({ label, items, isActive }: { label: string; items: typeof MORE_NAV; isActive: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const pathname = usePathname();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1 px-2 py-1.5 text-[13px] font-medium transition-colors rounded-md',
          isActive ? 'text-foreground' : 'text-muted hover:text-foreground'
        )}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={cn('transition-transform', open && 'rotate-180')}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-[#0c0c10] border border-border rounded-lg shadow-2xl z-50 py-1.5 min-w-[180px]">
          {items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  'block px-4 py-2 text-[13px] transition-colors',
                  active ? 'text-primary bg-primary/5' : 'text-muted hover:text-foreground hover:bg-surface-2'
                )}
              >
                {t(item.tKey, item.label)}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TopNav() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const paperMode = useStore((s) => s.paperMode);
  const [showLang, setShowLang] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setShowLang(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const earnActive = EARN_NAV.some((i) => pathname === i.href);
  const moreActive = MORE_NAV.some((i) => pathname === i.href);

  return (
    <header className="h-12 bg-[#0a0a0e]/95 backdrop-blur-xl border-b border-border flex items-center justify-between px-3 lg:px-4 sticky top-0 z-40">
      {/* Left: Logo + Nav */}
      <div className="flex items-center gap-0.5 lg:gap-1">
        <Link href="/trade" className="flex items-center gap-2 mr-3 lg:mr-5 shrink-0">
          <Image src="/logo.png" alt="Mersennet Trade" width={28} height={28} className="shrink-0 drop-shadow-[0_0_8px_rgba(139,92,246,0.3)]" priority />
          <span className="hidden lg:block font-semibold text-foreground tracking-tight text-[14px]">Mersennet Trade</span>
        </Link>

        {/* Primary nav - hidden on mobile */}
        <nav className="hidden md:flex items-center gap-0.5">
          {PRIMARY_NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'px-2.5 lg:px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors',
                  active
                    ? 'text-foreground bg-surface-2'
                    : 'text-muted hover:text-foreground'
                )}
              >
                {t(item.tKey, item.label)}
              </Link>
            );
          })}

          <Dropdown label={t('nav.vault', 'Earn')} items={EARN_NAV} isActive={earnActive} />
          <Dropdown label="More" items={MORE_NAV} isActive={moreActive} />
        </nav>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1.5 lg:gap-2">
        {paperMode && (
          <span className="px-2 py-0.5 bg-cyan/10 text-cyan text-[10px] font-bold rounded-md border border-cyan/20 hidden sm:block">PAPER</span>
        )}

        <button
          onClick={() => setShowSettings(true)}
          className="p-1.5 text-dim hover:text-foreground transition-colors rounded-lg hover:bg-surface-2"
          title="Settings"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <div ref={langRef} className="relative hidden sm:block">
          <button onClick={() => setShowLang(!showLang)} className="px-1.5 py-1 text-[10px] text-dim hover:text-foreground bg-surface-2 rounded-md border border-border">
            {LANGS.find(l => l.code === locale)?.label || 'EN'}
          </button>
          {showLang && (
            <div className="absolute right-0 top-full mt-1 bg-[#0c0c10] border border-border rounded-lg shadow-xl z-50 py-1 min-w-[80px]">
              {LANGS.map(l => (
                <button key={l.code} onClick={() => { setLocale(l.code); setShowLang(false); }}
                  className={cn('block w-full text-left px-3 py-1.5 text-xs transition-colors', l.code === locale ? 'text-primary bg-primary/10' : 'text-foreground hover:bg-surface-2')}>
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <NotificationCenter />
        <ThemeToggle />
        <WalletButton />
      </div>
    </header>
  );
}
