'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type LeaderboardEntry, type PointsEntry, type SprintStatus } from '@/lib/api';
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

function fmtCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h`;
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export default function LeaderboardPage() {
  const [traders, setTraders] = useState<LeaderboardEntry[]>([]);
  const [period, setPeriod] = useState<string>('alltime');
  const [sort, setSort] = useState<string>('pnl');
  const [loading, setLoading] = useState(true);
  const [board, setBoard] = useState<'traders' | 'points'>('traders');
  const [points, setPoints] = useState<PointsEntry[]>([]);
  const [sprint, setSprint] = useState<SprintStatus | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    api.getLeaderboard(period, sort, 100)
      .then((r) => { setTraders(r.traders); setLoadError(null); })
      .catch((e: Error) => setLoadError(e?.message || 'request failed'))
      .finally(() => setLoading(false));
  }, [period, sort]);
  useEffect(() => {
    api.getPointsLeaderboard(1).then((r) => setPoints(r.leaderboard || [])).catch(() => {});
    api.getSprint().then(setSprint).catch(() => {});
  }, []);

  return (
    <div className="page-shell space-y-5">
      {/* Header */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Leaderboard</h1>
          <p className="page-sub">Traders by performance · Season 1 points · the weekly sprint</p>
        </div>
        <Segmented
          options={[{ value: 'traders', label: 'Traders' }, { value: 'points', label: `Points${points.length ? ` · ${points.length}` : ''}` }]}
          value={board}
          onChange={(v) => setBoard(v as 'traders' | 'points')}
        />
      </header>

      {/* Weekly sprint — awarded by the indexer every Monday 00:00 UTC */}
      {sprint && (
        <div className="bg-surface border border-border rounded-xl px-4 py-3 flex flex-wrap items-start gap-4" data-testid="weekly-sprint">
          <div className="min-w-[220px]">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Weekly sprint</p>
            <p className="text-[12px] text-foreground mt-0.5">
              Top 3 traders by volume this week earn <span className="font-mono">{sprint.prizes.map((p) => p.toLocaleString()).join(' / ')}</span> bonus points.
            </p>
            <p className="text-[11px] text-dim mt-0.5">Week resets Monday 00:00 UTC · next award in {fmtCountdown(sprint.awardAt)} · bots excluded</p>
          </div>
          <div className="flex-1 min-w-[240px]">
            {sprint.standings.length > 0 ? (
              <ol className="text-[11.5px] font-mono space-y-0.5">
                {sprint.standings.slice(0, 3).map((s) => (
                  <li key={s.address} className="flex items-center justify-between gap-3">
                    <span className="text-dim w-4">{s.rank}</span>
                    <Link href={`/trader/${s.address}`} className="text-foreground hover:text-primary flex-1">{shortenAddress(s.address, 6)}</Link>
                    <span className="text-foreground/80 tabular-nums">{formatUsd(s.volume)}</span>
                    <span className="text-primary tabular-nums w-16 text-right">+{sprint.prizes[s.rank - 1]?.toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12px] text-dim">Nobody has traded yet this week — the first trade takes the lead. <Link href="/trade" className="text-primary hover:underline">Trade →</Link></p>
            )}
          </div>
          {sprint.lastWinners.length > 0 && (
            <div className="min-w-[200px]">
              <p className="text-[10px] uppercase tracking-wider text-dim">Last week</p>
              <ol className="text-[11px] font-mono mt-0.5 space-y-0.5">
                {sprint.lastWinners.map((w) => (
                  <li key={`${w.week_start}-${w.address}`} className="flex justify-between gap-3">
                    <span className="text-foreground/80">{w.rank}. {shortenAddress(w.address, 4)}</span>
                    <span className="text-primary">+{Number(w.points).toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {board === 'points' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border bg-surface-2/30">
                <th className="text-left px-4 py-2.5 w-16">Rank</th>
                <th className="text-left px-4 py-2.5">Wallet</th>
                <th className="text-right px-4 py-2.5">Total</th>
                <th className="text-right px-4 py-2.5 hidden md:table-cell">Trading</th>
                <th className="text-right px-4 py-2.5 hidden md:table-cell">Node</th>
                <th className="text-right px-4 py-2.5 hidden md:table-cell" title="Maker vault deposits: 0.1 point per MRSN per day">Vault LP</th>
                <th className="text-right px-4 py-2.5 hidden md:table-cell">Referral</th>
                <th className="text-right px-4 py-2.5 hidden md:table-cell">Bonus</th>
                <th className="text-right px-4 py-2.5">Tier</th>
              </tr>
            </thead>
            <tbody>
              {points.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12 text-dim text-xs">No points awarded yet this season.</td></tr>
              ) : points.map((p) => {
                const rb = rankBadge(p.rank);
                return (
                  <tr key={p.address} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-2.5">
                      <span className={cn('inline-flex items-center justify-center w-7 h-7 rounded-md font-mono font-bold text-[12px]', rb ? rb.tone : 'text-dim bg-surface-2')}>{rb ? rb.label : p.rank}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Link href={`/trader/${p.address}`} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                        <AddressAvatar address={p.address} size={26} />
                        <span className="text-foreground font-mono text-[12.5px]">{shortenAddress(p.address, 6)}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-primary">{Math.round(p.totalPoints).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground/70 hidden md:table-cell">{Math.round(p.tradingPoints || 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground/70 hidden md:table-cell">{Math.round(p.nodePoints || 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground/70 hidden md:table-cell">{Math.round(p.lpPoints || 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground/70 hidden md:table-cell">{Math.round(p.referralPoints || 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-foreground/70 hidden md:table-cell">{Math.round(p.bonusPoints || 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right text-[11px] text-dim">{p.tier}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Filters — segmented controls */}
      {board === 'traders' && (
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
      )}

      {/* Mobile: card list */}
      {board === 'traders' && (<>
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
                {t.pnl >= 0 ? '+' : ''}{formatNumber(t.pnl, 2)} <span className="text-[10px] font-normal text-dim">MRSN</span>
              </span>
            </Link>
          );
        }        ) : (
          <div className="text-center py-10 px-4">
            <p className="text-[13px] font-semibold text-foreground">Be the first to make the board</p>
            <p className="text-xs text-dim mt-1">Place a trade to get ranked by PnL, volume, and win rate.</p>
          </div>
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border bg-surface-2/30">
              <th className="text-left px-4 py-2.5 w-16">Rank</th>
              <th className="text-left px-4 py-2.5">Trader</th>
              <th className="text-right px-4 py-2.5" title="Realized profit and loss, settled in MRSN collateral">PnL (MRSN)</th>
              <th className="text-right px-4 py-2.5" title="Notional traded at USD-quoted prices">Volume ($)</th>
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
                    {t.pnl >= 0 ? '+' : ''}{formatNumber(t.pnl, 2)} <span className="text-[10px] font-normal text-dim">MRSN</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-foreground/80 font-mono tabular-nums">{formatUsd(t.volume)}</td>
                  <td className="px-4 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{formatNumber(t.trades, 0)}</td>
                  <td className="px-4 py-2.5 text-right text-foreground/70 font-mono tabular-nums">{t.winRate}%</td>
                </tr>
              );
            }            ) : (
              <tr><td colSpan={6} className="text-center py-14">
                {loadError ? (
                  <>
                    <p className="text-[13px] font-semibold text-foreground">Leaderboard unavailable</p>
                    <p className="text-xs text-dim mt-1">The trade API did not answer ({loadError}). Try again in a moment.</p>
                  </>
                ) : (<>
                <p className="text-[13px] font-semibold text-foreground">Be the first to make the board</p>
                <p className="text-xs text-dim mt-1">Place a trade and you&apos;ll show up here ranked by PnL, volume, and win rate.</p>
                </>)}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      </>)}
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
