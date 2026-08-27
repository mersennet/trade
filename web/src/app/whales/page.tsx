'use client';
import { useEffect, useState, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type WhaleTrade, type WhaleWallet, type WhaleAlert, type Market } from '@/lib/api';
import { formatNumber, formatTimeAgo, shortenAddress, cn } from '@/lib/utils';
import AddressAvatar from '@/components/AddressAvatar';
import TokenLogo from '@/components/TokenLogo';

const THRESHOLDS = [
  { value: '10000',   label: '10K+' },
  { value: '50000',   label: '50K+' },
  { value: '100000',  label: '100K+' },
  { value: '500000',  label: '500K+' },
  { value: '1000000', label: '1M+'  },
];

export default function WhalesPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [trades, setTrades] = useState<WhaleTrade[]>([]);
  const [wallets, setWallets] = useState<WhaleWallet[]>([]);
  const [alerts, setAlerts] = useState<WhaleAlert[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [threshold, setThreshold] = useState('50000');
  const [alertMarket, setAlertMarket] = useState<number | undefined>(undefined);
  const [alertThreshold, setAlertThreshold] = useState('100000');

  const refresh = useCallback(() => {
    api.getWhaleActivity(Number(threshold) || undefined).then((d) => setTrades(d.trades || [])).catch(() => {});
    api.getWhaleWallets().then((d) => setWallets(d.wallets || [])).catch(() => {});
  }, [threshold]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 10000);
    return () => clearInterval(iv);
  }, [refresh]);

  useEffect(() => {
    api.getMarkets().then((d) => setMarkets(d.markets || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (address) api.getWhaleAlerts(address).then((d) => setAlerts(d.alerts || [])).catch(() => {});
  }, [address]);

  const handleCreateAlert = async () => {
    if (!address) return;
    try {
      await api.createWhaleAlert({ address, market_id: alertMarket, threshold: Number(alertThreshold) });
      toast('Whale alert created', 'success');
      api.getWhaleAlerts(address).then((d) => setAlerts(d.alerts || []));
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="page-shell space-y-5">
      {/* Header */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">
            Whale Tracker
            <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-green/10 text-green text-[10px] font-semibold uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
              Live · 10s
            </span>
          </h1>
          <p className="page-sub">Large trades and active whales across all markets</p>
        </div>
        <div className="flex items-center gap-px bg-background rounded-md border border-border overflow-hidden">
          {THRESHOLDS.map((t) => (
            <button
              key={t.value}
              onClick={() => setThreshold(t.value)}
              className={cn(
                'px-2.5 py-1.5 text-[11px] font-medium transition-colors tabular-nums',
                threshold === t.value
                  ? 'bg-foreground/[0.07] text-foreground'
                  : 'bg-surface-2 text-dim hover:text-foreground'
              )}
            >{t.label}</button>
          ))}
        </div>
      </header>

      {/* Live Activity */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Live Activity</h3>
          <span className="text-[10px] text-dim font-mono">{trades.length} trades</span>
        </div>
        <div className="p-3">
          {trades.length === 0 ? (
            <p className="text-dim text-xs text-center py-10">No whale trades detected at this threshold</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[480px] overflow-y-auto pr-1">
              {trades.map((t) => {
                const base = (t.symbol || '').split('/')[0] || (t.symbol || '?');
                return (
                  <div
                    key={t.id}
                    className={cn(
                      'bg-surface-2/40 border border-border/60 rounded-lg p-3 border-l-2',
                      t.side === 'buy' ? 'border-l-green' : 'border-l-red'
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <TokenLogo symbol={base} size={20} />
                        <span className="text-[13px] font-semibold text-foreground truncate">{t.symbol}</span>
                        <span className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider',
                          t.side === 'buy' ? 'bg-green/10 text-green' : 'bg-red/10 text-red'
                        )}>{t.side}</span>
                      </div>
                      <span className="text-[10px] text-dim shrink-0">{formatTimeAgo(t.time)}</span>
                    </div>
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-[10px] text-dim uppercase tracking-wider">Size</p>
                        <p className="text-[13px] font-mono font-semibold text-foreground tabular-nums">{formatNumber(t.size, 2)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-dim uppercase tracking-wider">Value</p>
                        <p className={cn('text-[13px] font-mono font-semibold tabular-nums', t.side === 'buy' ? 'text-green' : 'text-red')}>
                          {formatNumber(t.value, 2)} MRSN
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 pt-2 border-t border-border/50 flex items-center justify-between text-[10px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <AddressAvatar address={t.taker} size={14} />
                        <span className="text-dim font-mono truncate">{shortenAddress(t.taker)}</span>
                      </div>
                      <span className="text-dim font-mono tabular-nums">@ {formatNumber(t.price, 2)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top wallets */}
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Top Whale Wallets</h3>
          </div>
          {wallets.length === 0 ? (
            <p className="text-dim text-xs text-center py-10">No whale wallets tracked yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border bg-surface-2/30">
                    <th className="text-left px-4 py-2 font-medium">Trader</th>
                    <th className="text-right px-4 py-2 font-medium">Volume</th>
                    <th className="text-right px-4 py-2 font-medium">Trades</th>
                    <th className="text-right px-4 py-2 font-medium">PnL</th>
                    <th className="text-right px-4 py-2 font-medium">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.slice(0, 20).map((w) => (
                    <tr key={w.address} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <AddressAvatar address={w.address} size={20} />
                          <span className="font-mono text-primary text-[12px]">{shortenAddress(w.address)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-foreground tabular-nums">{formatNumber(w.volume, 2)} MRSN</td>
                      <td className="px-4 py-2 text-right font-mono text-foreground/70 tabular-nums">{w.trades}</td>
                      <td className={cn(
                        'px-4 py-2 text-right font-mono font-semibold tabular-nums',
                        w.pnl == null ? 'text-dim' : w.pnl >= 0 ? 'text-green' : 'text-red'
                      )}>
                        {w.pnl == null ? '—' : `${w.pnl >= 0 ? '+' : ''}${formatNumber(w.pnl, 2)} MRSN`}
                      </td>
                      <td className="px-4 py-2 text-right text-dim text-[10.5px]">{formatTimeAgo(w.last_active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Alert configuration */}
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Alert Configuration</h3>
          </div>
          <div className="p-4">
            {!isConnected ? (
              <div className="text-center py-8">
                <p className="text-dim text-xs">Connect a wallet to configure whale alerts</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Threshold (MRSN)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={alertThreshold}
                    onChange={(e) => setAlertThreshold(e.target.value)}
                    placeholder="100000"
                    className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono tabular-nums outline-none focus:border-primary/40 transition-colors"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Market (optional)</label>
                  <select
                    value={alertMarket ?? ''}
                    onChange={(e) => setAlertMarket(e.target.value ? Number(e.target.value) : undefined)}
                    className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary/40 transition-colors"
                  >
                    <option value="">All Markets</option>
                    {markets.map((m) => (
                      <option key={m.id} value={m.id}>{m.symbol}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleCreateAlert}
                  className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white rounded-md text-[12.5px] font-semibold transition-colors"
                >
                  Create Alert
                </button>

                {alerts.length > 0 && (
                  <div className="border-t border-border pt-3 mt-3">
                    <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-2">Active Alerts</p>
                    <div className="space-y-1.5">
                      {alerts.map((a) => (
                        <div key={a.id} className="flex items-center justify-between bg-surface-2/40 border border-border/60 rounded-md px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] text-foreground font-mono tabular-nums">{formatNumber(a.threshold, 0)}+ MRSN</span>
                            <span className="text-[10px] text-dim">
                              {a.market_id ? markets.find((m) => m.id === a.market_id)?.symbol || `#${a.market_id}` : 'All Markets'}
                            </span>
                          </div>
                          <span className="text-[10px] text-green bg-green/10 px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider">Active</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
