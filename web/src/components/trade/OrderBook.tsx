'use client';
import { useEffect, useState, useMemo, useRef } from 'react';
import { useStore } from '@/stores/useStore';
import { api, type Trade } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { startPoll } from '@/lib/poll';
import { useMarketTick } from '@/hooks/useMarketTick';
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
  // Display grouping in quote units. The finest bucket is the market's tick
  // (tickSize ÷ priceScale — $0.01 on MRSN/SOL/ARB after the rescale, $10 on
  // BTC); the options scale up from there so a coarse view is one click away.
  const { tick, decimals: tickDecimals } = useMarketTick(market);
  const [grouping, setGrouping] = useState(1);
  useEffect(() => { setGrouping(tick); }, [tick]);
  const groupings = useMemo(() => [1, 5, 10, 50, 100].map((m) => m * tick), [tick]);
  const fmtGroup = (g: number) => (g >= 1 ? String(Math.round(g * 100) / 100) : g.toFixed(tickDecimals));
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<BookTab>('book');
  const [recentTrades, setRecentTrades] = useState<Trade[]>([]);
  const [tradeFilter, setTradeFilter] = useState<'all' | 'buy' | 'sell'>('all');
  // Size column units: base asset or USD notional (CEX-standard toggle).
  const [sizeUnit, setSizeUnit] = useState<'base' | 'usd'>('base');
  const [showGrouping, setShowGrouping] = useState(false);
  const groupingRef = useRef<HTMLDivElement>(null);

  // Close the grouping dropdown on outside click.
  useEffect(() => {
    if (!showGrouping) return;
    const handler = (e: MouseEvent) => {
      if (groupingRef.current && !groupingRef.current.contains(e.target as Node)) setShowGrouping(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showGrouping]);
  // VWAP hover preview: hovering a book level shows the average fill price,
  // cumulative size and price impact of sweeping the book up to that level.
  const [hoverPreview, setHoverPreview] = useState<{
    top: number; side: 'buy' | 'sell'; size: number; vwap: number; impact: number;
  } | null>(null);

  const previewFor = (levels: BookLevel[], idx: number, side: 'buy' | 'sell', el: HTMLElement) => {
    const slice = levels.slice(0, idx + 1);
    const size = slice.reduce((s, l) => s + l.size, 0);
    if (size <= 0) return;
    const vwap = slice.reduce((s, l) => s + l.price * l.size, 0) / size;
    const best = side === 'buy' ? asks[0]?.price : bids[0]?.price;
    const impact = best ? (Math.abs(vwap - best) / best) * 100 : 0;
    setHoverPreview({ top: el.offsetTop, side, size, vwap, impact });
  };
  // Monotonic clock for snapshot ordering: the 3s REST poll and the WS
  // broadcast are independent snapshots of the same book, and without an
  // ordering check a stale WS payload can overwrite a fresher REST one (or
  // vice versa), briefly showing a crossed book (ask < bid) that never
  // existed on chain.
  const lastBookTs = useRef(0);

  function applyBook(newBids: [number, number][] | undefined, newAsks: [number, number][] | undefined, ts: number) {
    if (ts < lastBookTs.current) return; // stale snapshot — keep the fresher one
    lastBookTs.current = ts;
    // A payload carrying only one side merges with the current other side
    // instead of wiping it.
    if (newBids) setRawBids(newBids.filter(([p]) => p > 0));
    if (newAsks) setRawAsks(newAsks.filter(([p]) => p > 0));
  }

  // Reset on market switch during render (the React-endorsed adjust-state-
  // during-render pattern) so the previous market's prices never flash.
  const [prevMarketId, setPrevMarketId] = useState(market.id);
  if (prevMarketId !== market.id) {
    setPrevMarketId(market.id);
    setLoading(true);
    setRawBids([]);
    setRawAsks([]);
  }

  useEffect(() => {
    let mounted = true;
    // Fresh market => accept the next snapshot regardless of its timestamp.
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
    // payloads are dropped). The REST poll only runs as a fallback while the
    // socket is down — jittered + backoff so a WS outage across many open
    // tabs doesn't stampede the API (see lib/poll.ts).
    const stopPoll = connected ? null : startPoll(fetchBook, 3000);

    const unsub = subscribe(`orderbook:${market.id}`, (data: unknown) => {
      const d = data as { bids?: [number, number][]; asks?: [number, number][]; timestamp?: number };
      if (!d.bids && !d.asks) return;
      applyBook(d.bids, d.asks, d.timestamp || Date.now());
    });

    return () => { mounted = false; stopPoll?.(); unsub(); };
     
  }, [market.id, subscribe, connected]);

  // Grouped display rows. Bids round DOWN into their bucket, asks round UP —
  // the convention Hyperliquid/Binance use — so a coarse grouping can never
  // render a locked or crossed book (floor/floor collapses both sides into
  // the same bucket whenever the true spread is tighter than the grouping).
  const { bids, asks } = useMemo(() => {
    const processLevels = (levels: [number, number][], isAsk: boolean): BookLevel[] => {
      // Bucket in integer multiples of the grouping (with a tiny epsilon so
      // 115.37 / 0.01 does not floor to 11536 through float error), then map
      // back to a price rounded to the tick's decimals so keys dedupe.
      const grouped = new Map<number, number>();
      const decimals = Math.max(tickDecimals, grouping < 1 ? Math.ceil(-Math.log10(grouping)) : 0);
      for (const [p, s] of levels) {
        const q = p / grouping;
        const n = isAsk ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9);
        const key = Number((n * grouping).toFixed(decimals));
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
    <div className="relative bg-surface border border-border rounded-xl md:border-0 md:rounded-none overflow-hidden h-full flex flex-col">
      {/* VWAP hover preview chip — floats at the right edge of the hovered row */}
      {hoverPreview && activeTab === 'book' && (
        <div
          className="absolute right-2 z-20 pointer-events-none px-2 py-1 rounded-md bg-background/95 border border-border shadow-xl text-[10px] font-mono whitespace-nowrap"
          style={{ top: hoverPreview.top }}
        >
          <span className={hoverPreview.side === 'buy' ? 'text-red' : 'text-green'}>
            {hoverPreview.side === 'buy' ? 'Buy' : 'Sell'} {formatNumber(hoverPreview.size, 2)}
          </span>
          <span className="text-dim"> @ avg </span>
          <span className="text-foreground">{formatPrice(hoverPreview.vwap)}</span>
          <span className="text-dim"> · impact </span>
          <span className={hoverPreview.impact > 1 ? 'text-yellow' : 'text-foreground'}>
            {hoverPreview.impact < 0.01 ? '<0.01' : hoverPreview.impact.toFixed(2)}%
          </span>
        </div>
      )}
      {/* Header: Book/Trades tabs + grouping */}
      <div className="flex items-center justify-between px-3 py-0 border-b border-border shrink-0">
        <div className="flex items-center gap-0">
          {/* "Book" not "Order Book": the panel is a fixed 220px and the long
              label forced a wrap that overlapped the unit/grouping chips. */}
          <button onClick={() => setActiveTab('book')} className={cn(
            'px-2.5 py-[7px] text-[10px] font-bold uppercase tracking-[0.16em] transition-colors whitespace-nowrap',
            activeTab === 'book' ? 'bg-[var(--primary-dim)] text-primary-bright' : 'text-dim hover:text-muted'
          )}>Book</button>
          <button onClick={() => setActiveTab('trades')} className={cn(
            'px-2.5 py-[7px] text-[10px] font-bold uppercase tracking-[0.16em] transition-colors whitespace-nowrap',
            activeTab === 'trades' ? 'bg-[var(--primary-dim)] text-primary-bright' : 'text-dim hover:text-muted'
          )}>Trades</button>
        </div>
        {activeTab === 'book' && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSizeUnit((u) => (u === 'base' ? 'usd' : 'base'))}
              title="Toggle size units: base asset vs USD notional"
              className="bg-surface-2 text-dim hover:text-foreground text-[10px] px-1.5 py-0.5 rounded border border-border transition-colors font-mono"
            >{sizeUnit === 'base' ? market.base : 'USD'}</button>
            {/* Styled grouping dropdown (the native <select> rendered with
                dated OS chrome, ugliest on Windows) */}
            <div className="relative" ref={groupingRef}>
              <button
                onClick={() => setShowGrouping((v) => !v)}
                aria-label={`Price grouping: ${fmtGroup(grouping)}`}
                aria-expanded={showGrouping}
                className="bg-surface-2 text-foreground text-[11px] px-2 py-0.5 rounded border border-border hover:border-primary/40 transition-colors font-mono flex items-center gap-1"
              >
                {fmtGroup(grouping)}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className={cn('text-dim transition-transform', showGrouping && 'rotate-180')}><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {showGrouping && (
                <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 py-1 min-w-[72px]">
                  {groupings.map((g) => (
                    <button
                      key={g}
                      onClick={() => { setGrouping(g); setShowGrouping(false); }}
                      className={cn(
                        'block w-full text-right px-3 py-1.5 text-[11px] font-mono transition-colors',
                        g === grouping ? 'text-primary bg-primary/10' : 'text-foreground hover:bg-surface-2'
                      )}
                    >{fmtGroup(g)}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {activeTab === 'book' ? (
        <>
          <div className="grid grid-cols-3 px-3 py-1.5 text-[10px] text-dim uppercase tracking-wider border-b border-border shrink-0">
            <span>Price</span>
            <span className="text-right">Size{sizeUnit === 'usd' ? ' $' : ''}</span>
            <span className="text-right">Total{sizeUnit === 'usd' ? ' $' : ''}</span>
          </div>

          {loading && bids.length === 0 && asks.length === 0 ? (
            <div className="flex-1 min-h-0 overflow-hidden">
              <SkeletonRows rows={8} />
            </div>
          ) : bids.length === 0 && asks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                label="Book is empty"
                hint="No resting orders. Be the first maker — maker fills earn the rebate tier."
                action={
                  <button
                    onClick={() => {
                      // Focus the order form's price field so the user can seed
                      // the book in two keystrokes.
                      const form = document.querySelector('[data-trade-form]');
                      const priceInput = form?.querySelector<HTMLInputElement>('input[type=number]');
                      priceInput?.focus();
                    }}
                    className="mt-1 px-3 py-1.5 bg-primary/10 text-primary border border-primary/25 rounded-md text-[11px] font-semibold hover:bg-primary/20 transition-colors"
                  >
                    Place a limit order
                  </button>
                }
              />
            </div>
          ) : (
            // justify-center + content-sized sides: a sparse book renders as a
            // compact ladder centered on the spread instead of leaving a huge
            // void above the asks; dense sides still cap at half the panel.
            <div className="flex-1 overflow-hidden flex flex-col justify-center min-h-0">
              {asks.length === 0 && (
                <div className="py-4 text-center text-[10px] text-dim">
                  No asks resting — sells fill instantly
                </div>
              )}
              <div className="overflow-y-auto flex flex-col-reverse min-h-0 max-h-[calc(50%-20px)]">
                {asks.map((level, i) => (
                  <div
                    key={`a-${i}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${formatPrice(level.price)} ${sizeUnit === 'usd' ? formatNumber(level.size * level.price, 0) : formatNumber(level.size, 0)} ${sizeUnit === 'usd' ? formatNumber(level.total * level.price, 0) : formatNumber(level.total, 0)} — set price ${formatPrice(level.price)} (buy side)`}
                    className="relative grid grid-cols-3 px-3 py-[4px] text-xs cursor-pointer hover:bg-red/8 font-mono transition-colors outline-none focus-visible:bg-red/12"
                    onMouseEnter={(e) => previewFor(asks, i, 'buy', e.currentTarget as HTMLElement)}
                    onMouseLeave={() => setHoverPreview(null)}
                    onClick={() => setTrade({ price: level.price.toString(), side: 'buy' })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTrade({ price: level.price.toString(), side: 'buy' }); } }}
                  >
                    <div className="absolute inset-y-0 right-0 bg-red/[0.10]" style={{ width: `${level.pct}%` }} />
                    <span className="relative text-red font-semibold tabular-nums">{formatPrice(level.price)}</span>
                    <span className="relative text-right text-foreground/70 tabular-nums">{sizeUnit === 'usd' ? formatNumber(level.size * level.price, 0) : formatNumber(level.size, 0)}</span>
                    <span className="relative text-right text-dim tabular-nums">{sizeUnit === 'usd' ? formatNumber(level.total * level.price, 0) : formatNumber(level.total, 0)}</span>
                  </div>
                ))}
              </div>

              <div className="px-3 py-2 border-y border-border bg-surface-2/60 flex items-center justify-between shrink-0">
                <span className={cn(
                  'text-[16px] font-extrabold font-mono tabular-nums tracking-tight transition-colors duration-300 crt-glow',
                  midDir === 'up' ? 'text-green' : midDir === 'down' ? 'text-red' : 'text-primary-bright'
                )}>
                  {midPrice ? formatPrice(midPrice) : '—'}
                </span>
                <span className="text-[10px] text-muted font-mono px-1.5 py-0.5 rounded bg-surface-3/80 border border-border-subtle">
                  spread {formatPrice(spread)}{spreadPct > 0 ? ` · ${spreadPct < 0.01 ? '<0.01' : spreadPct.toFixed(2)}%` : ''}
                </span>
              </div>

              {bids.length === 0 && (
                <div className="py-4 text-center text-[10px] text-dim">
                  No bids resting — buys fill instantly
                </div>
              )}
              <div className="overflow-y-auto min-h-0 max-h-[calc(50%-20px)]">
                {bids.map((level, i) => (
                  <div
                    key={`b-${i}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${formatPrice(level.price)} ${sizeUnit === 'usd' ? formatNumber(level.size * level.price, 0) : formatNumber(level.size, 0)} ${sizeUnit === 'usd' ? formatNumber(level.total * level.price, 0) : formatNumber(level.total, 0)} — set price ${formatPrice(level.price)} (sell side)`}
                    className="relative grid grid-cols-3 px-3 py-[4px] text-xs cursor-pointer hover:bg-green/8 font-mono transition-colors outline-none focus-visible:bg-green/12"
                    onMouseEnter={(e) => previewFor(bids, i, 'sell', e.currentTarget as HTMLElement)}
                    onMouseLeave={() => setHoverPreview(null)}
                    onClick={() => setTrade({ price: level.price.toString(), side: 'sell' })}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTrade({ price: level.price.toString(), side: 'sell' }); } }}
                  >
                    <div className="absolute inset-y-0 right-0 bg-green/[0.10]" style={{ width: `${level.pct}%` }} />
                    <span className="relative text-green font-semibold tabular-nums">{formatPrice(level.price)}</span>
                    <span className="relative text-right text-foreground/70 tabular-nums">{sizeUnit === 'usd' ? formatNumber(level.size * level.price, 0) : formatNumber(level.size, 0)}</span>
                    <span className="relative text-right text-dim tabular-nums">{sizeUnit === 'usd' ? formatNumber(level.total * level.price, 0) : formatNumber(level.total, 0)}</span>
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
              // Whale flash: large-notional fills stand out in the tape.
              const isWhale = Number(t.price) * Number(t.size) >= 25_000;
              return (
                <div key={t.id || i} className={cn(
                  'grid grid-cols-3 px-3 py-[3px] text-[11px] font-mono hover:bg-surface-2/50 transition-colors group',
                  isWhale && 'bg-yellow/[0.06] border-l-2 border-yellow/50'
                )}>
                  <span className={cn('tabular-nums flex items-center gap-1', color)}>
                    {formatPrice(t.price)}
                    {isWhale && <span className="text-[8px] font-bold text-yellow uppercase tracking-wide">whale</span>}
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
