'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { api, type PointsResponse, type PointsEntry } from '@/lib/api';
import { formatNumber, shortenAddress, cn } from '@/lib/utils';
import AddressAvatar from '@/components/AddressAvatar';
import NodeRunnerCard from '@/components/points/NodeRunnerCard';

const TIERS = [
  { name: 'Bronze',   min: 0,       tone: 'text-orange',     dot: 'bg-orange' },
  { name: 'Silver',   min: 1000,    tone: 'text-foreground', dot: 'bg-foreground' },
  { name: 'Gold',     min: 10000,   tone: 'text-yellow',     dot: 'bg-yellow' },
  { name: 'Platinum', min: 100000,  tone: 'text-cyan',       dot: 'bg-cyan' },
  { name: 'Diamond',  min: 1000000, tone: 'text-primary',    dot: 'bg-primary' },
];

function tierTone(name: string) {
  const t = TIERS.find((x) => x.name.toLowerCase() === (name || '').toLowerCase());
  return t?.tone || 'text-dim';
}

export default function PointsPage() {
  const { address, isConnected } = useWallet();
  const [points, setPoints] = useState<PointsResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<PointsEntry[]>([]);

  useEffect(() => {
    if (address) api.getPoints(address).then(setPoints).catch(() => {});
    api.getPointsLeaderboard().then((r) => setLeaderboard(r.leaderboard)).catch(() => {});
  }, [address]);

  const currentTier = TIERS.slice().reverse().find((t) => (points?.totalPoints || 0) >= t.min) || TIERS[0];
  const nextTier = TIERS[TIERS.indexOf(currentTier) + 1];
  const progress = nextTier
    ? ((points?.totalPoints || 0) - currentTier.min) / (nextTier.min - currentTier.min) * 100
    : 100;

  return (
    <div className="page-shell space-y-5">
      {/* Header */}
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="page-title">Points & Rewards</h1>
          <span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[9px] font-semibold uppercase tracking-wider">Season 1 · Live</span>
        </div>
        <p className="page-sub">Earn points by trading, running a verified node, referring traders and winning the weekly sprint — liquidity points are next</p>
      </header>

      {/* Trading, node, referral and sprint points are live; LP points wait for the vault. */}
      <div className="flex items-start gap-2.5 bg-primary/[0.06] border border-primary/20 rounded-xl px-4 py-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary shrink-0 mt-0.5">
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
        <p className="text-[12px] leading-relaxed text-foreground/80">
          <span className="text-primary font-semibold">Trading, node-runner, referral and weekly-sprint points are live.</span>{' '}
          Trading points accrue from your on-chain volume (updated every few minutes); a verified node earns 500 points a day while it is online (below); a referrer earns 10% of each referee&apos;s trading points; the top three traders by volume each week (Monday 00:00 UTC) receive 3,000 / 2,000 / 1,000 bonus points — see the <Link href="/leaderboard" className="text-primary hover:underline">leaderboard</Link>. LP points start with the vault.
        </p>
      </div>

      {isConnected && points && (
        <>
          {/* Hero card: tier + total + progress */}
          <div className="bg-surface border border-border rounded-xl p-5 md:p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn('w-2 h-2 rounded-full', currentTier.dot)} />
                  <span className={cn('text-[12px] font-semibold uppercase tracking-wider', currentTier.tone)}>{currentTier.name}</span>
                  <span className="text-[10px] text-dim font-mono">· Rank #{points.rank}</span>
                </div>
                <div className="text-[36px] md:text-[44px] font-mono font-bold text-foreground tabular-nums leading-none">
                  {formatNumber(points.totalPoints, 0)}
                </div>
                <p className="text-[11px] text-dim mt-1.5 uppercase tracking-wider">Total Points</p>
              </div>
              {nextTier && (
                <div className="w-full sm:w-auto sm:min-w-[260px]">
                  <div className="flex items-center justify-between text-[10.5px] text-dim mb-1.5 uppercase tracking-wider">
                    <span>Progress to {nextTier.name}</span>
                    <span className="font-mono tabular-nums text-foreground">{Math.min(progress, 100).toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all duration-500', nextTier.dot)}
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  </div>
                  <p className="text-[10.5px] text-dim mt-1.5 font-mono tabular-nums">
                    {formatNumber(nextTier.min - (points.totalPoints || 0), 0)} more points
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Earn-by-source breakdown */}
          <div className="grid grid-cols-5 gap-3">
            <SourceTile label="Trading"  value={points.tradingPoints} />
            <SourceTile label="Node"     value={points.nodePoints || 0} />
            <SourceTile label="Referral" value={points.referralPoints} />
            <SourceTile label="Sprint"   value={points.bonusPoints || 0} />
            <SourceTile label="LP"       value={points.lpPoints} />
          </div>
        </>
      )}

      <NodeRunnerCard />

      {/* How to earn */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">How to Earn</h3>
        </div>
        <div className="divide-y divide-border">
          {[
            { action: 'Trading',     desc: '1 point per $1 of volume traded',       mult: 'Live',   tone: 'text-primary', live: true  },
            { action: 'Node runner', desc: '500 points per day for a verified, online full node', mult: 'Live', tone: 'text-primary', live: true },
            { action: 'Vault LP',    desc: '2 points per 1 MRSN deposited per day', mult: 'Soon',   tone: 'text-dim',     live: false },
            { action: 'Referrals',   desc: '10% of referee trading points — share your code from the Referrals page; the referee confirms with one signature', mult: 'Live', tone: 'text-primary', live: true },
            { action: 'Weekly sprint', desc: 'Top 3 by volume each week (Monday 00:00 UTC): 3,000 / 2,000 / 1,000 bonus points', mult: 'Live', tone: 'text-primary', live: true },
          ].map((e) => (
            <div key={e.action} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-foreground text-[13px] font-medium">{e.action}</p>
                <p className="text-[11.5px] text-dim mt-0.5">{e.desc}</p>
              </div>
              <span className={cn(
                'font-mono text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded',
                e.live ? 'text-primary bg-primary/10' : 'text-dim bg-surface-2'
              )}>{e.mult}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Points Leaderboard</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border bg-surface-2/30">
              <th className="text-left px-4 py-2 w-16">Rank</th>
              <th className="text-left px-4 py-2">Trader</th>
              <th className="text-right px-4 py-2">Points</th>
              <th className="text-right px-4 py-2">Tier</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length > 0 ? leaderboard.map((e) => (
              <tr key={e.address} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                <td className="px-4 py-2.5">
                  <span className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-md font-mono font-bold text-[12px]',
                    e.rank === 1 ? 'text-yellow bg-yellow/10' :
                    e.rank === 2 ? 'text-foreground bg-surface-2' :
                    e.rank === 3 ? 'text-orange bg-orange/10' : 'text-dim bg-surface-2'
                  )}>{e.rank}</span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <AddressAvatar address={e.address} size={22} />
                    <span className="text-foreground font-mono text-[12.5px]">{shortenAddress(e.address, 6)}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right text-foreground font-mono font-semibold tabular-nums">{formatNumber(e.totalPoints, 0)}</td>
                <td className={cn('px-4 py-2.5 text-right text-[12px] font-semibold uppercase tracking-wider', tierTone(e.tier))}>{e.tier}</td>
              </tr>
            )) : (
              <tr><td colSpan={4} className="text-center py-10 text-dim text-xs">No points earned yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-3.5 py-3 text-center sm:text-left">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className="text-[18px] font-mono font-semibold text-foreground tabular-nums leading-none">{formatNumber(value, 0)}</p>
    </div>
  );
}
