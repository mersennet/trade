'use client';
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import WalletButton from './WalletButton';
import ThemeToggle from './ThemeToggle';
import NotificationCenter from '../shared/NotificationCenter';
import { useStore } from '@/stores/useStore';
import { useLocale, useTranslation, type Locale } from '@/i18n';

const LANGS: { code: Locale; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'es', label: 'ES' },
  { code: 'zh', label: '中文' },
  { code: 'ko', label: '한국어' },
  { code: 'ja', label: '日本語' },
];

const PAGE_TITLE_KEYS: Record<string, { key: string; fallback: string }> = {
  '/trade': { key: 'nav.trade', fallback: 'Trade' },
  '/markets': { key: 'nav.markets', fallback: 'Markets' },
  '/portfolio': { key: 'nav.portfolio', fallback: 'Portfolio' },
  '/vault': { key: 'nav.vault', fallback: 'Mersennet Vault' },
  '/leaderboard': { key: 'nav.leaderboard', fallback: 'Leaderboard' },
  '/analytics': { key: 'nav.analytics', fallback: 'Analytics' },
  '/points': { key: 'nav.points', fallback: 'Points' },
  '/competitions': { key: 'nav.competitions', fallback: 'Competitions' },
  '/governance': { key: 'nav.governance', fallback: 'Governance' },
  '/copy-trading': { key: 'nav.copyTrading', fallback: 'Copy Trading' },
  '/sub-accounts': { key: 'nav.subAccounts', fallback: 'Sub-Accounts' },
  '/referrals': { key: 'nav.referrals', fallback: 'Referrals' },
  '/api': { key: 'nav.api', fallback: 'API' },
  '/spot': { key: 'nav.spot', fallback: 'Spot' },
  '/options': { key: 'nav.options', fallback: 'Options' },
  '/whales': { key: 'nav.whales', fallback: 'Whales' },
  '/ai-agents': { key: 'nav.aiAgents', fallback: 'AI Agents' },
  '/otc': { key: 'nav.otc', fallback: 'OTC' },
  '/create-market': { key: 'nav.createMarket', fallback: 'List Market' },
  '/paper-trading': { key: 'nav.paperTrading', fallback: 'Paper Trading' },
  '/funding-arb': { key: 'nav.fundingArb', fallback: 'Funding Arb' },
  '/testnet': { key: 'nav.testnet', fallback: 'Testnet' },
};

export default function Header() {
  const pathname = usePathname();
  const { t } = useTranslation();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const entry = PAGE_TITLE_KEYS[pathname];
  const title = entry ? t(entry.key, entry.fallback) : 'Mersennet Trade';
  const setShowSettings = useStore((s) => s.setShowSettings);
  const paperMode = useStore((s) => s.paperMode);
  const [showLang, setShowLang] = useState(false);

  return (
    <header className="h-11 md:h-12 bg-surface/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-3 md:px-4 sticky top-0 z-30">
      <div className="flex items-center gap-2">
        <Link href="/trade" className="md:hidden flex items-center">
          <Image src="/logo.png" alt="Mersennet Trade" width={28} height={28} className="shrink-0" priority />
        </Link>
        <h1 className="text-xs md:text-sm font-medium text-foreground tracking-tight">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5 md:gap-2">
        <button
          onClick={() => setShowSettings(true)}
          className="p-1.5 md:p-2 text-dim hover:text-foreground transition-colors rounded-lg hover:bg-surface-2"
          title="Settings"
          aria-label="Open settings"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {paperMode && (
          <span className="px-2 py-0.5 bg-cyan/10 text-cyan text-[10px] font-bold rounded-md border border-cyan/20">PAPER</span>
        )}
        <div className="relative">
          <button
            onClick={() => setShowLang(!showLang)}
            aria-label="Change language"
            aria-expanded={showLang}
            className="px-1.5 py-1 text-[10px] text-dim hover:text-foreground bg-surface-2 rounded-md border border-border transition-colors"
          >
            {LANGS.find(l => l.code === locale)?.label || 'EN'}
          </button>
          {showLang && (
            <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 py-1 min-w-[80px]">
              {LANGS.map(l => (
                <button key={l.code} onClick={() => { setLocale(l.code); setShowLang(false); }}
                  className={`block w-full text-left px-3 py-1.5 text-xs transition-colors ${l.code === locale ? 'text-primary bg-primary/10' : 'text-foreground hover:bg-surface-2'}`}>
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
