'use client';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useStore } from '@/stores/useStore';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, type Market } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';
import TokenLogo from '@/components/TokenLogo';

function formatCompact(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function FundingCountdown() {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const next = new Date(now);
      const hours = now.getUTCHours();
      const nextFunding = hours < 8 ? 8 : hours < 16 ? 16 : 24;
      next.setUTCHours(nextFunding >= 24 ? 0 : nextFunding, 0, 0, 0);
      if (nextFunding >= 24) next.setUTCDate(next.getUTCDate() + 1);
      const diff = next.getTime() - now.getTime();
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return <span className="font-mono tabular-nums">{timeLeft}</span>;
}

export default function MarketBar() {
  const { market, tickers, setMarket, updateTicker, favorites, toggleFavorite } = useStore();
  const { subscribe } = useWebSocket();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [spotMarkets, setSpotMarkets] = useState<Market[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const tradeMode = useStore((s) => s.tradeMode);
  const setTradeMode = useStore((s) => s.setTradeMode);
  const selectorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getMarkets().then((data) => setMarkets(data.markets || [])).catch(() => {});
    api.getSpotMarkets().then((res) => {
      const list = (res as any)?.markets || res || [];
      setSpotMarkets(Array.isArray(list) ? list.map((s: any) => ({
        id: s.id ?? 1000 + Math.random(), symbol: `${s.base}/${s.quote}`, base: s.base, quote: s.quote,
        maxLeverage: 1, tickSize: s.tick_size || '0.01', minSize: s.min_size || '0.001',
        fundingRate: 0, openInterest: 0,
      })) : []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (markets.length === 0) return;
    const unsubs: (() => void)[] = [];
    for (const m of markets) {
      api.getTicker(m.id).then((t) => updateTicker(m.id, t)).catch(() => {});
      unsubs.push(subscribe(`ticker:${m.id}`, (d) => updateTicker(m.id, d as never)));
    }
    return () => unsubs.forEach((u) => u());
  }, [markets, subscribe, updateTicker]);

  useEffect(() => {
    if (!showSelector) return;
    const handler = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setShowSelector(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    setTimeout(() => searchRef.current?.focus(), 100);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSelector]);

  const activeMarkets = tradeMode === 'perps' ? markets : spotMarkets;

  const filteredMarkets = useMemo(() => {
    if (!searchQuery) return activeMarkets;
    const q = searchQuery.toLowerCase();
    return activeMarkets.filter((m) =>
      m.base.toLowerCase().includes(q) ||
      m.symbol.toLowerCase().includes(q) ||
      m.quote.toLowerCase().includes(q)
    );
  }, [activeMarkets, searchQuery]);

  const currentTicker = tickers[market.id];
  const change24h = currentTicker?.change24h ?? 0;
  const isPositive = change24h >= 0;

  const stats = useMemo(() => {
    if (!currentTicker) return null;
    const longs = currentTicker.longAccounts ?? 0;
    const shorts = currentTicker.shortAccounts ?? 0;
    return {
      markPrice: currentTicker.markPrice,
      oraclePrice: currentTicker.oracleMarkUsd || 0,
      bestBid: currentTicker.bestBid,
      bestAsk: currentTicker.bestAsk,
      volume24h: currentTicker.volume24h || 0,
      trades24h: currentTicker.trades24h || 0,
      openInterest: currentTicker.openInterest || 0,
      longPct: longs + shorts > 0 ? Math.round((longs / (longs + shorts)) * 100) : null,
      fundingRate: market.fundingRate || 0,
    };
  }, [currentTicker, market.fundingRate]);

  return (
    <div className="shrink-0">
      {/* Row 1: Market selector tabs */}
      {/* Mobile: compact market display with dropdown */}
      <div className="md:hidden relative" ref={selectorRef}>
        <button
          onClick={() => setShowSelector(!showSelector)}
          className="w-full flex items-center justify-between px-3 py-2.5 bg-surface border-b border-border"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1">
              <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-bold', tradeMode === 'perps' ? 'bg-primary/10 text-primary' : 'bg-cyan/10 text-cyan')}>
                {tradeMode === 'perps' ? 'PERP' : 'SPOT'}
              </span>
              <span className="text-sm font-bold text-foreground">{market.base}/{market.quote}</span>
              <span className="text-[9px] px-1.5 py-0.5 bg-primary/10 text-primary rounded font-semibold">{market.maxLeverage}x</span>
            </div>
            <span className="font-mono text-sm font-bold text-foreground tabular-nums">
              {currentTicker ? formatPrice(currentTicker.markPrice) : '—'}
            </span>
            <span className={cn(
              'text-[10px] font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded',
              isPositive ? 'text-green bg-green/10' : 'text-red bg-red/10'
            )}>
              {isPositive ? '+' : ''}{formatNumber(change24h, 2)}%
            </span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={cn('text-muted transition-transform', showSelector && 'rotate-180')}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {showSelector && (
          <div className="absolute top-full left-0 right-0 z-50 bg-surface border-b border-border shadow-xl max-h-[70vh] overflow-hidden flex flex-col">
            {/* Perps | Spot toggle */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
              <button onClick={() => setTradeMode('perps')}
                className={cn('flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all', tradeMode === 'perps' ? 'bg-primary/15 text-primary' : 'text-dim bg-surface-2')}>
                Perps
              </button>
              <button onClick={() => setTradeMode('spot')}
                className={cn('flex-1 py-1.5 text-[11px] font-semibold rounded-md transition-all', tradeMode === 'spot' ? 'bg-primary/15 text-primary' : 'text-dim bg-surface-2')}>
                Spot
              </button>
            </div>
            {/* Search input */}
            <div className="px-3 py-2 border-b border-border shrink-0">
              <div className="relative">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={searchRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search markets..."
                  className="w-full bg-surface-2 border border-border rounded-lg pl-8 pr-3 py-2 text-xs text-foreground placeholder:text-dim outline-none focus:border-primary/40"
                />
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredMarkets.map((m) => {
                const t = tickers[m.id];
                const active = market.id === m.id;
                const ch = t?.change24h ?? 0;
                const isFav = favorites.includes(m.id);
                return (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${m.base}/${m.quote} market`}
                    onClick={() => { setMarket(m); setShowSelector(false); setSearchQuery(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMarket(m); setShowSelector(false); setSearchQuery(''); } }}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-2.5 transition-colors border-b border-border/50 cursor-pointer outline-none focus-visible:bg-surface-2',
                      active ? 'bg-primary/5' : 'active:bg-surface-2'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleFavorite(m.id); }}
                        aria-label={isFav ? `Remove ${m.base} from favorites` : `Add ${m.base} to favorites`}
                        aria-pressed={isFav}
                        className={cn('text-[14px] transition-colors', isFav ? 'text-yellow' : 'text-dim/30 hover:text-dim')}
                      >★</button>
                      <TokenLogo symbol={m.base} size={20} />
                      <span className={cn('text-xs font-semibold', active ? 'text-primary' : 'text-foreground')}>
                        {m.base}<span className="text-dim font-normal">/{m.quote}</span>
                      </span>
                      <span className="text-[9px] px-1 py-0.5 bg-surface-2 text-dim rounded">{m.maxLeverage}×</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-foreground tabular-nums">
                        {t ? formatPrice(t.markPrice) : '—'}
                      </span>
                      <span className={cn('text-[10px] font-mono tabular-nums w-14 text-right', ch >= 0 ? 'text-green' : 'text-red')}>
                        {ch >= 0 ? '+' : ''}{formatNumber(ch, 2)}%
                      </span>
                    </div>
                  </div>
                );
              })}
              {filteredMarkets.length === 0 && (
                <div className="py-6 text-center text-xs text-dim">No markets found</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Desktop: scrollable tab bar */}
      <div className="hidden md:flex items-center gap-0 px-1 h-10 bg-surface border-b border-border overflow-x-auto scrollbar-none">
        {/* Perps | Spot toggle */}
        <div className="flex items-center gap-0.5 mr-2 ml-1 shrink-0">
          <button
            onClick={() => setTradeMode('perps')}
            className={cn(
              'px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all',
              tradeMode === 'perps' ? 'bg-primary/15 text-primary' : 'text-dim hover:text-muted'
            )}
          >Perps</button>
          <button
            onClick={() => setTradeMode('spot')}
            className={cn(
              'px-2.5 py-1 text-[11px] font-semibold rounded-md transition-all',
              tradeMode === 'spot' ? 'bg-primary/15 text-primary' : 'text-dim hover:text-muted'
            )}
          >Spot</button>
        </div>
        <div className="w-px h-5 bg-border shrink-0 mr-1" />
        {activeMarkets.map((m) => {
          const t = tickers[m.id];
          const active = market.id === m.id;
          const ch = t?.change24h ?? 0;
          return (
            <button
              key={m.id}
              onClick={() => setMarket(m)}
              className={cn(
                'flex items-center gap-1.5 px-3 h-full text-xs whitespace-nowrap transition-all duration-150 shrink-0 border-b-2',
                active
                  ? 'border-primary bg-primary/[0.04] text-foreground'
                  : 'border-transparent text-muted hover:text-foreground hover:bg-surface-2/50'
              )}
            >
              <TokenLogo symbol={m.base} size={16} />
              <span className={cn('font-semibold', active && 'text-primary')}>{m.base}</span>
              <span className="font-mono tabular-nums text-foreground/70">
                {t ? formatPrice(t.markPrice) : '—'}
              </span>
              {t && (
                <span className={cn('text-[10px] font-mono tabular-nums', ch >= 0 ? 'text-green' : 'text-red')}>
                  {ch >= 0 ? '+' : ''}{formatNumber(ch, 1)}%
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Row 2: Market stats bar.
          Hero = token logo + symbol + mark price + 24h change chip on the left.
          Secondary stats (Volume / Trades / Funding / Bid / Ask) on the right
          using label-above-value pairs so each pair reads as one unit. */}
      {!stats && (
        <div className="flex items-center gap-4 md:gap-6 px-3 md:px-4 h-14 bg-surface border-b border-border" role="status" aria-label="Loading market stats">
          <div className="skeleton w-7 h-7 rounded-full shrink-0" />
          <div className="skeleton h-5 w-40" />
          <div className="w-px h-7 bg-border shrink-0" />
          <div className="skeleton h-3.5 w-20" />
          <div className="skeleton h-3.5 w-20 hidden md:block" />
          <div className="skeleton h-3.5 w-20 hidden md:block" />
          <span className="sr-only">Loading market stats…</span>
        </div>
      )}
      {stats && (
        <div className="flex items-center gap-4 md:gap-6 px-3 md:px-4 h-14 bg-surface border-b border-border overflow-x-auto scrollbar-none">
          {/* Hero: token logo + symbol + mark price + 24h change pill */}
          <div className="flex items-center gap-3 shrink-0">
            <TokenLogo symbol={market.base} size={28} />
            <div className="flex items-baseline gap-2.5">
              <div className="flex items-baseline gap-1">
                <span className="text-[13px] font-semibold text-foreground tracking-tight">{market.base}</span>
                <span className="text-[10px] text-dim">/{market.quote}</span>
              </div>
              <span className="font-mono font-semibold tabular-nums text-foreground text-[18px] md:text-[20px] leading-none">
                {formatPrice(stats.markPrice)}
              </span>
              <span className={cn(
                'font-mono font-semibold tabular-nums text-[11px] px-1.5 py-0.5 rounded',
                isPositive ? 'text-green bg-green/10' : 'text-red bg-red/10'
              )}>
                {isPositive ? '+' : ''}{formatNumber(change24h, 2)}%
              </span>
            </div>
          </div>

          <div className="w-px h-7 bg-border shrink-0" />

          {/* Secondary stats — label-above-value, one column each */}
          {stats.oraclePrice > 0 && stats.oraclePrice !== stats.markPrice && (
            <Stat label="Oracle" value={formatPrice(stats.oraclePrice)} valueClass="text-dim" />
          )}
          <Stat label="24h Volume" value={formatCompact(stats.volume24h)} />
          <Stat label="24h Trades" value={formatNumber(stats.trades24h, 0)} />

          {tradeMode === 'perps' && (
            <>
              <Stat
                label="Funding"
                value={`${stats.fundingRate >= 0 ? '+' : ''}${(stats.fundingRate * 100).toFixed(4)}%`}
                valueClass={stats.fundingRate >= 0 ? 'text-green' : 'text-red'}
              />
              <Stat label="Next funding" value={<FundingCountdown />} valueClass="text-yellow" />
              {stats.openInterest > 0 && (
                <Stat label="Open Interest" value={formatCompact(stats.openInterest)} />
              )}
              {stats.longPct !== null && (
                <Stat
                  label="L/S Accounts"
                  value={`${stats.longPct}% / ${100 - stats.longPct}%`}
                  valueClass={stats.longPct >= 50 ? 'text-green' : 'text-red'}
                />
              )}
            </>
          )}

          <Stat
            label="Best Bid"
            value={stats.bestBid > 0 ? formatPrice(stats.bestBid) : '—'}
            valueClass={stats.bestBid > 0 ? 'text-green' : 'text-dim'}
          />
          <Stat
            label="Best Ask"
            value={stats.bestAsk > 0 ? formatPrice(stats.bestAsk) : '—'}
            valueClass={stats.bestAsk > 0 ? 'text-red' : 'text-dim'}
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex flex-col justify-center gap-0.5 shrink-0 min-w-0">
      <span className="text-[9.5px] uppercase tracking-wider text-dim leading-none whitespace-nowrap">{label}</span>
      <span className={cn('font-mono font-medium tabular-nums text-[12px] text-foreground leading-none whitespace-nowrap', valueClass)}>
        {value}
      </span>
    </div>
  );
}
