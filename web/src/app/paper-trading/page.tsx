'use client';
import { useState, useEffect, useCallback } from 'react';
import { cn, formatNumber, formatPrice } from '@/lib/utils';
import { useToast } from '@/components/shared/Toast';
import { useWallet } from '@/hooks/useWallet';
import { api, type PaperPosition, type PaperTrade } from '@/lib/api';
import { MARKETS } from '@/lib/utils';

export default function PaperTradingPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [balance, setBalance] = useState<{ balance: number; equity: number } | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const [marketId, setMarketId] = useState(1);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [size, setSize] = useState('');
  const [leverage, setLeverage] = useState(5);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const [bal, pos, trd] = await Promise.all([
        api.getPaperBalance(address),
        api.getPaperPositions(address),
        api.getPaperTrades(address),
      ]);
      setBalance(bal);
      setPositions(pos.positions || []);
      setTrades(trd.trades || []);
      setInitialized(true);
    } catch {
      setInitialized(false);
    }
  }, [address]);

  useEffect(() => {
    if (address) refresh();
  }, [address, refresh]);

  const handleInit = async () => {
    if (!address) { toast('Connect wallet first', 'error'); return; }
    setLoading(true);
    try {
      await api.initPaper(address);
      toast('Paper trading initialized with $100,000!', 'success');
      refresh();
    } catch (e) {
      toast(`Init failed: ${(e as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleOrder = async () => {
    if (!address) { toast('Connect wallet first', 'error'); return; }
    if (!size || Number(size) <= 0) { toast('Enter a valid size', 'error'); return; }
    setSubmitting(true);
    try {
      await api.submitPaperOrder({
        owner: address,
        market_id: marketId,
        side,
        price: 0,
        size: Number(size),
        leverage,
      });
      toast(`Paper ${side} order placed`, 'success');
      setSize('');
      refresh();
    } catch (e) {
      toast(`Order failed: ${(e as Error).message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedMarket = MARKETS.find((m) => m.id === marketId);

  return (
    <div className="p-4 max-w-full space-y-6">
      {/* Banner */}
      <div className="bg-gradient-to-r from-cyan/10 via-primary/10 to-cyan/10 border border-cyan/20 rounded-xl p-4 text-center shadow-[0_0_24px_rgba(34,211,238,0.06)]">
        <div className="flex items-center justify-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-cyan animate-pulse" />
          <h2 className="text-lg font-bold text-foreground">Paper Trading Mode</h2>
        </div>
        <p className="text-sm text-dim">Virtual $100K Balance — No real funds at risk</p>
      </div>

      {!isConnected ? (
        <div className="bg-surface border border-border rounded-xl p-10 text-center">
          <p className="text-sm text-dim">Connect your wallet to start paper trading</p>
        </div>
      ) : !initialized ? (
        <div className="bg-surface border border-border rounded-xl p-10 text-center space-y-4">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-cyan/10 flex items-center justify-center">
            <svg className="w-7 h-7 text-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-foreground">Initialize Paper Trading</h3>
          <p className="text-xs text-dim max-w-md mx-auto">
            Start with a virtual $100,000 balance. Practice trading strategies risk-free before committing real capital.
          </p>
          <button
            onClick={handleInit}
            disabled={loading}
            className="px-8 py-2.5 bg-cyan hover:bg-cyan/80 text-black font-medium rounded-lg text-sm disabled:opacity-50 hover:shadow-[0_0_16px_rgba(34,211,238,0.2)] transition-all duration-200"
          >
            {loading ? 'Initializing...' : 'Start Paper Trading'}
          </button>
        </div>
      ) : (
        <>
          {/* Balance Display */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface border border-border rounded-xl p-4 text-center">
              <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Balance</p>
              <p className="text-xl font-bold text-foreground font-mono">${formatNumber(balance?.balance ?? 0)}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-4 text-center">
              <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Equity</p>
              <p className="text-xl font-bold text-cyan font-mono">${formatNumber(balance?.equity ?? 0)}</p>
            </div>
          </div>

          {/* Order Form */}
          <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Place Paper Order</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Market</label>
                <select
                  value={marketId}
                  onChange={(e) => setMarketId(Number(e.target.value))}
                  className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
                >
                  {MARKETS.map((m) => (
                    <option key={m.id} value={m.id}>{m.symbol}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Side</label>
                <div className="flex gap-1">
                  <button
                    onClick={() => setSide('buy')}
                    className={cn(
                      'flex-1 py-2 text-xs font-medium rounded-lg transition-colors',
                      side === 'buy'
                        ? 'bg-green/20 text-green border border-green/20'
                        : 'bg-surface-2 text-dim border border-border hover:text-muted'
                    )}
                  >
                    Long
                  </button>
                  <button
                    onClick={() => setSide('sell')}
                    className={cn(
                      'flex-1 py-2 text-xs font-medium rounded-lg transition-colors',
                      side === 'sell'
                        ? 'bg-red/20 text-red border border-red/20'
                        : 'bg-surface-2 text-dim border border-border hover:text-muted'
                    )}
                  >
                    Short
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Size ({selectedMarket?.base})</label>
                <input
                  type="number"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors font-mono"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] text-dim uppercase tracking-wider font-medium">Leverage</label>
                  <span className="text-[11px] font-bold text-primary font-mono">{leverage}x</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className="w-full h-1.5 bg-surface-2 rounded-full appearance-none cursor-pointer accent-primary mt-2"
                />
              </div>
            </div>
            <button
              onClick={handleOrder}
              disabled={submitting || !size}
              className={cn(
                'w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-200 disabled:opacity-50',
                side === 'buy'
                  ? 'bg-green hover:bg-green/80 text-white shadow-[0_0_12px_rgba(52,211,153,0.1)]'
                  : 'bg-red hover:bg-red/80 text-white shadow-[0_0_12px_rgba(248,113,113,0.1)]'
              )}
            >
              {submitting ? 'Placing...' : `${side === 'buy' ? 'Long' : 'Short'} ${selectedMarket?.symbol || ''}`}
            </button>
          </div>

          {/* Open Positions */}
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">
                Open Positions ({positions.length})
              </h3>
            </div>
            {positions.length === 0 ? (
              <div className="p-8 text-center text-xs text-dim">No open positions</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border">
                      <th className="px-4 py-2 text-left font-medium">Market</th>
                      <th className="px-4 py-2 text-left font-medium">Side</th>
                      <th className="px-4 py-2 text-right font-medium">Size</th>
                      <th className="px-4 py-2 text-right font-medium">Entry</th>
                      <th className="px-4 py-2 text-right font-medium">Mark</th>
                      <th className="px-4 py-2 text-right font-medium">PnL</th>
                      <th className="px-4 py-2 text-right font-medium">Leverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const market = MARKETS.find((m) => m.id === p.market_id);
                      return (
                        <tr key={p.id} className="border-b border-border last:border-0 hover:bg-surface-2/50 transition-colors">
                          <td className="px-4 py-2.5 font-mono font-medium text-foreground">{market?.symbol || `#${p.market_id}`}</td>
                          <td className={cn('px-4 py-2.5 font-medium capitalize', p.side === 'buy' ? 'text-green' : 'text-red')}>{p.side === 'buy' ? 'Long' : 'Short'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-foreground">{formatNumber(p.size, 4)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-muted">{formatPrice(p.entry_price)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-muted">{formatPrice(p.mark_price)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono font-medium', p.pnl >= 0 ? 'text-green' : 'text-red')}>
                            {p.pnl >= 0 ? '+' : ''}{formatNumber(p.pnl)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-dim">{p.leverage}x</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Trade History */}
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">
                Trade History ({trades.length})
              </h3>
            </div>
            {trades.length === 0 ? (
              <div className="p-8 text-center text-xs text-dim">No trades yet</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border">
                      <th className="px-4 py-2 text-left font-medium">Market</th>
                      <th className="px-4 py-2 text-left font-medium">Side</th>
                      <th className="px-4 py-2 text-right font-medium">Price</th>
                      <th className="px-4 py-2 text-right font-medium">Size</th>
                      <th className="px-4 py-2 text-right font-medium">PnL</th>
                      <th className="px-4 py-2 text-right font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => {
                      const market = MARKETS.find((m) => m.id === t.market_id);
                      return (
                        <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-2/50 transition-colors">
                          <td className="px-4 py-2.5 font-mono font-medium text-foreground">{market?.symbol || `#${t.market_id}`}</td>
                          <td className={cn('px-4 py-2.5 font-medium capitalize', t.side === 'buy' ? 'text-green' : 'text-red')}>{t.side}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-muted">{formatPrice(t.price)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-foreground">{formatNumber(t.size, 4)}</td>
                          <td className={cn('px-4 py-2.5 text-right font-mono font-medium', t.pnl >= 0 ? 'text-green' : 'text-red')}>
                            {t.pnl >= 0 ? '+' : ''}{formatNumber(t.pnl)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-dim">
                            {new Date(t.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
