'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { api, type ProtocolStats, type Trade, type TraderProfile } from '@/lib/api';
import { formatNumber, cn } from '@/lib/utils';

type Period = '24h' | '7d' | '30d' | 'all';

// Native collateral on Mersennet is MRSN, so amounts are labelled MRSN (no '$').
function formatMrsn(n: number): string {
  return `${formatNumber(n, 2)} MRSN`;
}

interface ComputedStats {
  totalTrades: number;
  winRate: number;
  avgTradeSize: number;
  bestTrade: number;
  worstTrade: number;
  maxDrawdown: number;
  avgHoldTime: string;
  profitFactor: number;
  totalPnl: number;
  totalVolume: number;
}

function computeStats(trades: Trade[], period: Period): { stats: ComputedStats; equityCurve: { time: number; value: number }[] } {
  const now = Date.now();
  const cutoff: Record<Period, number> = {
    '24h': now - 86400000,
    '7d': now - 7 * 86400000,
    '30d': now - 30 * 86400000,
    'all': 0,
  };
  const filtered = trades.filter((t) => new Date(t.time).getTime() >= cutoff[period]);
  if (filtered.length === 0) {
    return {
      stats: { totalTrades: 0, winRate: 0, avgTradeSize: 0, bestTrade: 0, worstTrade: 0, maxDrawdown: 0, avgHoldTime: '—', profitFactor: 0, totalPnl: 0, totalVolume: 0 },
      equityCurve: [],
    };
  }

  const sorted = [...filtered].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  let cumPnl = 0;
  let peak = 0;
  let maxDd = 0;
  let totalGains = 0;
  let totalLosses = 0;
  const curve: { time: number; value: number }[] = [];

  for (const t of sorted) {
    const pnl = t.side === 'buy' ? t.price * t.size * 0.002 : -t.price * t.size * 0.001;
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDd) maxDd = dd;
    if (pnl > 0) totalGains += pnl;
    else totalLosses += Math.abs(pnl);
    curve.push({ time: Math.floor(new Date(t.time).getTime() / 1000), value: cumPnl });
  }

  const wins = sorted.filter((t) => t.side === 'buy').length;
  const totalVol = sorted.reduce((s, t) => s + t.price * t.size, 0);
  const avgSize = totalVol / sorted.length;

  const pnls = sorted.map((t) => t.side === 'buy' ? t.price * t.size * 0.002 : -t.price * t.size * 0.001);
  const best = Math.max(...pnls);
  const worst = Math.min(...pnls);

  return {
    stats: {
      totalTrades: sorted.length,
      winRate: sorted.length > 0 ? (wins / sorted.length) * 100 : 0,
      avgTradeSize: avgSize,
      bestTrade: best,
      worstTrade: worst,
      maxDrawdown: maxDd,
      avgHoldTime: sorted.length > 1 ? formatHoldTime((new Date(sorted[sorted.length - 1].time).getTime() - new Date(sorted[0].time).getTime()) / sorted.length) : '—',
      profitFactor: totalLosses > 0 ? totalGains / totalLosses : totalGains > 0 ? Infinity : 0,
      totalPnl: cumPnl,
      totalVolume: totalVol,
    },
    equityCurve: curve,
  };
}

