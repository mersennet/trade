'use client';
import { useEffect, useState, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type Market, type OtcQuote, type OtcTrade } from '@/lib/api';
import { formatNumber, formatPrice, formatTimeAgo, shortenAddress, cn } from '@/lib/utils';

export default function OTCPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [quotes, setQuotes] = useState<OtcQuote[]>([]);
  const [history, setHistory] = useState<OtcTrade[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<number | null>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [size, setSize] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastQuote, setLastQuote] = useState<OtcQuote | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api.getMarkets().then((d) => {
      setMarkets(d.markets || []);
      if (d.markets?.length) setSelectedMarket(d.markets[0].id);
    }).catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    if (!address) return;
    api.getOtcQuotes(address).then((d) => setQuotes(d.quotes || [])).catch(() => {});
    api.getOtcHistory(address).then((d) => setHistory(d.history || [])).catch(() => {});
  }, [address]);

  useEffect(() => { refresh(); }, [refresh]);

  // Quotes expire 30s after creation; tick once a second so the countdown and
  // the expired/active state on each card stay live without a server round-trip.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const handleSubmitRfq = async () => {
    if (!address || selectedMarket == null || !size) {
      toast('Fill all fields and connect wallet', 'warning');
      return;
    }
    const symbol = markets.find((m) => m.id === selectedMarket)?.symbol;
    if (!symbol) {
      toast('Select a valid market', 'warning');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.submitRfq({ address, market: symbol, side, size: Number(size) });
      toast('RFQ submitted — quote received', 'success');
      setLastQuote(res.quote);
      setSize('');
      refresh();
    } catch (e) {
      toast(`RFQ failed: ${(e as Error).message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAccept = async (quoteId: number) => {
    if (!address) return;
    try {
      await api.acceptOtcQuote(quoteId, address);
      toast('Quote accepted — trade executed', 'success');
      refresh();
    } catch (e) {
      toast(`Accept failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="p-3 md:p-4 max-w-full space-y-4">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">OTC / Request for Quote</h2>
        <p className="text-dim text-sm">Execute large block trades with minimal slippage. Designed for 50K+ MRSN orders with institutional-grade execution.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* RFQ Form */}
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 bg-primary rounded-full" />
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">New RFQ</h3>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Market</label>
              <select
                value={selectedMarket ?? ''}
                onChange={(e) => setSelectedMarket(Number(e.target.value))}
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/40 transition-colors"
              >
                {markets.map((m) => (
                  <option key={m.id} value={m.id}>{m.symbol}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Side</label>
              <div className="flex gap-1 bg-surface-2 rounded-lg p-1">
                <button onClick={() => setSide('buy')} className={cn('flex-1 py-2 rounded-md text-xs font-semibold transition-all duration-200', side === 'buy' ? 'bg-green/15 text-green shadow-[inset_0_0_0_1px_rgba(52,211,153,0.2)]' : 'text-dim hover:text-muted')}>Buy</button>
                <button onClick={() => setSide('sell')} className={cn('flex-1 py-2 rounded-md text-xs font-semibold transition-all duration-200', side === 'sell' ? 'bg-red/15 text-red shadow-[inset_0_0_0_1px_rgba(248,113,113,0.2)]' : 'text-dim hover:text-muted')}>Sell</button>
              </div>
            </div>

            <div>
              <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Size (MRSN)</label>
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="50,000"
                className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors"
              />
              <p className="text-[10px] text-dim mt-1">Minimum recommended: 50,000 MRSN</p>
            </div>

            <button
              onClick={handleSubmitRfq}
              disabled={submitting || !isConnected}
              className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:shadow-[0_0_16px_rgba(139,92,246,0.15)] transition-all duration-200"
            >
              {!isConnected ? 'Connect Wallet' : submitting ? 'Submitting...' : 'Request Quote'}
            </button>

            {lastQuote && (
              <div className="bg-surface-2 rounded-lg p-3 border border-primary/10">
                <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Last Quote</p>
                <div className="flex justify-between text-xs">
                  <span className="text-foreground">{lastQuote.market}</span>
                  <span className={cn('font-medium', lastQuote.side === 'buy' ? 'text-green' : 'text-red')}>{lastQuote.side.toUpperCase()} {formatNumber(lastQuote.size)} MRSN</span>
                </div>
                <div className="flex justify-between text-[10px] text-dim mt-1">
                  <span>Quote price</span>
                  <span className="font-mono text-foreground">{formatPrice(lastQuote.quote_price)}</span>
                </div>
                <span className={cn('text-[10px] px-1.5 py-0.5 rounded mt-1 inline-block', lastQuote.status === 'active' ? 'bg-green/10 text-green' : 'bg-dim/10 text-dim')}>{lastQuote.status}</span>
              </div>
            )}
          </div>
        </div>

        {/* Active quotes */}
        <div className="lg:col-span-3 bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 bg-green rounded-full" />
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Active Quotes</h3>
          </div>

          {!isConnected ? (
            <p className="text-dim text-xs text-center py-8">Connect wallet to view quotes</p>
          ) : quotes.length === 0 ? (
            <p className="text-dim text-xs text-center py-8">No active quotes — submit an RFQ to receive pricing</p>
          ) : (
            <div className="space-y-2">
              {quotes.map((q) => {
                const msLeft = new Date(q.expires_at).getTime() - now;
                const expired = msLeft <= 0;
                const secsLeft = Math.max(0, Math.ceil(msLeft / 1000));
                const live = q.status === 'active' && !expired;
                return (
                  <div key={q.id} className={cn('bg-surface-2 rounded-lg p-4 border', expired ? 'border-border/50 opacity-60' : 'border-primary/10')}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">Quote #{q.id}</span>
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', live ? 'bg-green/10 text-green' : 'bg-dim/10 text-dim')}>
                          {expired ? 'expired' : q.status}
                        </span>
                        {live && (
                          <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono font-medium', secsLeft <= 10 ? 'bg-red/10 text-red' : 'bg-yellow/10 text-yellow')}>
                            {secsLeft}s
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-dim">{formatTimeAgo(q.created_at)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div>
                        <p className="text-[9px] text-dim uppercase tracking-wider">Price</p>
                        <p className="text-sm font-mono font-semibold text-foreground">{formatPrice(q.quote_price)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-dim uppercase tracking-wider">Size (MRSN)</p>
                        <p className="text-sm font-mono text-foreground">{formatNumber(q.size, 2)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] text-dim uppercase tracking-wider">Quoter</p>
                        <p className="text-sm font-mono text-dim">{shortenAddress(q.quoter)}</p>
                      </div>
                    </div>
                    {live && (
                      <button
                        onClick={() => handleAccept(q.id)}
                        className="w-full py-2 bg-green/80 hover:bg-green text-white rounded-lg text-xs font-semibold shadow-[0_0_12px_rgba(52,211,153,0.1)] transition-all duration-200"
                      >
                        Accept Quote ({secsLeft}s)
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* History */}
      {isConnected && history.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">Trade History</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border/50">
                  <th className="text-left pb-2 font-medium">ID</th>
                  <th className="text-left pb-2 font-medium">Quoter</th>
                  <th className="text-right pb-2 font-medium">Price</th>
                  <th className="text-right pb-2 font-medium">Size (MRSN)</th>
                  <th className="text-right pb-2 font-medium">Status</th>
                  <th className="text-right pb-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-b border-border/30 last:border-0">
                    <td className="py-2 font-mono text-foreground">#{h.id}</td>
                    <td className="py-2 font-mono text-primary">{shortenAddress(h.quoter)}</td>
                    <td className="py-2 text-right font-mono text-foreground">{formatPrice(h.price)}</td>
                    <td className="py-2 text-right font-mono text-foreground/70">{formatNumber(h.size, 2)}</td>
                    <td className="py-2 text-right">
                      <span className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-medium',
                        h.status === 'filled' ? 'bg-green/10 text-green' : h.status === 'expired' ? 'bg-dim/10 text-dim' : 'bg-yellow/10 text-yellow'
                      )}>{h.status}</span>
                    </td>
                    <td className="py-2 text-right text-dim">{formatTimeAgo(h.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
