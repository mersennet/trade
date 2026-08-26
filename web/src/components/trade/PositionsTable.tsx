'use client';
import { Fragment, useEffect, useState } from 'react';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { api, type Trade, type Order, type FundingRate } from '@/lib/api';
import { formatPrice, formatNumber, cn } from '@/lib/utils';
import { useToast } from '@/components/shared/Toast';
import EmptyState, { SkeletonRows } from '@/components/shared/EmptyState';
import { playSound } from '@/lib/sounds';
import { useStore as useAppStore } from '@/stores/useStore';

type Tab = 'positions' | 'orders' | 'trades' | 'funding' | 'history';

export default function PositionsTable() {
  const { market, positions, orders, setPositions, setOrders, tickers, pendingOrders, removePendingOrder } = useStore();
  const { address, isConnected, connect, provider } = useWallet();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('positions');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [fundingHistory, setFundingHistory] = useState<FundingRate[]>([]);
  const [orderHistory, setOrderHistory] = useState<Order[]>([]);
  const [hideOtherSymbols, setHideOtherSymbols] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Inline TP/SL editor state. Brackets are CLIENT-SIDE (local store) and
  // executed by the useBrackets watcher while the session is open — the chain
  // has no server-side auto-execution since the auth hardening.
  const [tpslEditFor, setTpslEditFor] = useState<number | null>(null);
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [tpslSaving, setTpslSaving] = useState(false);
  const brackets = useStore((s) => s.brackets);
  const setBracket = useStore((s) => s.setBracket);
  const removeBracket = useStore((s) => s.removeBracket);

  // Reset the loading skeleton when the wallet disconnects (render-time
  // adjust, not an effect setState).
  const [prevConnected, setPrevConnected] = useState(isConnected);
  if (prevConnected !== isConnected) {
    setPrevConnected(isConnected);
    if (!isConnected) setLoading(false);
  }

  useEffect(() => {
    if (!isConnected || !address) return;
    const fetchData = async () => {
      try {
        const [posRes, ordRes] = await Promise.all([
          api.getPositions(address),
          api.getOrders(address),
        ]);
        setPositions(posRes.positions || []);
        setOrders(ordRes.orders || []);
      } catch (e) {
        console.error('[positions] fetch error:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [address, isConnected, setPositions, setOrders]);

  useEffect(() => {
    api.getTrades(market.id, 30).then((r) => setTrades(r.trades || [])).catch((e) => console.error('[trades] fetch error:', e));
    api.getFundingHistory(market.id).then((r) => setFundingHistory(r.rates || [])).catch(() => {});
  }, [market.id]);

  useEffect(() => {
    if (!address) return;
    api.getOrderHistory(address, 50).then((r) => setOrderHistory(r.orders || [])).catch(() => {});
  }, [address]);

  const handleCancel = async (orderId: number) => {
    setCancellingId(orderId);
    try {
      // Cancels are wallet-signed txs to the CLOB precompile; the chain
      // enforces that the signer owns the order (no server-side owner trust).
      const { cancelOrderOnChain } = await import('@/lib/orderSigning');
      await cancelOrderOnChain(provider, orderId);
      toast('Order cancelled', 'success');
      if (useAppStore.getState().soundEnabled) playSound('cancel');
      if (address) {
        const res = await api.getOrders(address);
        setOrders(res.orders);
      }
    } catch (e) {
      toast(`Cancel failed: ${(e as Error).message}`, 'error');
    } finally {
      setCancellingId(null);
    }
  };

  // The position's bracket = the local store entry for this wallet+market.
  const bracketFor = (marketId: number) =>
    address ? brackets.find((b) => b.owner.toLowerCase() === address.toLowerCase() && b.marketId === marketId) : undefined;

  const handleSetTpsl = async (pos: { marketId: number; symbol: string; size: number | string }) => {
    if (!address) return;
    const size = Math.abs(Number(pos.size));
    const isLong = Number(pos.size) > 0;
    const tp = parseFloat(tpInput);
    const sl = parseFloat(slInput);
    if (!tp && !sl) { toast('Enter a TP or SL price', 'error'); return; }
    setTpslSaving(true);
    try {
      const mark = tickers[pos.marketId]?.markPrice || 0;
      if (mark > 0) {
        // Sanity-check trigger sides so a typo doesn't arm an instant-firing
        // bracket. Long TP is above mark, SL below; short is the mirror.
        if (tp && (isLong ? tp < mark : tp > mark)) {
          toast(`TP ${tp} is on the wrong side of mark (${formatPrice(mark)}) for a ${isLong ? 'long' : 'short'}`, 'error');
          return;
        }
        if (sl && (isLong ? sl > mark : sl < mark)) {
          toast(`SL ${sl} is on the wrong side of mark (${formatPrice(mark)}) for a ${isLong ? 'long' : 'short'}`, 'error');
          return;
        }
      }
      setBracket({
        id: `${address.toLowerCase()}-${pos.marketId}`,
        owner: address,
        marketId: pos.marketId,
        isLong,
        size: String(size),
        tp: tp ? String(tp) : null,
        sl: sl ? String(sl) : null,
        ts: Date.now(),
      });
      toast(`Bracket set on ${pos.symbol} — executes while this session is open`, 'success');
      setTpslEditFor(null);
      setTpInput('');
      setSlInput('');
    } finally {
      setTpslSaving(false);
    }
  };

  const handleCancelAll = async () => {
    if (!address) return;
    try {
      // Each cancel is a wallet-signed tx (the chain checks ownership), so
      // cancel-all signs every open order in turn rather than asking the API
      // to cancel on the user's behalf.
      const { cancelOrderOnChain } = await import('@/lib/orderSigning');
      const open = (await api.getOrders(address)).orders || [];
      if (open.length === 0) { toast('No open orders', 'info'); return; }
      let ok = 0;
      for (const o of open) {
        const oid = (o as { order_id?: number; id?: number }).order_id ?? (o as { id?: number }).id;
        if (oid == null) continue;
        try { await cancelOrderOnChain(provider, oid); ok++; } catch { /* skip failures */ }
      }
      toast(`Cancelled ${ok} of ${open.length} orders`, ok > 0 ? 'success' : 'error');
      if (ok > 0 && useAppStore.getState().soundEnabled) playSound('cancel');
      const res = await api.getOrders(address);
      setOrders(res.orders);
    } catch (e) {
      toast(`Cancel all failed: ${(e as Error).message}`, 'error');
    }
  };

  const handleClosePosition = async (pos: typeof positions[0], fraction = 1) => {
    if (!address) return;
    const fullSize = Math.abs(Number(pos.size));
    // Integer chain units: a fractional close rounds down and must leave at
    // least 1 unit behind (or close fully instead).
    const size = fraction >= 1 ? fullSize : Math.max(0, Math.floor(fullSize * fraction));
    if (size <= 0) { toast('Position too small to partially close', 'info'); return; }
    const side = Number(pos.size) > 0 ? 'Sell' : 'Buy';
    const mark = tickers[pos.marketId]?.markPrice || 0;
    try {
      // Signed IOC order to the precompile closes the position (reduce-only is
      // implicit: an opposing IOC order nets the existing position down). Price
      // it *through* the live book by ≥1 tick, bounded by slippage — pricing off
      // mark ± slippage and rounding to an integer tick silently no-fills on
      // integer-tick markets, leaving the position open despite a success toast.
      const { placeOrderOnChain, marketableLimitPrice } = await import('@/lib/orderSigning');
      const priceForClose = await marketableLimitPrice(
        pos.marketId,
        side === 'Buy',
        useAppStore.getState().slippage || 1,
        mark,
      );
      await placeOrderOnChain(provider, {
        marketId: pos.marketId,
        isBuy: side === 'Buy',
        priceUsd: priceForClose,
        sizeBase: size.toString(),
        tif: 'Ioc',
      });
      toast(fraction >= 1 ? `Closing ${pos.symbol} position` : `Closing ${Math.round(fraction * 100)}% of ${pos.symbol}`, 'success');
      if (useAppStore.getState().soundEnabled) playSound('fill');
    } catch (e) {
      toast(`Close failed: ${(e as Error).message}`, 'error');
    }
  };

  const filteredPositions = hideOtherSymbols
    ? positions.filter((p) => p.marketId === market.id)
    : positions;

  const filteredOrders = hideOtherSymbols
    ? orders.filter((o) => o.market_id === market.id)
    : orders;

  // Optimistic pending orders: show this wallet's just-submitted orders
  // instantly; drop each once the API's real order list catches up (matched by
  // market+side+price+size) or once it is stale beyond a block or two (filled,
  // failed, or replaced — the truthful-outcome toast covers those cases).
  useEffect(() => {
    if (!address || pendingOrders.length === 0) return;
    const realKeys = new Set(
      orders.map((o) => `${o.market_id}|${(o.side || '').toLowerCase()}|${Number(o.price)}|${Number(o.size)}`)
    );
    for (const p of pendingOrders) {
      const key = `${p.market_id}|${p.side}|${Number(p.price)}|${Number(p.size)}`;
      if (realKeys.has(key) || Date.now() - p.ts > 45_000) removePendingOrder(p.tempId);
    }
  }, [orders, pendingOrders, address, removePendingOrder]);

  const visiblePending = pendingOrders.filter(
    (p) => address && p.owner.toLowerCase() === address.toLowerCase() && (!hideOtherSymbols || p.market_id === market.id)
  );

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'positions', label: 'Positions', count: filteredPositions.length },
    { key: 'orders', label: 'Orders', count: filteredOrders.length },
    { key: 'trades', label: 'Trades' },
    { key: 'funding', label: 'Funding' },
    { key: 'history', label: 'History' },
  ];

  return (
    <div className="bg-surface border border-border rounded-xl md:border-0 md:rounded-none overflow-hidden flex flex-col h-full">
      <div className="flex items-center border-b border-border shrink-0">
        <div className="flex flex-1 overflow-x-auto scrollbar-none">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'px-2.5 md:px-3 py-2.5 text-[11px] md:text-xs font-medium transition-all duration-200 whitespace-nowrap shrink-0',
                tab === t.key ? 'text-foreground border-b-2 border-primary' : 'text-dim hover:text-muted'
              )}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-primary/10 text-primary rounded-full text-[9px] font-semibold">{t.count}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0 mr-2">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={hideOtherSymbols} onChange={(e) => setHideOtherSymbols(e.target.checked)} className="accent-primary w-3 h-3 rounded" />
            <span className="text-[10px] text-dim whitespace-nowrap">Current Only</span>
          </label>
          {tab === 'orders' && filteredOrders.length > 0 && (
            <button onClick={handleCancelAll} className="text-[10px] text-red hover:text-red/80 font-medium transition-colors whitespace-nowrap">
              Cancel All
            </button>
          )}
          {tab === 'trades' && address && (
            <button onClick={() => api.exportTrades(address)} className="text-[10px] text-primary hover:text-primary-hover font-medium transition-colors whitespace-nowrap">
              Export
            </button>
          )}
          {tab === 'history' && address && (
            <button onClick={() => api.exportOrders(address)} className="text-[10px] text-primary hover:text-primary-hover font-medium transition-colors whitespace-nowrap">
              Export
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'positions' && (
          loading ? (
            <SkeletonRows rows={3} />
          ) : filteredPositions.length > 0 ? (
            <table className="w-full text-xs">
              <thead><tr className="text-dim text-[10px] border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Market</th>
                <th className="text-right px-2 py-2 font-medium">Size</th>
                <th className="text-right px-2 py-2 font-medium">Entry</th>
                <th className="text-right px-2 py-2 font-medium">Mark</th>
                <th className="text-right px-2 py-2 font-medium">uPnL</th>
                <th className="text-right px-2 py-2 font-medium">Liq.</th>
                <th className="text-right px-2 py-2 font-medium">TP/SL</th>
                <th className="text-right px-2 py-2 font-medium"></th>
              </tr></thead>
              <tbody>
                {filteredPositions.map((p, i) => {
                  const size = Number(p.size);
                  const entry = Number(p.entryPrice);
                  const mark = p.markPrice || entry;
                  const pnl = p.unrealizedPnl || 0;
                  const liq = p.liquidationPrice || 0;
                  return (
                    <Fragment key={p.marketId ?? i}>
                    <tr className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
                      <td className="px-3 py-2.5">
                        <span className="text-foreground font-semibold">{p.symbol}</span>
                        <span className={cn('ml-1.5 text-[10px] font-medium', size > 0 ? 'text-green' : 'text-red')}>
                          {size > 0 ? 'LONG' : 'SHORT'}
                        </span>
                        {p.leverage && <span className="ml-1 text-[10px] text-dim">{p.leverage}x</span>}
                      </td>
                      <td className={cn('px-2 py-2.5 text-right font-mono tabular-nums', size > 0 ? 'text-green' : 'text-red')}>
                        {formatNumber(Math.abs(size), 4)}
                      </td>
                      <td className="px-2 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{formatPrice(entry)}</td>
                      <td className="px-2 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{formatPrice(mark)}</td>
                      <td className={cn('px-2 py-2.5 text-right font-mono tabular-nums font-semibold', pnl >= 0 ? 'text-green' : 'text-red')}>
                        {pnl >= 0 ? '+' : ''}{formatNumber(pnl, 2)}
                      </td>
                      <td className="px-2 py-2.5 text-right text-yellow/70 font-mono tabular-nums text-[11px]">
                        {liq > 0 ? formatPrice(liq) : '—'}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        {(() => {
                          const br = bracketFor(p.marketId);
                          if (!br) {
                            return (
                              <button
                                onClick={() => { setTpslEditFor(tpslEditFor === p.marketId ? null : p.marketId); setTpInput(''); setSlInput(''); }}
                                className="px-2 py-1 text-[10px] font-medium text-dim hover:text-primary border border-border rounded-md hover:border-primary/40 transition-colors"
                              >+ Add</button>
                            );
                          }
                          return (
                            <div className="flex items-center gap-1 justify-end flex-wrap">
                              {br.tp && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-green/10 text-green">
                                  TP {formatPrice(Number(br.tp))}
                                </span>
                              )}
                              {br.sl && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-red/10 text-red">
                                  SL {formatPrice(Number(br.sl))}
                                </span>
                              )}
                              <button
                                onClick={() => { setTpslEditFor(tpslEditFor === p.marketId ? null : p.marketId); setTpInput(br.tp || ''); setSlInput(br.sl || ''); }}
                                className="px-1.5 py-0.5 text-[10px] text-dim hover:text-primary transition-colors"
                              >Edit</button>
                              <button
                                onClick={() => removeBracket(br.id)}
                                aria-label="Remove bracket"
                                className="px-1 py-0.5 text-[10px] text-dim hover:text-red transition-colors"
                              >×</button>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            onClick={async () => {
                              // Branded PnL card (PNG download) — every shared
                              // screenshot carries Mersennet branding.
                              try {
                                const { downloadShareCard } = await import('@/lib/shareCard');
                                const pnlPct = entry > 0 ? ((mark - entry) / entry) * 100 * (size >= 0 ? 1 : -1) * (p.leverage || 1) : 0;
                                await downloadShareCard({
                                  symbol: p.symbol,
                                  isLong: size >= 0,
                                  leverage: p.leverage,
                                  entryPrice: entry,
                                  markPrice: mark,
                                  pnl,
                                  pnlPct,
                                });
                                toast('Share card downloaded', 'success');
                              } catch {
                                // Fallback: plain text to clipboard.
                                const text = `${size >= 0 ? 'Long' : 'Short'} ${p.symbol} | Entry: $${formatPrice(entry)} | PnL: ${pnl >= 0 ? '+' : ''}${formatNumber(pnl, 2)} | Mersennet Trade`;
                                navigator.clipboard.writeText(text);
                                toast('Trade copied to clipboard', 'info');
                              }
                            }}
                            className="px-1.5 py-1 text-[10px] text-dim hover:text-primary transition-colors rounded"
                            title="Download shareable PnL card"
                            aria-label={`Share ${p.symbol} trade as image`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                          </button>
                          <div className="flex items-center gap-0.5 justify-end">
                            {[0.25, 0.5, 1].map((f) => (
                              <button
                                key={f}
                                onClick={() => handleClosePosition(p, f)}
                                title={f === 1 ? 'Close entire position' : `Close ${f * 100}% of the position`}
                                className="px-1.5 py-1 text-[9px] font-medium text-dim hover:text-foreground bg-surface-2 rounded border border-border hover:border-foreground/20 transition-colors"
                              >{f === 1 ? '100' : `${f * 100}`}%</button>
                            ))}
                          </div>
                          <button
                            onClick={() => handleClosePosition(p)}
                            className="px-2.5 py-1 text-[10px] font-medium bg-red/10 text-red rounded-md hover:bg-red/20 transition-colors"
                          >Close</button>
                        </div>
                      </td>
                    </tr>
                    {tpslEditFor === p.marketId && (
                      <tr className="border-b border-border/30 bg-surface-2/40">
                        <td colSpan={8} className="px-3 py-2.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] text-dim uppercase tracking-wider font-medium">Bracket for {p.symbol}</span>
                            <input
                              type="number" value={tpInput} onChange={(e) => setTpInput(e.target.value)}
                              placeholder={size > 0 ? 'TP above mark' : 'TP below mark'}
                              aria-label="Take-profit trigger price"
                              className="w-32 bg-surface border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-green/40"
                            />
                            <input
                              type="number" value={slInput} onChange={(e) => setSlInput(e.target.value)}
                              placeholder={size > 0 ? 'SL below mark' : 'SL above mark'}
                              aria-label="Stop-loss trigger price"
                              className="w-32 bg-surface border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground font-mono outline-none focus:border-red/40"
                            />
                            <button
                              onClick={() => handleSetTpsl(p)}
                              disabled={tpslSaving}
                              className="px-3 py-1.5 bg-primary text-black rounded-md text-[11px] font-semibold hover:brightness-110 disabled:opacity-50 transition-all"
                            >{tpslSaving ? 'Saving…' : 'Set bracket'}</button>
                            <button
                              onClick={() => setTpslEditFor(null)}
                              className="px-2 py-1.5 text-[11px] text-dim hover:text-foreground transition-colors"
                            >Cancel</button>
                            <span className="text-[9.5px] text-dim">Closing orders only — fires while this session is open (instant with one-click trading).</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <EmptyState
              label="No open positions"
              hint={isConnected ? 'Place your first order to open a position' : 'Connect a wallet to track live P&L, margin, and funding'}
              action={!isConnected ? (
                <button
                  onClick={() => { connect().catch(() => {}); }}
                  className="px-4 h-7 premium-gradient text-black rounded-lg text-[11px] font-semibold transition-all hover:brightness-110"
                >
                  Connect Wallet
                </button>
              ) : undefined}
            />
          )
        )}

        {tab === 'orders' && (
          (filteredOrders.length > 0 || visiblePending.length > 0) ? (
            <table className="w-full text-xs">
              <thead><tr className="text-dim text-[10px] border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Side</th>
                <th className="text-right px-2 py-2 font-medium">Price</th>
                <th className="text-right px-2 py-2 font-medium">Size</th>
                <th className="text-right px-2 py-2 font-medium">TIF</th>
                <th className="text-right px-2 py-2 font-medium"></th>
              </tr></thead>
              <tbody>
                {visiblePending.map((p) => (
                  <tr key={p.tempId} className="border-b border-border/30 bg-primary/[0.04]">
                    <td className={cn('px-3 py-2.5 font-semibold', p.side === 'buy' ? 'text-green' : 'text-red')}>
                      {p.side === 'buy' ? 'Buy' : 'Sell'}
                    </td>
                    <td className="px-2 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{p.price}</td>
                    <td className="px-2 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{p.size}</td>
                    <td className="px-2 py-2.5 text-right text-dim text-[10px]">{p.tif.toUpperCase()}</td>
                    <td className="px-2 py-2.5 text-right">
                      <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-yellow/10 text-yellow rounded-md">
                        <span className="w-1.5 h-1.5 rounded-full bg-yellow animate-pulse" />
                        Pending
                      </span>
                    </td>
                  </tr>
                ))}
                {filteredOrders.map((o, i) => {
                  const id = o.order_id || o.id || i;
                  return (
                    <tr key={i} className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
                      <td className={cn('px-3 py-2.5 font-semibold', o.side?.toLowerCase() === 'buy' ? 'text-green' : 'text-red')}>
                        {o.side}
                      </td>
                      <td className="px-2 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{o.price}</td>
                      <td className="px-2 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{o.size}</td>
                      <td className="px-2 py-2.5 text-right text-dim text-[10px]">{o.tif || 'GTC'}</td>
                      <td className="px-2 py-2.5 text-right">
                        <button
                          onClick={() => handleCancel(id as number)}
                          disabled={cancellingId === id}
                          className="px-2.5 py-1 text-[10px] font-medium bg-red/10 text-red rounded-md hover:bg-red/20 transition-colors disabled:opacity-40"
                        >{cancellingId === id ? '...' : 'Cancel'}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <EmptyState
              label="No open orders"
              hint="Resting limit orders will appear here"
            />
          )
        )}

        {tab === 'trades' && (
          trades.length > 0 ? (
            <table className="w-full text-xs">
              <thead><tr className="text-dim text-[10px] border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Price</th>
                <th className="text-right px-2 py-2 font-medium">Size</th>
                <th className="text-right px-2 py-2 font-medium">Time</th>
              </tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
                    <td className={cn('px-3 py-2 font-mono tabular-nums', t.side === 'buy' ? 'text-green' : 'text-red')}>
                      {formatPrice(t.price)}
                    </td>
                    <td className="px-2 py-2 text-right text-foreground/70 font-mono tabular-nums">{formatNumber(t.size, 4)}</td>
                    <td className="px-2 py-2 text-right text-dim text-[11px]">{new Date(t.time).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              label="No recent trades"
              hint={`Trades on ${market.symbol} will stream in here`}
            />
          )
        )}

        {tab === 'funding' && (
          fundingHistory.length > 0 ? (
            <table className="w-full text-xs">
              <thead><tr className="text-dim text-[10px] border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-right px-2 py-2 font-medium">Rate</th>
                <th className="text-right px-2 py-2 font-medium">Annual</th>
              </tr></thead>
              <tbody>
                {fundingHistory.slice().reverse().slice(0, 50).map((f, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
                    <td className="px-3 py-2 text-foreground/70 text-[11px]">
                      {new Date(f.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className={cn('px-2 py-2 text-right font-mono tabular-nums', f.rate >= 0 ? 'text-green' : 'text-red')}>
                      {f.rate >= 0 ? '+' : ''}{(f.rate * 100).toFixed(4)}%
                    </td>
                    <td className={cn('px-2 py-2 text-right font-mono tabular-nums text-[11px]', f.rate >= 0 ? 'text-green/60' : 'text-red/60')}>
                      {((f.rate * 365 * 3) * 100).toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              label="No funding history"
              hint="Funding accrues every 8 hours on open positions"
            />
          )
        )}

        {tab === 'history' && (
          orderHistory.length > 0 ? (
            <table className="w-full text-xs">
              <thead><tr className="text-dim text-[10px] border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-2 py-2 font-medium">Side</th>
                <th className="text-right px-2 py-2 font-medium">Price</th>
                <th className="text-right px-2 py-2 font-medium">Size</th>
                <th className="text-right px-2 py-2 font-medium">Status</th>
                <th className="text-right px-2 py-2 font-medium">Block</th>
              </tr></thead>
              <tbody>
                {orderHistory.map((o, i) => {
                  const rec = o as Order & { created_at?: string; block_number?: number };
                  const when = rec.created_at ? new Date(rec.created_at) : null;
                  return (
                    <tr key={i} className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
                      <td className="px-3 py-2 text-dim font-mono text-[10px] whitespace-nowrap" title={when ? when.toLocaleString() : ''}>
                        {when ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
                      </td>
                      <td className={cn('px-2 py-2 font-semibold', o.side?.toLowerCase() === 'buy' ? 'text-green' : 'text-red')}>
                        {o.side}
                      </td>
                      <td className="px-2 py-2 text-right text-foreground/70 font-mono tabular-nums">{o.price}</td>
                      <td className="px-2 py-2 text-right text-foreground/70 font-mono tabular-nums">{o.size}</td>
                      <td className="px-2 py-2 text-right">
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-medium',
                          o.status === 'filled' ? 'bg-green/10 text-green' :
                          o.status === 'cancelled' ? 'bg-red/10 text-red' :
                          'bg-yellow/10 text-yellow'
                        )}>
                          {o.status || 'unknown'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-[10px]">
                        {rec.block_number ? (
                          <a
                            href={`https://explorer.mersennet.com/block/${rec.block_number}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary/70 hover:text-primary transition-colors"
                          >#{rec.block_number}</a>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <EmptyState
              label="No order history"
              hint="Filled and cancelled orders will appear here"
            />
          )
        )}
      </div>
    </div>
  );
}