function formatHoldTime(ms: number): string {
  if (ms < 60000) return '<1m';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 86400000)}d`;
}

function getMonthlyBreakdown(trades: Trade[]): { month: string; trades: number; pnl: number; winRate: number }[] {
  const months: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const t of trades) {
    const d = new Date(t.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = { trades: 0, pnl: 0, wins: 0 };
    months[key].trades++;
    const pnl = t.side === 'buy' ? t.price * t.size * 0.002 : -t.price * t.size * 0.001;
    months[key].pnl += pnl;
    if (pnl > 0) months[key].wins++;
  }
  return Object.entries(months)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, data]) => ({
      month,
      trades: data.trades,
      pnl: data.pnl,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    }));
}

function EquityCurveChart({ data }: { data: { time: number; value: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<unknown>(null);

  const initChart = useCallback(async () => {
    if (!containerRef.current || data.length < 2) return;
    const { createChart, LineSeries } = await import('lightweight-charts');

    if (chartRef.current) {
      (chartRef.current as { remove: () => void }).remove();
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 300,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(255,255,255,0.4)',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(139,92,246,0.3)', labelBackgroundColor: '#1a1a2e' },
        horzLine: { color: 'rgba(139,92,246,0.3)', labelBackgroundColor: '#1a1a2e' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)' },
    });

    const series = chart.addSeries(LineSeries, {
      color: data[data.length - 1].value >= 0 ? '#34d399' : '#ef4444',
      lineWidth: 2,
      crosshairMarkerRadius: 4,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    const deduped = data.reduce<{ time: number; value: number }[]>((acc, d) => {
      if (acc.length === 0 || acc[acc.length - 1].time !== d.time) acc.push(d);
      else acc[acc.length - 1] = d;
      return acc;
    }, []);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    series.setData(deduped as any);
    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [data]);

  useEffect(() => {
    initChart();
    return () => {
      if (chartRef.current) (chartRef.current as { remove: () => void }).remove();
    };
  }, [initChart]);

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center h-[300px] text-dim text-xs">
        Not enough data for equity curve
      </div>
    );
  }

  return <div ref={containerRef} className="w-full" />;
}

export default function AnalyticsPage() {
  const { address, isConnected } = useWallet();
  const [protocolStats, setProtocolStats] = useState<ProtocolStats | null>(null);
  const [profile, setProfile] = useState<TraderProfile | null>(null);
  const [period, setPeriod] = useState<Period>('all');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.getStats().then(setProtocolStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isConnected || !address) return;
    setLoading(true);
    api.getTraderProfile(address)
      .then((p) => setProfile(p))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [address, isConnected]);

  const trades = profile?.recentTrades ?? [];
  const { stats, equityCurve } = computeStats(trades, period);
  const monthly = getMonthlyBreakdown(trades);

  const periods: { key: Period; label: string }[] = [
    { key: '24h', label: '24H' },
    { key: '7d', label: '7D' },
    { key: '30d', label: '30D' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="text-center mb-2">
        <h2 className="text-2xl font-bold text-foreground mb-2 flex items-center justify-center gap-2">
          Analytics
          <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-yellow/10 text-yellow text-[10px] font-semibold uppercase tracking-wider">
            Preview &middot; Simulated PnL
          </span>
        </h2>
        <p className="text-dim text-sm">Track your trading performance with detailed statistics</p>
      </div>

      {protocolStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: '24H Volume', value: formatMrsn(protocolStats.volume24h) },
            { label: '7D Volume', value: formatMrsn(protocolStats.volume7d) },
            { label: 'Unique Traders', value: formatNumber(protocolStats.uniqueTraders, 0), color: 'text-primary' },
            { label: 'Total Trades', value: formatNumber(protocolStats.totalTrades || 0, 0) },
          ].map((item) => (
            <div key={item.label} className="bg-surface border border-border rounded-xl p-4 text-center">
              <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{item.label}</p>
              <p className={cn('text-lg font-bold font-mono', item.color || 'text-foreground')}>{item.value}</p>
            </div>
          ))}
        </div>
      )}

      {isConnected && address ? (
        loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Trade volume, counts, sizes and hold times below are real (from on-chain
                trade history). Realized PnL is not yet indexed per trade, so the equity
                curve, win-rate, best/worst, drawdown and profit-factor use a placeholder
                PnL model and are shown for preview only. */}
            <div className="bg-yellow/10 border border-yellow/40 rounded-lg p-3 flex items-start gap-2.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow shrink-0 mt-0.5">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div className="text-[12px] leading-relaxed">
                <span className="text-yellow font-semibold">Preview &middot; Simulated PnL.</span>{' '}
                <span className="text-foreground/80">
                  Trade counts, volume, average size and hold times are real. Realized PnL is not yet
                  indexed per trade, so the equity curve, win rate, best/worst trade, drawdown and
                  profit factor use a placeholder model for demo purposes.
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {periods.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={cn(
                    'px-3 py-1 text-[11px] rounded-md transition-all',
                    period === p.key
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-dim hover:text-muted'
                  )}
                >{p.label}</button>
              ))}
            </div>

            <div className="bg-surface border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Equity Curve</h3>
                <span className={cn('text-sm font-mono font-semibold', stats.totalPnl >= 0 ? 'text-green' : 'text-red')}>
                  {stats.totalPnl >= 0 ? '+' : ''}{formatMrsn(stats.totalPnl)}
                </span>
              </div>
              <EquityCurveChart data={equityCurve} />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Win Rate', value: `${stats.winRate.toFixed(1)}%`, color: stats.winRate >= 50 ? 'text-green' : 'text-red' },
                { label: 'Total Trades', value: formatNumber(stats.totalTrades, 0) },
                { label: 'Avg Trade Size', value: formatMrsn(stats.avgTradeSize) },
                { label: 'Best Trade', value: formatMrsn(stats.bestTrade), color: 'text-green' },
                { label: 'Worst Trade', value: formatMrsn(stats.worstTrade), color: 'text-red' },
                { label: 'Max Drawdown', value: formatMrsn(stats.maxDrawdown), color: 'text-orange' },
                { label: 'Avg Hold Time', value: stats.avgHoldTime },
                { label: 'Profit Factor', value: stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2), color: stats.profitFactor >= 1 ? 'text-green' : 'text-red' },
              ].map((item) => (
                <div key={item.label} className="bg-surface border border-border rounded-xl p-3">
                  <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{item.label}</p>
                  <p className={cn('text-base font-semibold font-mono', item.color || 'text-foreground')}>{item.value}</p>
                </div>
              ))}
            </div>

            {monthly.length > 0 && (
              <div className="bg-surface border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Monthly Breakdown</h3>
                </div>
                <table className="w-full text-[11px]">
                  <thead><tr className="text-dim text-[10px] border-b border-border uppercase tracking-wider">
                    <th className="text-left px-4 py-2 font-medium">Month</th>
                    <th className="text-right px-4 py-2 font-medium">Trades</th>
                    <th className="text-right px-4 py-2 font-medium">P&L</th>
                    <th className="text-right px-4 py-2 font-medium">Win Rate</th>
                  </tr></thead>
                  <tbody>
                    {monthly.map((m) => (
                      <tr key={m.month} className="border-b border-border/30 hover:bg-surface-2 transition-colors">
                        <td className="px-4 py-2.5 text-foreground font-medium font-mono">{m.month}</td>
                        <td className="px-4 py-2.5 text-right text-foreground/70 font-mono">{m.trades}</td>
                        <td className={cn('px-4 py-2.5 text-right font-mono font-medium', m.pnl >= 0 ? 'text-green' : 'text-red')}>
                          {m.pnl >= 0 ? '+' : ''}{formatMrsn(m.pnl)}
                        </td>
                        <td className={cn('px-4 py-2.5 text-right font-mono', m.winRate >= 50 ? 'text-green' : 'text-red')}>
                          {m.winRate.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      ) : (
        <div className="bg-surface border border-border rounded-xl p-10 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-primary/8 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary/50">
              <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </div>
          <h3 className="text-sm font-medium text-foreground mb-1">Your Trading Analytics</h3>
          <p className="text-xs text-dim max-w-sm mx-auto">
            Connect your wallet to see your equity curve, win rate, drawdown analysis, and detailed trade history.
          </p>
        </div>
      )}
    </div>
  );
}
