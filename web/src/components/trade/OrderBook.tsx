'use client';
import { useEffect, useState, useMemo, useRef } from 'react';
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
  const { subscribe, connected } = useWebSocket();
  // Raw (ungrouped) best bid/ask drive the mid-price and spread readout, so
  // those stay truthful no matter what display grouping is selected.
  const [rawBids, setRawBids] = useState<[number, number][]>([]);
  const [rawAsks, setRawAsks] = useState<[number, number][]>([]);
  const [grouping, setGrouping] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<BookTab>('book');
  const [recentTrades, setRecentTrades] = useState<Trade[]>([]);
  const [tradeFilter, setTradeFilter] = useState<'all' | 'buy' | 'sell'>('all');
  // Monotonic clock for snapshot ordering: the 3s REST poll and the WS
  // broadcast are independent snapshots of the same book, and without an
  // ordering check a stale WS payload can overwrite a fresher REST one (or
  // vice versa), briefly showing a crossed book (ask < bid) that never
  // existed on chain.
  const lastBookTs = useRef(0);

  useEffect(() => {
    let mounted = true;
    // Clear stale book so the previous market's prices don't briefly flash
    // on the new market while the new fetch is in flight.
    setLoading(true);
    setRawBids([]);
    setRawAsks([]);
    lastBookTs.current = 0;

    const fetchBook = async () => {
      try {
        const { orderbook } = await api.getOrderBook(market.id);
        if (!mounted) return;
        applyBook(orderbook?.bids || [], orderbook?.asks || [], Date.now());
      } catch (e) {
        console.error('[orderbook] fetch error:', e);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchBook();
    // WS is the primary feed (snapshots are timestamp-ordered, so stale
    // payloads are dropped). The 3s REST poll only runs as a fallback while
    // the socket is down.
    const interval = connected ? null : setInterval(fetchBook, 3000);

    const unsub = subscribe(`orderbook:${market.id}`, (data: unknown) => {
      const d = data as { bids?: [number, number][]; asks?: [number, number][]; timestamp?: number };
      if (!d.bids && !d.asks) return;
      applyBook(d.bids, d.asks, d.timestamp || Date.now());
    });

    return () => { mounted = false; if (interval) clearInterval(interval); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.id, subscribe, connected]);

  function applyBook(newBids: [number, number][] | undefined, newAsks: [number, number][] | undefined, ts: number) {
    if (ts < lastBookTs.current) return; // stale snapshot — keep the fresher one
    lastBookTs.current = ts;
    // A payload carrying only one side merges with the current other side
    // instead of wiping it.
    if (newBids) setRawBids(newBids.filter(([p]) => p > 0));
    if (newAsks) setRawAsks(newAsks.filter(([p]) => p > 0));
  }

  // Grouped display rows. Bids round DOWN into their bucket, asks round UP —
  // the convention Hyperliquid/Binance use — so a coarse grouping can never
  // render a locked or crossed book (floor/floor collapses both sides into
  // the same bucket whenever the true spread is tighter than the grouping).
  const { bids, asks } = useMemo(() => {
    const processLevels = (levels: [number, number][], isAsk: boolean): BookLevel[] => {
      const grouped = new Map<number, number>();
      for (const [p, s] of levels) {
        const key = isAsk
          ? Math.ceil(p / grouping) * grouping
          : Math.floor(p / grouping) * grouping;
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
    return { bids: processLevels(rawBids, false), asks: processLevels(rawAsks, true) };
  }, [rawBids, rawAsks, grouping]);

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

  // True best bid/ask from the ungrouped book (raw arrays arrive best-first
  // from the API, but sort defensively since WS/REST snapshots may vary).
  const bestBid = useMemo(() => rawBids.reduce<number>((m, [p]) => Math.max(m, p), 0), [rawBids]);
  const bestAsk = useMemo(() => rawAsks.reduce<number>((m, [p]) => (m === 0 ? p : Math.min(m, p)), 0), [rawAsks]);

  const spread = useMemo(() => {
    if (bestBid > 0 && bestAsk > 0) return Math.max(0, bestAsk - bestBid);
    return 0;
  }, [bestBid, bestAsk]);

  const midPrice = useMemo(() => {
    if (bestBid > 0 && bestAsk > 0) return (bestBid + bestAsk) / 2;
    return bestBid || bestAsk || 0;
  }, [bestBid, bestAsk]);

  // Tick-direction flash on the mid price (green uptick / red downtick),
  // the standard pro-terminal cue that the market just moved.
  const prevMidRef = useRef(0);
  const [midDir, setMidDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (!midPrice) return;
    const prev = prevMidRef.current;
    prevMidRef.current = midPrice;
    if (!prev || midPrice === prev) return;
    setMidDir(midPrice > prev ? 'up' : 'down');
    const timer = setTimeout(() => setMidDir(null), 700);
    return () => clearTimeout(timer);
  }, [midPrice]);

  const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

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
                <span className={cn(
                  'text-[15px] font-bold font-mono tabular-nums tracking-tight transition-colors duration-300',
                  midDir === 'up' ? 'text-green' : midDir === 'down' ? 'text-red' : 'text-foreground'
                )}>
                  {midPrice ? formatPrice(midPrice) : '—'}
                </span>
                <span className="text-[10px] text-muted font-mono px-1.5 py-0.5 rounded bg-surface-3/80 border border-border-subtle">
                  spread {formatPrice(spread)}{spreadPct > 0 ? ` · ${spreadPct < 0.01 ? '<0.01' : spreadPct.toFixed(2)}%` : ''}
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
            {(tradeFilter === 'all' ? recentTrades : recentTrades.filter((tr) => tr.side === tradeFilter)).length > 0
              ? (tradeFilter === 'all' ? recentTrades : recentTrades.filter((tr) => tr.side === tradeFilter)).map((t, i) => {
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
            <button
              onClick={() => setTradeFilter((f) => (f === 'all' ? 'buy' : f === 'buy' ? 'sell' : 'all'))}
              className={cn(
                'text-[10px] transition-colors flex items-center gap-1 px-1.5 py-0.5 rounded',
                tradeFilter === 'all' ? 'text-dim hover:text-muted' : tradeFilter === 'buy' ? 'text-green bg-green/10' : 'text-red bg-red/10'
              )}
              title="Cycle trade filter: all → buys → sells"
            >
              {tradeFilter === 'all' ? 'All trades' : tradeFilter === 'buy' ? 'Buys only' : 'Sells only'}
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
