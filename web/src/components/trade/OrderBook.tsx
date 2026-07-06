'use client';
import { useEffect, useState, useMemo } from 'react';
import { useStore } from '@/stores/useStore';
import { api, type Trade } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import EmptyState, { SkeletonRows } from '@/components/shared/EmptyState';

interface BookLevel { price: number; size: number; total: number; pct: number; }
type BookTab = 'book' | 'trades';

export default function OrderBook() {
  const { market } = useStore();
  const setTrade = useStore((s) => s.setTrade);
  const { subscribe } = useWebSocket();
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [grouping, setGrouping] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<BookTab>('book');
  const [recentTrades, setRecentTrades] = useState<Trade[]>([]);

  useEffect(() => {
    let mounted = true;
    // Clear stale book so the previous market's prices don't briefly flash
    // on the new market while the new fetch is in flight.
    setLoading(true);
    setBids([]);
    setAsks([]);

    const fetchBook = async () => {
      try {
        const { orderbook } = await api.getOrderBook(market.id);
        if (!mounted) return;
        processBook(orderbook?.bids || [], orderbook?.asks || []);
      } catch (e) {
        console.error('[orderbook] fetch error:', e);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchBook();
    const interval = setInterval(fetchBook, 3000);

    const unsub = subscribe(`orderbook:${market.id}`, (data: unknown) => {
      const d = data as { bids?: [number, number][]; asks?: [number, number][] };
      if (d.bids || d.asks) processBook(d.bids || [], d.asks || []);
    });

    return () => { mounted = false; clearInterval(interval); unsub(); };
  }, [market.id, subscribe, grouping]);

  function processBook(rawBids: [number, number][], rawAsks: [number, number][]) {
    const processLevels = (levels: [number, number][], isAsk: boolean): BookLevel[] => {
      const grouped = new Map<number, number>();
      for (const [p, s] of levels) {
        const key = Math.floor(p / grouping) * grouping;
        grouped.set(key, (grouped.get(key) || 0) + s);
      }
      const sorted = [...grouped.entries()]
        .sort((a, b) => isAsk ? a[0] - b[0] : b[0] - a[0])
        .slice(0, 20);

      let cumTotal = 0;
      const result = sorted.map(([price, size]) => {
        cumTotal += size;
        return { price, size, total: cumTotal, pct: 0 };
      });
      const maxTotal = result[result.length - 1]?.total || 1;
      return result.map((l) => ({ ...l, pct: (l.total / maxTotal) * 100 }));
    };

    setBids(processLevels(rawBids, false));
    setAsks(processLevels(rawAsks, true));
  }

  useEffect(() => {
    api.getTrades(market.id, 50).then((r) => setRecentTrades(r.trades || [])).catch(() => {});
  }, [market.id]);

  useEffect(() => {
    const unsub = subscribe(`trades:${market.id}`, (data: unknown) => {
      const d = data as Trade;
      if (d?.id) setRecentTrades((prev) => [d, ...prev].slice(0, 50));
    });
    return unsub;
  }, [market.id, subscribe]);

  const spread = useMemo(() => {
    if (asks.length > 0 && bids.length > 0) return asks[0].price - bids[0].price;
    return 0;
  }, [asks, bids]);

  const midPrice = useMemo(() => {
    if (bids[0] && asks[0]) return (bids[0].price + asks[0].price) / 2;
    if (bids[0]) return bids[0].price;
    if (asks[0]) return asks[0].price;
    return 0;
  }, [asks, bids]);

  const buySellRatio = useMemo(() => {
    const totalBidSize = bids.reduce((sum, b) => sum + b.size, 0);
    const totalAskSize = asks.reduce((sum, a) => sum + a.size, 0);
    const total = totalBidSize + totalAskSize;
    if (total === 0) return { buyPct: 50, sellPct: 50 };
    return { buyPct: Math.round((totalBidSize / total) * 100), sellPct: Math.round((totalAskSize / total) * 100) };
  }, [bids, asks]);

  return (
    <div className="bg-surface border border-border rounded-xl md:border-0 md:rounded-none overflow-hidden h-full flex flex-col">
      {/* Header: Book/Trades tabs + grouping */}
      <div className="flex items-center justify-between px-3 py-0 border-b border-border shrink-0">
        <div className="flex items-center gap-0">
          <button onClick={() => setActiveTab('book')} className={cn(
            'px-3 py-2 text-[11px] font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'book' ? 'text-foreground border-primary' : 'text-dim hover:text-muted border-transparent'
          )}>Order Book</button>
          <button onClick={() => setActiveTab('trades')} className={cn(
            'px-3 py-2 text-[11px] font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'trades' ? 'text-foreground border-primary' : 'text-dim hover:text-muted border-transparent'
          )}>Trades</button>
        </div>
        {activeTab === 'book' && (
          <select
            value={grouping}
            onChange={(e) => setGrouping(Number(e.target.value))}
            aria-label="Price grouping"
            className="bg-surface-2 text-foreground text-[11px] px-2 py-0.5 rounded border border-border cursor-pointer focus:border-primary/40"
          >
            <option value={1}>1</option>
            <option value={10}>10</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={500}>500</option>
          </select>
        )}
      </div>

      {activeTab === 'book' ? (
        <>
          <div className="grid grid-cols-3 px-3 py-1.5 text-[10px] text-dim uppercase tracking-wider border-b border-border shrink-0">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>

          {loading && bids.length === 0 && asks.length === 0 ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <SkeletonRows rows={8} />
            </div>
          ) : bids.length === 0 && asks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                label="Book is empty"
                hint="No resting orders. Place a limit order to seed liquidity."
              />
            </div>
          ) : (
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto flex flex-col-reverse min-h-0">
                {asks.map((level, i) => (
                  <div
                    key={`a-${i}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Fill price ${formatPrice(level.price)} (buy)`}
                    className="relative grid grid-cols-3 px-3 py-[4px] text-xs cursor-pointer hover:bg-red/8 font-mono transition-colors outline-none focus-visible:bg-red/12"
                    onClick={() => setTrade({ price: level.price.toString(), side: 'buy' })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTrade({ price: level.price.toString(), side: 'buy' }); } }}
                  >
                    <div className="absolute inset-y-0 right-0 bg-red/[0.10]" style={{ width: `${level.pct}%` }} />
                    <span className="relative text-red font-semibold tabular-nums">{formatPrice(level.price)}</span>
                    <span className="relative text-right text-foreground/70 tabular-nums">{formatNumber(level.size, 0)}</span>
                    <span className="relative text-right text-dim/70 tabular-nums">{formatNumber(level.total, 0)}</span>
                  </div>
                ))}
              </div>

              <div className="px-3 py-2 border-y border-border bg-surface-2/60 flex items-center justify-between shrink-0">
                <span className="text-[15px] font-bold text-foreground font-mono tabular-nums tracking-tight">
                  {midPrice ? formatPrice(midPrice) : '—'}
                </span>
                <span className="text-[10px] text-muted font-mono px-1.5 py-0.5 rounded bg-surface-3/80 border border-border-subtle">
                  spread {formatPrice(spread)}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {bids.map((level, i) => (
                  <div
                    key={`b-${i}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Fill price ${formatPrice(level.price)} (sell)`}
                    className="relative grid grid-cols-3 px-3 py-[4px] text-xs cursor-pointer hover:bg-green/8 font-mono transition-colors outline-none focus-visible:bg-green/12"
                    onClick={() => setTrade({ price: level.price.toString(), side: 'sell' })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTrade({ price: level.price.toString(), side: 'sell' }); } }}
                  >
                    <div className="absolute inset-y-0 right-0 bg-green/[0.10]" style={{ width: `${level.pct}%` }} />
                    <span className="relative text-green font-semibold tabular-nums">{formatPrice(level.price)}</span>
                    <span className="relative text-right text-foreground/70 tabular-nums">{formatNumber(level.size, 0)}</span>
                    <span className="relative text-right text-dim/70 tabular-nums">{formatNumber(level.total, 0)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Buy/Sell Ratio Bar (like Bluefin) */}
          {(bids.length > 0 || asks.length > 0) && (
            <div className="px-3 py-1.5 border-t border-border shrink-0">
              <div className="flex items-center justify-between text-[10px] mb-1">
                <span className="text-green font-medium">Buy {buySellRatio.buyPct}%</span>
                <span className="text-red font-medium">{buySellRatio.sellPct}% Sell</span>
              </div>
              <div className="h-1 bg-surface-2 rounded-full overflow-hidden flex">
                <div className="bg-green/60 transition-all duration-500" style={{ width: `${buySellRatio.buyPct}%` }} />
                <div className="bg-red/60 transition-all duration-500" style={{ width: `${buySellRatio.sellPct}%` }} />
              </div>
            </div>
          )}
        </>
      ) : (
        /* Trades Tab */
        <>
          <div className="grid grid-cols-3 px-3 py-1.5 text-[10px] text-dim border-b border-border shrink-0">
            <span>Price</span>
            <span className="text-right">Size ({market.base})</span>
            <span className="text-right">Time</span>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {recentTrades.length > 0 ? recentTrades.map((t, i) => {
              const isBuy = t.side === 'buy';
              const prev = recentTrades[i + 1];
              const priceUp = prev ? t.price >= prev.price : true;
              const color = isBuy || priceUp ? 'text-green' : 'text-red';
              return (
                <div key={t.id || i} className="grid grid-cols-3 px-3 py-[3px] text-[11px] font-mono hover:bg-surface-2/50 transition-colors group">
                  <span className={cn('tabular-nums', color)}>
                    {formatPrice(t.price)}
                  </span>
                  <span className="text-right text-foreground/60 tabular-nums">{formatNumber(t.size, 5)}</span>
                  <span className="text-right text-dim tabular-nums flex items-center justify-end gap-1">
                    {new Date(t.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-0 group-hover:opacity-40 transition-opacity shrink-0">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </span>
                </div>
              );
            }) : (
              <EmptyState
                label="No recent trades"
                hint="Fills will stream in here in real time"
                compact
              />
            )}
          </div>
          <div className="px-3 py-1.5 border-t border-border shrink-0 flex items-center justify-end">
            <button className="text-[10px] text-dim hover:text-muted transition-colors flex items-center gap-1">
              Filter
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
