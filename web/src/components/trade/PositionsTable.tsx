'use client';
import { useEffect, useState } from 'react';
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
  const { market, positions, orders, setPositions, setOrders, tickers } = useStore();
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('positions');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [fundingHistory, setFundingHistory] = useState<FundingRate[]>([]);
  const [orderHistory, setOrderHistory] = useState<Order[]>([]);
  const [hideOtherSymbols, setHideOtherSymbols] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConnected || !address) { setLoading(false); return; }
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
      await api.cancelOrder(orderId);
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

  const handleCancelAll = async () => {
    if (!address) return;
    try {
      await api.cancelAllOrders(address);
      toast('All orders cancelled', 'success');
      if (useAppStore.getState().soundEnabled) playSound('cancel');
      const res = await api.getOrders(address);
      setOrders(res.orders);
    } catch (e) {
      toast(`Cancel all failed: ${(e as Error).message}`, 'error');
    }
  };

  const handleClosePosition = async (pos: typeof positions[0]) => {
    if (!address) return;
    const size = Math.abs(Number(pos.size));
    const side = Number(pos.size) > 0 ? 'Sell' : 'Buy';
    // Market close needs a hard limit price (a price of 0 can never fill a buy
    // and gives a sell zero slippage protection). Use mark price ± the user's
    // slippage cushion as the IOC limit, mirroring TradeForm's market orders.
    const mark = tickers[pos.marketId]?.markPrice || 0;
    if (!mark) {
      toast('No mark price available — try again in a moment', 'error');
      return;
    }
    const slippagePct = (useAppStore.getState().slippage || 1) / 100;
    const priceForClose = side === 'Buy'
      ? (mark * (1 + slippagePct)).toString()
      : (mark * (1 - slippagePct)).toString();
    try {
      await api.submitOrder({
        owner: address,
        market_id: pos.marketId,
        side,
        price: priceForClose,
        size: size.toString(),
        order_type: 'market',
        tif: 'Ioc',
        reduce_only: true,
      });
      toast(`Closing ${pos.symbol} position`, 'success');
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
                    <tr key={i} className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
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
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            onClick={() => {
                              const text = `${size >= 0 ? 'Long' : 'Short'} ${p.symbol} | Entry: $${formatPrice(entry)} | PnL: ${pnl >= 0 ? '+' : ''}${formatNumber(pnl, 2)} | Mersennet Trade`;
                              navigator.clipboard.writeText(text);
                              toast('Trade copied to clipboard!', 'info');
                            }}
                            className="px-1.5 py-1 text-[10px] text-dim hover:text-primary transition-colors rounded"
                            title="Share trade"
                            aria-label={`Copy ${p.symbol} trade to clipboard`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                          </button>
                          <button
                            onClick={() => handleClosePosition(p)}
                            className="px-2.5 py-1 text-[10px] font-medium bg-red/10 text-red rounded-md hover:bg-red/20 transition-colors"
                          >Close</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <EmptyState
              label="No open positions"
              hint={isConnected ? 'Place your first order to open a position' : 'Connect a wallet to start trading'}
            />
          )
        )}

        {tab === 'orders' && (
          filteredOrders.length > 0 ? (
            <table className="w-full text-xs">
              <thead><tr className="text-dim text-[10px] border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Side</th>
                <th className="text-right px-2 py-2 font-medium">Price</th>
                <th className="text-right px-2 py-2 font-medium">Size</th>
                <th className="text-right px-2 py-2 font-medium">TIF</th>
                <th className="text-right px-2 py-2 font-medium"></th>
              </tr></thead>
              <tbody>
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
                <th className="text-left px-3 py-2 font-medium">Side</th>
                <th className="text-right px-2 py-2 font-medium">Price</th>
                <th className="text-right px-2 py-2 font-medium">Size</th>
                <th className="text-right px-2 py-2 font-medium">Status</th>
              </tr></thead>
              <tbody>
                {orderHistory.map((o, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-surface-2/50 transition-colors">
                    <td className={cn('px-3 py-2 font-semibold', o.side?.toLowerCase() === 'buy' ? 'text-green' : 'text-red')}>
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
                  </tr>
                ))}
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
