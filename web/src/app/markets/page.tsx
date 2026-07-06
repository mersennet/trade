'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/stores/useStore';
import { api, type Market, type Ticker } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';
import TokenLogo from '@/components/TokenLogo';
import EmptyState from '@/components/shared/EmptyState';

export default function MarketsPage() {
  const router = useRouter();
  const { setMarket, favorites, toggleFavorite } = useStore();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [tickers, setTickers] = useState<Record<number, Ticker>>({});
  const [filter, setFilter] = useState<'all' | 'favorites' | 'prelaunch' | 'synthetic'>('all');

  useEffect(() => {
    api.getMarkets().then((data) => setMarkets(data.markets || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (markets.length === 0) return;
    const fetchTickers = async () => {
      const results = await Promise.allSettled(
        markets.map((m) => api.getTicker(m.id).then((t) => ({ id: m.id, ticker: t })))
      );
      const next: Record<number, Ticker> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.id] = r.value.ticker;
      }
      setTickers((prev) => ({ ...prev, ...next }));
    };
    fetchTickers();
    const interval = setInterval(fetchTickers, 5000);
    return () => clearInterval(interval);
  }, [markets]);

  const filtered = filter === 'favorites'
    ? markets.filter((m) => favorites.includes(m.id))
    : filter === 'prelaunch' || filter === 'synthetic'
    ? []
    : markets;

  const handleSelect = (m: Market) => {
    setMarket(m);
    router.push('/trade');
  };

  // Only surface filter tabs that have markets (plus Favorites, which is
  // user-driven). Empty "Pre-Launch"/"Equities" tabs made the page look
  // padded with unbuilt sections.
  const filters: { key: typeof filter; label: string; count?: number }[] = [
    { key: 'all', label: 'All Markets', count: markets.length },
    { key: 'favorites', label: 'Favorites', count: favorites.length },
  ];

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      {/* Page header — left-aligned, no marketing copy. Stats live in the
          filter row below since they're more useful than a tagline. */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">Markets</h1>
          <p className="text-dim text-xs md:text-[13px] mt-0.5">
            {markets.length} perpetual market{markets.length === 1 ? '' : 's'} live on Mersennet
          </p>
        </div>
      </div>

      {/* Filter pills — segmented control with counts */}
      <div className="flex items-center gap-px bg-background rounded-md border border-border overflow-hidden w-fit">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-3 md:px-4 py-1.5 text-[11.5px] font-medium transition-colors whitespace-nowrap flex items-center gap-1.5',
              filter === f.key
                ? 'bg-foreground/[0.07] text-foreground'
                : 'bg-surface-2 text-dim hover:text-foreground'
            )}
          >
            <span>{f.label}</span>
            {typeof f.count === 'number' && (
              <span className={cn(
                'text-[10px] px-1 py-px rounded font-mono tabular-nums',
                filter === f.key ? 'bg-foreground/10 text-foreground' : 'bg-background text-dim'
              )}>{f.count}</span>
            )}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        markets.length === 0 && filter === 'all' ? (
          /* Loading skeleton — shimmer cards while markets fetch */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5" role="status" aria-label="Loading markets">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-surface border border-border rounded-xl p-4 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="skeleton w-9 h-9 rounded-full" />
                  <div className="space-y-1.5">
                    <div className="skeleton h-3.5 w-24" />
                    <div className="skeleton h-2.5 w-16" />
                  </div>
                </div>
                <div className="skeleton h-6 w-32" />
                <div className="flex gap-3">
                  <div className="skeleton h-3 flex-1" />
                  <div className="skeleton h-3 flex-1" />
                  <div className="skeleton h-3 flex-1" />
                </div>
              </div>
            ))}
            <span className="sr-only">Loading markets…</span>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl">
            <EmptyState
              label={
                filter === 'favorites' ? 'No favorites yet'
                : filter === 'prelaunch' || filter === 'synthetic' ? 'Nothing listed here yet'
                : 'No markets found'
              }
              hint={
                filter === 'favorites' ? 'Star a market to pin it here'
                : filter === 'prelaunch' || filter === 'synthetic' ? 'New listings in this category will appear here'
                : 'Markets will appear once listed on-chain'
              }
            />
          </div>
        )
      )}

      {/* Mobile: compact list with logo */}
      <div className="md:hidden space-y-2">
        {filtered.map((m) => {
          const t = tickers[m.id];
          const ch = t?.change24h ?? 0;
          const isFav = favorites.includes(m.id);
          return (
            <button
              key={m.id}
              onClick={() => handleSelect(m)}
              className="w-full flex items-center justify-between px-3 py-3 bg-surface border border-border rounded-lg active:bg-surface-2 transition-colors"
            >
              <div className="flex items-center gap-3">
                <TokenLogo symbol={m.base} size={32} />
                <div className="text-left">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-foreground">{m.base}</span>
                    <span className="text-[10px] text-dim">/{m.quote}</span>
                  </div>
                  <span className="text-[10px] text-dim">Up to {m.maxLeverage}× leverage</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <span className="text-[13px] font-mono font-semibold text-foreground block tabular-nums">
                    {t ? formatPrice(t.markPrice) : '—'}
                  </span>
                  <span className={cn('text-[10.5px] font-mono tabular-nums', ch >= 0 ? 'text-green' : 'text-red')}>
                    {ch >= 0 ? '+' : ''}{formatNumber(ch, 2)}%
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(m.id); }}
                  className={cn('text-base transition-colors w-6 h-6 flex items-center justify-center', isFav ? 'text-yellow' : 'text-dim/40')}
                  aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                >{isFav ? '★' : '☆'}</button>
              </div>
            </button>
          );
        })}
      </div>

      {/* Desktop: cards with token logo + quote pair logo */}
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-3.5">
        {filtered.map((m) => {
          const t = tickers[m.id];
          const ch = t?.change24h ?? 0;
          const isUp = ch >= 0;
          const isFav = favorites.includes(m.id);
          return (
            <div
              key={m.id}
              className="relative bg-surface border border-border rounded-xl p-4 hover:border-primary/30 hover:bg-surface-2/30 transition-all duration-200 cursor-pointer group"
              onClick={() => handleSelect(m)}
            >
              {/* Favorite star — absolute top-right so it doesn't compete with header */}
              <button
                onClick={(e) => { e.stopPropagation(); toggleFavorite(m.id); }}
                className={cn(
                  'absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md transition-colors text-base',
                  isFav ? 'text-yellow' : 'text-dim/30 hover:text-dim hover:bg-surface-2'
                )}
                aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
              >{isFav ? '★' : '☆'}</button>

              {/* Header: paired logos + symbol + leverage */}
              <div className="flex items-center gap-3 mb-4 pr-8">
                <div className="relative shrink-0">
                  <TokenLogo symbol={m.base} size={36} />
                  <TokenLogo
                    symbol={m.quote}
                    size={16}
                    className="absolute -bottom-1 -right-1 ring-2 ring-surface group-hover:ring-surface-2/30"
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <h3 className="text-[15px] font-semibold text-foreground tracking-tight">{m.base}</h3>
                    <span className="text-[11px] text-dim">/{m.quote}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] px-1.5 py-px rounded bg-surface-2 text-muted font-mono tabular-nums">
                      {m.maxLeverage}× max
                    </span>
                    <span className="text-[10px] text-dim">Perp</span>
                  </div>
                </div>
              </div>

              {/* Hero: mark price + change chip */}
              <div className="flex items-end justify-between mb-4 pb-4 border-b border-border/60">
                <span className="text-[22px] text-foreground font-mono font-semibold tabular-nums leading-none">
                  {t ? formatPrice(t.markPrice) : '—'}
                </span>
                <span className={cn(
                  'text-[11.5px] font-mono font-semibold px-2 py-1 rounded-md tabular-nums leading-none',
                  isUp ? 'text-green bg-green/10' : 'text-red bg-red/10'
                )}>
                  {isUp ? '+' : ''}{formatNumber(ch, 2)}%
                </span>
              </div>

              {/* Stats row: Volume / Trades / Funding */}
              <div className="grid grid-cols-3 gap-3">
                <Stat label="24h Volume" value={t ? `$${formatNumber(t.volume24h)}` : '—'} />
                <Stat label="24h Trades" value={t ? formatNumber(t.trades24h ?? 0, 0) : '—'} />
                <Stat
                  label="Funding"
                  value={`${((m.fundingRate ?? 0) * 100).toFixed(4)}%`}
                  valueClass={(m.fundingRate ?? 0) >= 0 ? 'text-green' : 'text-red'}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <span className="text-[9.5px] uppercase tracking-wider text-dim block mb-1 whitespace-nowrap">{label}</span>
      <span className={cn('text-[12px] font-mono tabular-nums text-foreground/80 truncate block', valueClass)}>
        {value}
      </span>
    </div>
  );
}
