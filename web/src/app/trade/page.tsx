'use client';
import { useState, useEffect } from 'react';
import MarketBar from '@/components/trade/MarketBar';
import MarketLoader from '@/components/trade/MarketLoader';
import Chart from '@/components/trade/Chart';
import OrderBook from '@/components/trade/OrderBook';
import TradeForm from '@/components/trade/TradeForm';
import PositionsTable from '@/components/trade/PositionsTable';
import AccountPanel from '@/components/trade/AccountPanel';
import PrivacyPanel from '@/components/trade/PrivacyPanel';
import GettingStarted from '@/components/trade/GettingStarted';
import OnboardingTour from '@/components/trade/OnboardingTour';
import { useBrackets } from '@/hooks/useBrackets';
import { usePriceAlerts } from '@/hooks/usePriceAlerts';
import { useAccountEvents } from '@/hooks/useAccountEvents';
import { cn, formatPrice } from '@/lib/utils';
import { useStore } from '@/stores/useStore';

type MobileTab = 'chart' | 'book' | 'trade' | 'positions';

const MOBILE_TABS: { key: MobileTab; label: string; icon: React.ReactNode }[] = [
  {
    key: 'chart',
    label: 'Chart',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
      </svg>
    ),
  },
  {
    key: 'book',
    label: 'Book',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="18" rx="1" />
      </svg>
    ),
  },
  {
    key: 'trade',
    label: 'Trade',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
      </svg>
    ),
  },
  {
    key: 'positions',
    label: 'Positions',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3h18v18H3z" /><path d="M3 9h18M3 15h18M9 3v18" />
      </svg>
    ),
  },
];

export default function TradePage() {
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');
  const { market, tickers } = useStore();
  // Watch TP/SL brackets and fire signed closing orders when triggers cross.
  useBrackets();
  // Watch price alerts and notify on crossings.
  usePriceAlerts();
  useAccountEvents();

  useEffect(() => {
    const ticker = tickers[market.id];
    if (ticker?.markPrice) {
      document.title = `${formatPrice(ticker.markPrice)} | ${market.base} | Mersennet Trade`;
    } else {
      document.title = `${market.base} | Mersennet Trade`;
    }
    return () => { document.title = 'Mersennet Trade | Decentralized Perpetual Exchange'; };
  }, [market, tickers]);

  return (
    // Desktop height subtracts header (3rem) + status line (1.5rem).
    <div className="relative flex flex-col h-[calc(100dvh-2.75rem-3.25rem)] md:h-[calc(100vh-4.5rem)] overflow-hidden">
      <MarketLoader />
      <OnboardingTour />
      <div data-tour="market-bar">
        <MarketBar />
      </div>

      {/* Mobile tab bar */}
      <div className="flex md:hidden bg-surface border-b border-border shrink-0">
        {MOBILE_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setMobileTab(tab.key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium transition-colors touch-manipulation',
              mobileTab === tab.key
                ? 'text-primary border-b-2 border-primary bg-primary/[0.03]'
                : 'text-dim active:text-muted'
            )}
          >
            <span className={cn(mobileTab === tab.key && 'text-primary')}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Mobile layout — chart/book/positions swap; the Trade tab opens as a
          bottom sheet OVER the chart (HL-style) so market context stays visible */}
      <div className="flex-1 md:hidden min-h-0 overflow-hidden relative">
        {mobileTab === 'chart' && (
          <div className="h-full"><Chart /></div>
        )}
        {mobileTab === 'book' && (
          <div className="h-full overflow-hidden"><OrderBook /></div>
        )}
        {mobileTab === 'positions' && (
          <div className="h-full overflow-hidden"><PositionsTable /></div>
        )}
        {mobileTab === 'trade' && (
          <>
            <div className="h-full"><Chart /></div>
            <div className="absolute inset-x-0 bottom-0 top-[15%] z-30 flex flex-col bg-surface border-t border-border rounded-t-2xl shadow-2xl animate-[slideUp_0.25s_ease-out]">
              <div className="flex items-center justify-center py-2 shrink-0 border-b border-border/50">
                <div className="w-9 h-1 rounded-full bg-border" />
              </div>
              <div className="flex-1 overflow-y-auto">
                <GettingStarted /><TradeForm /><PrivacyPanel />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Desktop layout - seamless grid with 1px shared borders, no rounded corners on inner panels */}
      <div className="hidden md:grid flex-1 min-h-0 border-t border-border gap-px bg-border" style={{ gridTemplateColumns: 'minmax(0, 1fr) 240px 280px' }}>
        <div className="flex flex-col gap-px min-h-0 min-w-0">
          {/* Funding history moved out of the prime chart column — it lives in
              the Funding tab of the positions panel below. */}
          <div className="flex-1 min-h-[200px] bg-surface">
            <Chart />
          </div>
          <div className="h-[200px] lg:h-[240px] bg-surface shrink-0" data-tour="positions">
            <PositionsTable />
          </div>
        </div>
        <div className="min-h-0 min-w-0 bg-surface overflow-hidden">
          <OrderBook />
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto bg-surface flex flex-col gap-px">
          <GettingStarted />
          <TradeForm />
          <AccountPanel />
          <PrivacyPanel />
        </div>
      </div>
    </div>
  );
}
