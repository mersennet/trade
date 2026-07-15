'use client';
import { useState, useEffect } from 'react';
import MarketBar from '@/components/trade/MarketBar';
import MarketLoader from '@/components/trade/MarketLoader';
import Chart from '@/components/trade/Chart';
import OrderBook from '@/components/trade/OrderBook';
import TradeForm from '@/components/trade/TradeForm';
import PositionsTable from '@/components/trade/PositionsTable';
import FundingChart from '@/components/trade/FundingChart';
import AccountPanel from '@/components/trade/AccountPanel';
import PrivacyPanel from '@/components/trade/PrivacyPanel';
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
  const tradeMode = useStore((s) => s.tradeMode);
  const isSpot = tradeMode === 'spot';

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
    <div className="relative flex flex-col h-[calc(100dvh-2.75rem-3.25rem)] md:h-[calc(100vh-3rem)] overflow-hidden">
      <MarketLoader />
      <MarketBar />

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

      {/* Mobile layout */}
      <div className="flex-1 md:hidden min-h-0 overflow-hidden">
        {mobileTab === 'chart' && (
          <div className="h-full"><Chart /></div>
        )}
        {mobileTab === 'book' && (
          <div className="h-full overflow-hidden"><OrderBook /></div>
        )}
        {mobileTab === 'trade' && (
          <div className="h-full overflow-y-auto"><TradeForm /><PrivacyPanel /></div>
        )}
        {mobileTab === 'positions' && (
          <div className="h-full overflow-hidden"><PositionsTable /></div>
        )}
      </div>

      {/* Desktop layout - seamless grid with 1px shared borders, no rounded corners on inner panels */}
      <div className="hidden md:grid flex-1 min-h-0 border-t border-border gap-px bg-border" style={{ gridTemplateColumns: '1fr 220px 250px' }}>
        <div className="flex flex-col gap-px min-h-0 min-w-0">
          <div className="flex-1 min-h-[200px] bg-surface">
            <Chart />
          </div>
          {!isSpot && (
            <div className="h-[110px] lg:h-[130px] bg-surface shrink-0">
              <FundingChart />
            </div>
          )}
          <div className="h-[200px] lg:h-[240px] bg-surface shrink-0">
            <PositionsTable />
          </div>
        </div>
        <div className="min-h-0 min-w-0 bg-surface overflow-hidden">
          <OrderBook />
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto bg-surface flex flex-col gap-px">
          <TradeForm />
          <AccountPanel />
          <PrivacyPanel />
        </div>
      </div>
    </div>
  );
}
