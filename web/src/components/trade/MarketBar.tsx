'use client';
import { useEffect, useState, useRef, useMemo } from 'react';
import { useStore } from '@/stores/useStore';
import { useWebSocket } from '@/hooks/useWebSocket';
import { api, type Market } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';
import TokenLogo from '@/components/TokenLogo';
import PriceAlertBell from '@/components/trade/PriceAlertBell';

function formatCompact(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}


export default function MarketBar() {
  const { market, tickers, setMarket, updateTicker, favorites, toggleFavorite, recentMarkets } = useStore();
  const { subscribe } = useWebSocket();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [showSelector, setShowSelector] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const tradeMode = useStore((s) => s.tradeMode);
  const selectorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getMarkets().then((data) => setMarkets(data.markets || [])).catch(() => {});
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

  // Untraded (permissionlessly listed) markets sink to the end of the tab
  // strip so dead "—" tabs never sit ahead of live markets.
  const activeMarkets = useMemo(() => {
    const quiet = (m: Market) => {
      const t = tickers[m.id];
      return !(t && ((t.markPrice ?? 0) > 0 || (t.volume24h ?? 0) > 0));
    };
    if (Object.keys(tickers).length === 0) return markets;
    return [...markets].sort((a, b) => (quiet(a) ? 1 : 0) - (quiet(b) ? 1 : 0));
  }, [markets, tickers]);

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
      // null until the chain-position snapshot exists (API); never a made-up number
      openInterest: currentTicker.openInterest == null ? null : Number(currentTicker.openInterest),
      longPct: longs + shorts > 0 ? Math.round((longs / (longs + shorts)) * 100) : null,
    };
  }, [currentTicker]);

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
              {/* Recently viewed markets — quick switch-back row */}
              {!searchQuery && recentMarkets.length > 1 && (
                <div className="px-3 py-1.5 border-b border-border/50 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[9px] text-dim uppercase tracking-wider font-medium">Recent</span>
                  {recentMarkets.filter((id) => id !== market.id).slice(0, 4).map((id) => {
                    const m = activeMarkets.find((x) => x.id === id) || markets.find((x) => x.id === id);
                    if (!m) return null;
                    return (
                      <button
                        key={id}
                        onClick={() => { setMarket(m); setShowSelector(false); setSearchQuery(''); }}
                        className="px-1.5 py-0.5 text-[10px] font-medium text-dim hover:text-foreground bg-surface-2 rounded border border-border transition-colors"
                      >{m.base}</button>
                    );
                  })}
                </div>
              )}
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
        {/* The terminal trades perps on the on-chain CLOB only. Spot is a
            preview surface (not on chain) and is no longer advertised here —
            a "Spot" control on the live terminal read as a second product. */}
        <div className="flex items-center gap-0.5 mr-2 ml-1 shrink-0">
          <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] bg-[var(--primary-dim)] text-primary-bright">Perps</span>
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
              <span className={cn('font-bold', active && 'text-primary-bright')}>{m.base}</span>
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
      {/* The stats bar is desktop-only: the mobile market selector row above
          already shows symbol + price + change, and repeating them in a second
          56px strip wasted a tenth of a phone screen. */}
      {!stats && (
        <div className="hidden md:flex items-center gap-4 md:gap-6 px-3 md:px-4 h-14 bg-surface border-b border-border" role="status" aria-label="Loading market stats">
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
        <div className="hidden md:flex items-center gap-4 md:gap-6 px-3 md:px-4 h-14 bg-surface border-b border-border overflow-x-auto scrollbar-none">
          {/* Hero: token logo + symbol + mark price + 24h change pill */}
          <div className="flex items-center gap-3 shrink-0">
            <TokenLogo symbol={market.base} size={28} />
            <div className="flex items-baseline gap-2.5">
              <div className="flex items-baseline gap-1">
                <span className="text-[13px] font-semibold text-foreground tracking-tight">{market.base}</span>
                <span className="text-[10px] text-dim">/{market.quote}</span>
              </div>
              <span className="font-mono font-extrabold tabular-nums text-primary-bright crt-glow text-[18px] md:text-[21px] leading-none">
                {formatPrice(stats.markPrice)}
              </span>
              <span className={cn(
                'font-mono font-semibold tabular-nums text-[11px] px-1.5 py-0.5 rounded',
                isPositive ? 'text-green bg-green/10' : 'text-red bg-red/10'
              )}>
                {isPositive ? '+' : ''}{formatNumber(change24h, 2)}%
              </span>
              <PriceAlertBell marketId={market.id} />
            </div>
          </div>

          <div className="w-px h-7 bg-border shrink-0" />

          {/* Secondary stats — label-above-value, one column each */}
          {stats.oraclePrice > 0 && stats.oraclePrice !== stats.markPrice && (
            <Stat label="Oracle" value={formatPrice(stats.oraclePrice)} valueClass="text-dim" />
          )}
          <Stat label="24h Volume" value={formatCompact(stats.volume24h)} />
          {/* Lower-priority stats hide at narrow desktop widths so Best
              Bid/Ask never get clipped off the right edge (the row's
              horizontal scroll has no scrollbar and is undiscoverable). */}
          <Stat label="24h Trades" value={formatNumber(stats.trades24h, 0)} className="hidden lg:flex" />

          {tradeMode === 'perps' && (
            <>
              {/* No funding mechanism exists on the testnet CLOB, so there is no
                  funding rate or countdown to show. Leverage is the inverse of
                  the initial margin the chain enforces (10% → 10×). */}
              <Stat
                label="Max leverage"
                value={`${market.maxLeverage}×`}
                title={market.marginEnforced
                  ? 'Initial margin 10% of notional, maintenance 5%'
                  : 'From block 1,605,600 (Sun 20 Sep): 10% initial margin. Until then the chain enforces no margin — keep positions inside this limit anyway.'}
                className="hidden lg:flex"
              />
              <Stat label="Open Interest" value={stats.openInterest == null ? '—' : formatCompact(stats.openInterest)} className="hidden lg:flex" title="Sum of long positions at the mark, read from chain accounts every minute" />
              {stats.longPct !== null && (
                <Stat
                  label="L/S Accounts"
                  value={`${stats.longPct}% / ${100 - stats.longPct}%`}
                  valueClass={stats.longPct >= 50 ? 'text-green' : 'text-red'}
                  className="hidden xl:flex"
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

function Stat({ label, value, valueClass, className, title }: { label: string; value: React.ReactNode; valueClass?: string; className?: string; title?: string }) {
  return (
    <div className={cn('flex flex-col justify-center gap-0.5 shrink-0 min-w-0', className)} title={title}>
      <span className="text-[9.5px] uppercase tracking-wider text-dim leading-none whitespace-nowrap">{label}</span>
      <span className={cn('font-mono font-medium tabular-nums text-[12px] text-foreground leading-none whitespace-nowrap', valueClass)}>
        {value}
      </span>
    </div>
  );
}
