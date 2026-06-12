'use client';
import { useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { api, type PointsResponse, type PointsEntry } from '@/lib/api';
import { formatNumber, shortenAddress, cn } from '@/lib/utils';
import AddressAvatar from '@/components/AddressAvatar';

const TIERS = [
  { name: 'Bronze',   min: 0,      tone: 'text-orange',     dot: 'bg-orange' },
  { name: 'Silver',   min: 1000,   tone: 'text-foreground', dot: 'bg-foreground' },
  { name: 'Gold',     min: 10000,  tone: 'text-yellow',     dot: 'bg-yellow' },
  { name: 'Platinum', min: 50000,  tone: 'text-cyan',       dot: 'bg-cyan' },
  { name: 'Diamond',  min: 200000, tone: 'text-primary',    dot: 'bg-primary' },
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
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">Points & Rewards</h1>
          <span className="px-1.5 py-0.5 bg-yellow/10 text-yellow rounded text-[9px] font-semibold uppercase tracking-wider">Preview · simulated data</span>
        </div>
        <p className="text-dim text-xs md:text-[13px] mt-0.5">Earn points through trading, providing liquidity, and referrals</p>
      </header>

      {/* Honest preview notice — no accrual job writes points yet */}
      <div className="flex items-start gap-2.5 bg-yellow/[0.06] border border-yellow/20 rounded-xl px-4 py-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow shrink-0 mt-0.5">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-[12px] leading-relaxed text-foreground/80">
          <span className="text-yellow font-semibold">Preview.</span>{' '}
          The points program is not live yet — no balances are accrued from fees, LP deposits, or referrals,
          so totals and the leaderboard read zero. The earn rates below are the planned design, shown for reference.
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
          <div className="grid grid-cols-3 gap-3">
            <SourceTile label="Trading"  value={points.tradingPoints} />
            <SourceTile label="LP"       value={points.lpPoints} />
            <SourceTile label="Referral" value={points.referralPoints} />
          </div>
        </>
      )}

      {/* How to earn */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">How to Earn (planned)</h3>
        </div>
        <div className="divide-y divide-border">
          {[
            { action: 'Trading',     desc: '1 point per 1 MRSN in fees paid',      mult: '1×',     tone: 'text-primary' },
            { action: 'Vault LP',    desc: '2 points per 1 MRSN deposited per day', mult: '2×',    tone: 'text-green'   },
            { action: 'Referrals',   desc: '10% of referee trading points',        mult: '0.1×',   tone: 'text-cyan'    },
            { action: 'Competitions',desc: 'Bonus points for top finishers',       mult: 'Varies', tone: 'text-yellow'  },
          ].map((e) => (
            <div key={e.action} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-foreground text-[13px] font-medium">{e.action}</p>
                <p className="text-[11.5px] text-dim mt-0.5">{e.desc}</p>
              </div>
              <span className={cn('font-mono text-[14px] font-semibold tabular-nums', e.tone)}>{e.mult}</span>
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
