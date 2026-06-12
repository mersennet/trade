'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type LeaderboardEntry } from '@/lib/api';
import { formatNumber, formatUsd, shortenAddress, cn } from '@/lib/utils';
import AddressAvatar from '@/components/AddressAvatar';

const PERIODS = ['daily', 'weekly', 'monthly', 'alltime'] as const;
const SORTS = ['pnl', 'volume', 'trade_count'] as const;

const PERIOD_LABEL: Record<string, string> = {
  daily: '24h',
  weekly: '7d',
  monthly: '30d',
  alltime: 'All-time',
};
const SORT_LABEL: Record<string, string> = {
  pnl: 'PnL',
  volume: 'Volume',
  trade_count: 'Trades',
};

function rankBadge(rank: number) {
  if (rank === 1) return { tone: 'text-yellow bg-yellow/10',  label: '1' };
  if (rank === 2) return { tone: 'text-foreground bg-surface-2', label: '2' };
  if (rank === 3) return { tone: 'text-orange bg-orange/10 ring-1 ring-orange/30', label: '3' };
  return null;
}

export default function LeaderboardPage() {
  const [traders, setTraders] = useState<LeaderboardEntry[]>([]);
  const [period, setPeriod] = useState<string>('alltime');
  const [sort, setSort] = useState<string>('pnl');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getLeaderboard(period, sort, 100)
      .then((r) => setTraders(r.traders))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period, sort]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">Leaderboard</h1>
          <p className="text-dim text-xs md:text-[13px] mt-0.5">Top traders ranked by performance</p>
        </div>
      </header>

      {/* Filters — segmented controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          options={PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
          value={period}
          onChange={setPeriod}
        />
        <Segmented
          options={SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }))}
          value={sort}
          onChange={setSort}
        />
      </div>

      {/* Mobile: card list */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="text-center py-8 text-dim text-xs">Loading…</div>
        ) : traders.length > 0 ? traders.map((t) => {
          const rb = rankBadge(t.rank);
          return (
            <Link
              key={t.address}
              href={`/trader/${t.address}`}
              className="flex items-center justify-between px-3 py-3 bg-surface border border-border rounded-lg active:bg-surface-2 transition-colors"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={cn(
                  'w-7 h-7 rounded-md flex items-center justify-center font-mono font-bold text-[12px] shrink-0',
                  rb ? rb.tone : 'text-dim bg-surface-2'
                )}>
                  {rb ? rb.label : t.rank}
                </span>
                <AddressAvatar address={t.address} size={26} />
                <div className="min-w-0">
                  <div className="text-[12px] text-foreground font-mono">{shortenAddress(t.address, 4)}</div>
                  <div className="text-[10px] text-dim font-mono">{formatNumber(t.trades, 0)} trades · {t.winRate}% win</div>
                </div>
              </div>
              <span className={cn('text-[13px] font-mono font-semibold tabular-nums', t.pnl >= 0 ? 'text-green' : 'text-red')}>
                {t.pnl >= 0 ? '+' : ''}{formatUsd(t.pnl)}
              </span>
            </Link>
          );
        }) : (
          <div className="text-center py-8 text-dim text-xs">No traders yet</div>
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border bg-surface-2/30">
              <th className="text-left px-4 py-2.5 w-16">Rank</th>
              <th className="text-left px-4 py-2.5">Trader</th>
              <th className="text-right px-4 py-2.5">PnL</th>
              <th className="text-right px-4 py-2.5">Volume</th>
              <th className="text-right px-4 py-2.5">Trades</th>
              <th className="text-right px-4 py-2.5">Win Rate</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-10 text-dim text-xs">Loading…</td></tr>
            ) : traders.length > 0 ? traders.map((t) => {
              const rb = rankBadge(t.rank);
              return (
                <tr key={t.address} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className={cn(
                      'inline-flex items-center justify-center w-7 h-7 rounded-md font-mono font-bold text-[12px]',
                      rb ? rb.tone : 'text-dim bg-surface-2'
                    )}>
                      {rb ? rb.label : t.rank}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/trader/${t.address}`} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                      <AddressAvatar address={t.address} size={26} />
                      <span className="text-foreground font-mono text-[12.5px] hover:text-primary transition-colors">{shortenAddress(t.address, 6)}</span>
                    </Link>
                  </td>
                  <td className={cn('px-4 py-2.5 text-right font-mono font-semibold tabular-nums', t.pnl >= 0 ? 'text-green' : 'text-red')}>
                    {t.pnl >= 0 ? '+' : ''}{formatUsd(t.pnl)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-foreground/80 font-mono tabular-nums">{formatUsd(t.volume)}</td>
                  <td className="px-4 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{formatNumber(t.trades, 0)}</td>
                  <td className="px-4 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{t.winRate}%</td>
                </tr>
              );
            }) : (
              <tr><td colSpan={6} className="text-center py-10 text-dim text-xs">No traders yet. Start trading to appear here.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Segmented({
  options, value, onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-px bg-background rounded-md border border-border overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-3 py-1.5 text-[11.5px] font-medium transition-colors',
            value === o.value
              ? 'bg-foreground/[0.07] text-foreground'
              : 'bg-surface-2 text-dim hover:text-foreground'
          )}
        >{o.label}</button>
      ))}
    </div>
  );
}
