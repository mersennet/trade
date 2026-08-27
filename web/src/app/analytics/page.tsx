'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { api, type ProtocolStats, type Trade, type TraderProfile, type TraderStatRow } from '@/lib/api';
import { formatNumber, cn } from '@/lib/utils';

type Period = '24h' | '7d' | '30d' | 'all';

// UI period -> leaderboard period key produced by the indexer (updateLeaderboard).
const LEADERBOARD_PERIOD: Record<Period, string> = {
  '24h': 'daily',
  '7d': 'weekly',
  '30d': 'monthly',
  'all': 'alltime',
};

const num = (v: number | string | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
};

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

// Per-trade cash flow: a sell brings cash in, a buy sends cash out. Summed, this
// is realized PnL when a position nets flat and cost basis while it's open — the
// same cash-flow model the indexer's leaderboard uses (see updateLeaderboard).
function tradeCashFlow(t: Trade): number {
  return (t.side === 'sell' ? 1 : -1) * t.price * t.size;
}

function computeStats(
  trades: Trade[],
  period: Period,
  row: TraderStatRow | undefined,
): { stats: ComputedStats; equityCurve: { time: number; value: number }[] } {
  const now = Date.now();
  const cutoff: Record<Period, number> = {
    '24h': now - 86400000,
    '7d': now - 7 * 86400000,
    '30d': now - 30 * 86400000,
    'all': 0,
  };
  // The recent-trades list (last 20 fills) drives the equity-curve shape; the
  // headline aggregates come from the indexer's real per-period leaderboard row.
  const filtered = trades
    .filter((t) => new Date(t.time).getTime() >= cutoff[period])
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const curve: { time: number; value: number }[] = [];
  for (const t of filtered) {
    cum += tradeCashFlow(t);
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
    curve.push({ time: Math.floor(new Date(t.time).getTime() / 1000), value: cum });
  }

  const winCount = num(row?.win_count);
  const lossCount = num(row?.loss_count);
  const decided = winCount + lossCount;
  const tradeCount = num(row?.trade_count) || filtered.length;
  const totalVol = num(row?.volume) || filtered.reduce((s, t) => s + t.price * t.size, 0);

  return {
    stats: {
      totalTrades: tradeCount,
      // Real win/loss counts from per-market roundtrips (indexer), not a proxy.
      winRate: decided > 0 ? (winCount / decided) * 100 : 0,
      avgTradeSize: tradeCount > 0 ? totalVol / tradeCount : 0,
      bestTrade: num(row?.best_trade),
      worstTrade: num(row?.worst_trade),
      maxDrawdown: maxDd,
      avgHoldTime: filtered.length > 1
        ? formatHoldTime((new Date(filtered[filtered.length - 1].time).getTime() - new Date(filtered[0].time).getTime()) / filtered.length)
        : '—',
      profitFactor: lossCount > 0 ? winCount / lossCount : winCount > 0 ? Infinity : 0,
      totalPnl: num(row?.pnl),
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
    const pnl = tradeCashFlow(t);
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
        vertLine: { color: 'rgba(43,217,106,0.3)', labelBackgroundColor: '#101511' },
        horzLine: { color: 'rgba(43,217,106,0.3)', labelBackgroundColor: '#101511' },
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
  const statRow = profile?.stats?.[LEADERBOARD_PERIOD[period]];
  const { stats, equityCurve } = computeStats(trades, period, statRow);
  const monthly = getMonthlyBreakdown(trades);

  const periods: { key: Period; label: string }[] = [
    { key: '24h', label: '24H' },
    { key: '7d', label: '7D' },
    { key: '30d', label: '30D' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="page-shell space-y-6">
      <div className="text-center mb-2">
        <h1 className="page-title">
          Analytics
          <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-cyan/10 text-cyan text-[10px] font-semibold uppercase tracking-wider">
            Cash-flow PnL &middot; Beta
          </span>
        </h1>
        <p className="page-sub">Track your trading performance with detailed statistics</p>
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
            {/* PnL, win/loss, best/worst and volume come from the indexer's real
                per-period leaderboard aggregates (cash-flow method). The equity
                curve is the running cash flow of your last 20 fills, so it reads
                as cost basis while a position is open and realizes when it nets
                flat. Average hold time is an approximation over recent fills. */}
            <div className="bg-cyan/10 border border-cyan/40 rounded-lg p-3 flex items-start gap-2.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <div className="text-[12px] leading-relaxed">
                <span className="text-cyan font-semibold">Cash-flow PnL &middot; Beta.</span>{' '}
                <span className="text-foreground/80">
                  PnL, win rate, best/worst trade and volume are real, computed from your on-chain
                  fills using a cash-flow model (a sell brings cash in, a buy sends it out). While a
                  position is still open this reads as cost basis; it realizes once the position nets
                  flat. The equity curve tracks your last 20 fills; average hold time is approximate.
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
                { label: 'Win / Loss', value: stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2), color: stats.profitFactor >= 1 ? 'text-green' : 'text-red' },
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
