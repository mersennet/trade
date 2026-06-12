'use client';
import { useEffect, useState, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type SpotMarket, type SpotTrade, type SpotBalance } from '@/lib/api';
import { formatPrice, formatNumber, formatTimeAgo, cn } from '@/lib/utils';

export default function SpotPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [markets, setMarkets] = useState<SpotMarket[]>([]);
  const [selected, setSelected] = useState<SpotMarket | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [orderbook, setOrderbook] = useState<{ bids: [number, number][]; asks: [number, number][] } | null>(null);
  const [trades, setTrades] = useState<SpotTrade[]>([]);
  const [balances, setBalances] = useState<SpotBalance[]>([]);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getSpotMarkets()
      .then((data) => {
        setMarkets(data.markets || []);
        if (data.markets?.length) setSelected(data.markets[0]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const refreshBook = useCallback(() => {
    if (!selected) return;
    api.getSpotOrderbook(selected.pair).then((d) => setOrderbook(d.orderbook)).catch(() => {});
    api.getSpotTrades(selected.pair).then((d) => setTrades(d.trades || [])).catch(() => {});
  }, [selected]);

  useEffect(() => {
    refreshBook();
    const iv = setInterval(refreshBook, 3000);
    return () => clearInterval(iv);
  }, [refreshBook]);

  useEffect(() => {
    if (isConnected && address) {
      api.getSpotBalances(address).then((d) => setBalances(d.balances || [])).catch(() => {});
    }
  }, [address, isConnected]);

  const handleSubmit = async () => {
    if (!isConnected || !address || !selected || !price || !size) {
      toast('Fill all fields and connect wallet', 'warning');
      return;
    }
    setSubmitting(true);
    try {
      await api.submitSpotOrder({ owner: address, pair: selected.pair, side, price: Number(price), size: Number(size) });
      toast(`${side.toUpperCase()} order placed on ${selected.pair}`, 'success');
      setPrice('');
      setSize('');
      refreshBook();
      if (address) api.getSpotBalances(address).then((d) => setBalances(d.balances || [])).catch(() => {});
    } catch (e) {
      toast(`Order failed: ${(e as Error).message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (markets.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <div className="w-16 h-16 bg-surface-2 rounded-2xl flex items-center justify-center mb-4">
          <svg className="w-8 h-8 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
          </svg>
        </div>
        <h2 className="text-lg font-bold text-foreground mb-2">No Spot Markets</h2>
        <p className="text-dim text-sm max-w-sm">Spot markets are not available yet. Check back later for live token pair trading.</p>
      </div>
    );
  }

  const asks = (orderbook?.asks || []).slice(0, 10).reverse();
  const bids = (orderbook?.bids || []).slice(0, 10);
  const maxBookSize = Math.max(
    ...asks.map(([, s]) => s),
    ...bids.map(([, s]) => s),
    1
  );

  return (
    <div className="p-3 md:p-4 max-w-full space-y-4">
      {/* Market selector */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 bg-surface border border-border rounded-lg px-4 py-2 text-sm font-semibold text-foreground hover:border-primary/30 transition-colors"
          >
            <span>{selected?.pair || 'Select Market'}</span>
            <svg className={cn('w-4 h-4 text-dim transition-transform', dropdownOpen && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-56 bg-surface border border-border rounded-lg shadow-xl z-50 py-1 max-h-64 overflow-y-auto">
              {markets.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setSelected(m); setDropdownOpen(false); }}
                  className={cn(
                    'w-full text-left px-4 py-2.5 text-xs hover:bg-surface-2 transition-colors flex items-center justify-between',
                    selected?.id === m.id ? 'text-primary bg-primary/5' : 'text-foreground'
                  )}
                >
                  <span className="font-medium">{m.pair}</span>
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded', m.status === 'active' ? 'bg-green/10 text-green' : 'bg-dim/10 text-dim')}>{m.status}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {selected && (
          <span className={cn('text-[10px] px-2 py-0.5 rounded-md font-medium uppercase', selected.status === 'active' ? 'bg-green/10 text-green' : 'bg-yellow/10 text-yellow')}>
            {selected.status}
          </span>
        )}
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Order book */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Order Book</h3>
          <div className="grid grid-cols-3 text-[10px] text-dim uppercase tracking-wider mb-2 px-1">
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>
          <div className="space-y-px mb-2">
            {asks.map(([p, s], i) => {
              let runTotal = 0;
              for (let j = asks.length - 1; j >= i; j--) runTotal += asks[j][1];
              return (
                <div key={`a-${i}`} className="relative grid grid-cols-3 text-xs font-mono py-0.5 px-1 cursor-pointer hover:bg-red/5 rounded" onClick={() => setPrice(p.toString())}>
                  <div className="absolute inset-0 right-0 bg-red/8 rounded" style={{ width: `${(s / maxBookSize) * 100}%`, marginLeft: 'auto' }} />
                  <span className="text-red relative z-10">{formatPrice(p)}</span>
                  <span className="text-right text-foreground/70 relative z-10">{formatNumber(s, 4)}</span>
                  <span className="text-right text-dim relative z-10">{formatNumber(runTotal, 4)}</span>
                </div>
              );
            })}
          </div>
          {orderbook && (orderbook.asks.length > 0 || orderbook.bids.length > 0) && (
            <div className="text-center py-1.5 border-y border-border/50 mb-2">
              <span className="text-sm font-bold text-foreground font-mono">
                {orderbook.bids[0] ? formatPrice(orderbook.bids[0][0]) : '—'}
              </span>
            </div>
          )}
          <div className="space-y-px">
            {bids.map(([p, s], i) => {
              let runTotal = 0;
              for (let j = 0; j <= i; j++) runTotal += bids[j][1];
              return (
                <div key={`b-${i}`} className="relative grid grid-cols-3 text-xs font-mono py-0.5 px-1 cursor-pointer hover:bg-green/5 rounded" onClick={() => setPrice(p.toString())}>
                  <div className="absolute inset-0 right-0 bg-green/8 rounded" style={{ width: `${(s / maxBookSize) * 100}%`, marginLeft: 'auto' }} />
                  <span className="text-green relative z-10">{formatPrice(p)}</span>
                  <span className="text-right text-foreground/70 relative z-10">{formatNumber(s, 4)}</span>
                  <span className="text-right text-dim relative z-10">{formatNumber(runTotal, 4)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Order form */}
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-4">Place Order</h3>
          <div className="flex gap-1 mb-4 bg-surface-2 rounded-lg p-1">
            <button
              onClick={() => setSide('buy')}
              className={cn(
                'flex-1 py-2 rounded-md text-xs font-semibold transition-all duration-200',
                side === 'buy' ? 'bg-green/15 text-green shadow-[inset_0_0_0_1px_rgba(52,211,153,0.2)]' : 'text-dim hover:text-muted'
              )}
            >Buy</button>
            <button
              onClick={() => setSide('sell')}
              className={cn(
                'flex-1 py-2 rounded-md text-xs font-semibold transition-all duration-200',
                side === 'sell' ? 'bg-red/15 text-red shadow-[inset_0_0_0_1px_rgba(248,113,113,0.2)]' : 'text-dim hover:text-muted'
              )}
            >Sell</button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Price</label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors"
              />
            </div>
            <div>
              <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Size ({selected?.base || ''})</label>
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="0.00"
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors"
              />
            </div>
            {price && size && (
              <div className="flex justify-between text-xs text-dim px-1">
                <span>Total</span>
                <span className="text-foreground font-mono">{formatNumber(Number(price) * Number(size), 2)} {selected?.quote || ''}</span>
              </div>
            )}
            <button
              onClick={handleSubmit}
              disabled={submitting || !isConnected}
              className={cn(
                'w-full py-3 rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-50',
                side === 'buy'
                  ? 'bg-green/80 hover:bg-green text-white shadow-[0_0_16px_rgba(52,211,153,0.1)]'
                  : 'bg-red/80 hover:bg-red text-white shadow-[0_0_16px_rgba(248,113,113,0.1)]'
              )}
            >
              {!isConnected ? 'Connect Wallet' : submitting ? 'Placing...' : `${side === 'buy' ? 'Buy' : 'Sell'} ${selected?.base || ''}`}
            </button>
          </div>
        </div>
      </div>

      {/* Recent trades & balances */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Recent Trades</h3>
          {trades.length === 0 ? (
            <p className="text-dim text-xs text-center py-6">No recent trades</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border/50">
                    <th className="text-left pb-2 font-medium">Price</th>
                    <th className="text-right pb-2 font-medium">Size</th>
                    <th className="text-right pb-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 15).map((t) => (
                    <tr key={t.id} className="border-b border-border/30 last:border-0">
                      <td className={cn('py-1.5 font-mono', t.buyer !== t.seller ? 'text-green' : 'text-foreground')}>{formatPrice(t.price)}</td>
                      <td className="text-right font-mono text-foreground/70">{formatNumber(t.size, 4)}</td>
                      <td className="text-right text-dim">{formatTimeAgo(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Balances</h3>
          {!isConnected ? (
            <p className="text-dim text-xs text-center py-6">Connect wallet to view balances</p>
          ) : balances.length === 0 ? (
            <p className="text-dim text-xs text-center py-6">No balances found</p>
          ) : (
            <div className="space-y-2">
              {balances.map((b) => (
                <div key={b.asset} className="flex items-center justify-between bg-surface-2 rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 bg-primary/10 rounded-lg flex items-center justify-center">
                      <span className="text-primary text-[10px] font-bold">{b.asset.slice(0, 3)}</span>
                    </div>
                    <span className="text-sm font-medium text-foreground">{b.asset}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-mono text-foreground block">{formatNumber(b.available, 4)}</span>
                    {b.locked > 0 && <span className="text-[10px] text-dim font-mono">Locked: {formatNumber(b.locked, 4)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
