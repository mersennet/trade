'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, type TraderProfile, type TraderStatRow, type Trade } from '@/lib/api';
import { formatNumber, shortenAddress, cn } from '@/lib/utils';

type Period = '24h' | '7d' | '30d' | 'all';

// The leaderboard table keys stats by daily/weekly/monthly/alltime; the UI
// presents them as 24h/7d/30d/all.
const PERIOD_KEY: Record<Period, string> = {
  '24h': 'daily', '7d': 'weekly', '30d': 'monthly', 'all': 'alltime',
};

const num = (v: number | string | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
};

// Real per-period stats straight from the indexer-maintained leaderboard row.
function readStats(stats: Record<string, TraderStatRow>, period: Period) {
  const row = stats[PERIOD_KEY[period]];
  const wins = num(row?.win_count);
  const losses = num(row?.loss_count);
  const decided = wins + losses;
  const grossProfit = Math.max(0, num(row?.best_trade));
  const grossLoss = Math.abs(Math.min(0, num(row?.worst_trade)));
  return {
    hasData: !!row,
    totalTrades: num(row?.trade_count),
    totalPnl: num(row?.pnl),
    pnlPct: num(row?.pnl_pct),
    totalVolume: num(row?.volume),
    winRate: decided > 0 ? (wins / decided) * 100 : 0,
    bestTrade: num(row?.best_trade),
    worstTrade: num(row?.worst_trade),
    maxDrawdown: num(row?.max_drawdown),
    avgSize: num(row?.trade_count) > 0 ? num(row?.volume) / num(row?.trade_count) : 0,
    // Profit factor = gross profit / gross loss. We only have best/worst trade
    // server-side, so this is a coarse proxy; '—' when no losses recorded.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}

// Recent-trade-flow chart is an approximate cumulative-notional sketch, NOT
// realized PnL — it is labelled as a preview in the UI.
function buildFlowCurve(trades: Trade[]) {
  if (trades.length < 2) return [] as { time: number; value: number }[];
  const sorted = [...trades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  let cum = 0;
  return sorted.map((t) => {
    cum += (t.side === 'buy' ? 1 : -1) * t.price * t.size;
    return { time: Math.floor(new Date(t.time).getTime() / 1000), value: cum };
  });
}

function EquityCurveChart({ data }: { data: { time: number; value: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<unknown>(null);

  const initChart = useCallback(async () => {
    if (!containerRef.current || data.length < 2) return;
    const { createChart, LineSeries } = await import('lightweight-charts');
    if (chartRef.current) (chartRef.current as { remove: () => void }).remove();
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth, height: 250,
      layout: { background: { color: 'transparent' }, textColor: 'rgba(255,255,255,0.4)', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)' },
    });
    const series = chart.addSeries(LineSeries, {
      color: data[data.length - 1].value >= 0 ? '#34d399' : '#ef4444',
      lineWidth: 2,
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
    return () => { if (chartRef.current) (chartRef.current as { remove: () => void }).remove(); };
  }, [initChart]);

  if (data.length < 2) return <div className="flex items-center justify-center h-[250px] text-dim text-xs">Not enough data</div>;
  return <div ref={containerRef} className="w-full" />;
}

export default function TraderProfilePage() {
  const params = useParams();
  const router = useRouter();
  const address = params.address as string;
  const [profile, setProfile] = useState<TraderProfile | null>(null);
  const [period, setPeriod] = useState<Period>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    api.getTraderProfile(address)
      .then(setProfile)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [address]);

  const trades = profile?.recentTrades ?? [];
  const stats = readStats(profile?.stats ?? {}, period);
  const flowCurve = buildFlowCurve(trades);

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-dim hover:text-muted text-sm transition-colors">
          &larr; Back
        </button>
      </div>

      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="text-primary text-lg font-bold font-mono">{address.slice(2, 4).toUpperCase()}</span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground font-mono">{shortenAddress(address, 8)}</h2>
            <p className="text-xs text-dim font-mono">{address}</p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : !profile ? (
        <div className="bg-surface border border-border rounded-xl p-10 text-center">
          <p className="text-sm text-dim">No profile data found for this trader.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1">
            {(['24h', '7d', '30d', 'all'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'px-3 py-1 text-[11px] rounded-md transition-all',
                  period === p ? 'bg-primary/10 text-primary border border-primary/20' : 'text-dim hover:text-muted'
                )}
              >{p === 'all' ? 'All' : p.toUpperCase()}</button>
            ))}
          </div>

          <div className="bg-surface border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Trade Flow</h3>
                <span className="px-1.5 py-0.5 bg-yellow/10 text-yellow rounded text-[9px] font-semibold uppercase tracking-wider">Preview · estimated</span>
              </div>
              <span className={cn('text-sm font-mono font-semibold', stats.totalPnl >= 0 ? 'text-green' : 'text-red')}>
                {stats.totalPnl >= 0 ? '+' : ''}{formatNumber(stats.totalPnl)} MRSN
              </span>
            </div>
            <EquityCurveChart data={flowCurve} />
            <p className="text-[10px] text-dim mt-2">Cumulative signed notional of recent fills — a directional sketch, not realized PnL.</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Total Trades', value: formatNumber(stats.totalTrades, 0), color: 'text-foreground' },
              { label: 'Win Rate', value: `${stats.winRate.toFixed(1)}%`, color: stats.winRate >= 50 ? 'text-green' : 'text-red' },
              { label: 'Total Volume', value: `${formatNumber(stats.totalVolume)} MRSN`, color: 'text-foreground' },
              { label: 'Avg Trade Size', value: `${formatNumber(stats.avgSize)} MRSN`, color: 'text-foreground' },
              { label: 'Best Trade', value: `${formatNumber(stats.bestTrade)} MRSN`, color: 'text-green' },
              { label: 'Worst Trade', value: `${formatNumber(stats.worstTrade)} MRSN`, color: 'text-red' },
              { label: 'Total P&L', value: `${stats.totalPnl >= 0 ? '+' : ''}${formatNumber(stats.totalPnl)} MRSN`, color: stats.totalPnl >= 0 ? 'text-green' : 'text-red' },
              { label: 'Profit Factor', value: stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : '—', color: 'text-foreground' },
            ].map((item) => (
              <div key={item.label} className="bg-surface border border-border rounded-xl p-3">
                <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{item.label}</p>
                <p className={cn('text-base font-semibold font-mono', item.color)}>{item.value}</p>
              </div>
            ))}
          </div>

          {trades.length > 0 && (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Recent Trades</h3>
              </div>
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-[11px]">
                  <thead><tr className="text-dim text-[10px] border-b border-border uppercase tracking-wider sticky top-0 bg-surface">
                    <th className="text-left px-4 py-2 font-medium">Time</th>
                    <th className="text-left px-4 py-2 font-medium">Market</th>
                    <th className="text-center px-4 py-2 font-medium">Side</th>
                    <th className="text-right px-4 py-2 font-medium">Price</th>
                    <th className="text-right px-4 py-2 font-medium">Size</th>
                  </tr></thead>
                  <tbody>
                    {trades.slice(0, 100).map((t) => (
                      <tr key={t.id} className="border-b border-border/30 hover:bg-surface-2 transition-colors">
                        <td className="px-4 py-2 text-dim font-mono">{new Date(t.time).toLocaleString()}</td>
                        <td className="px-4 py-2 text-foreground">Market {t.marketId}</td>
                        <td className="px-4 py-2 text-center">
                          <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold uppercase',
                            t.side === 'buy' ? 'bg-green/10 text-green' : 'bg-red/10 text-red'
                          )}>{t.side}</span>
                        </td>
                        <td className="px-4 py-2 text-right text-foreground font-mono">{formatNumber(t.price, 2)}</td>
                        <td className="px-4 py-2 text-right text-foreground font-mono">{formatNumber(t.size, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
