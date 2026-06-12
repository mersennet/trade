'use client';
import { useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type Competition, type CompetitionDetail } from '@/lib/api';
import { formatUsd, shortenAddress, cn } from '@/lib/utils';
import AddressAvatar from '@/components/AddressAvatar';

function statusTone(status: string) {
  if (status === 'active')   return 'bg-green/10 text-green';
  if (status === 'upcoming') return 'bg-yellow/10 text-yellow';
  return 'bg-surface-2 text-dim';
}

export default function CompetitionsPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selected, setSelected] = useState<CompetitionDetail | null>(null);

  useEffect(() => {
    api.getCompetitions().then((r) => setCompetitions(r.competitions)).catch(() => {});
  }, []);

  const handleJoin = async (id: number) => {
    if (!address) { toast('Connect wallet first', 'error'); return; }
    try {
      await api.joinCompetition(id, address);
      toast('Joined competition!', 'success');
    } catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
  };

  const viewDetails = async (id: number) => {
    try {
      const detail = await api.getCompetition(id);
      setSelected(detail);
    } catch (e) {
      toast(`Could not load standings: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <header>
        <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight">Trading Competitions</h1>
        <p className="text-dim text-xs md:text-[13px] mt-0.5">Compete with other traders for prize pools</p>
      </header>

      {selected ? (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
            <button
              onClick={() => setSelected(null)}
              className="text-[11.5px] text-dim hover:text-foreground transition-colors flex items-center gap-1.5"
            >
              <span>←</span> Back to all
            </button>
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider', statusTone(selected.competition.status))}>
              {selected.competition.status}
            </span>
          </div>

          <div className="p-4 md:p-5">
            <h3 className="text-[18px] font-semibold text-foreground mb-1">{selected.competition.name}</h3>
            <p className="text-[12.5px] text-dim mb-4 leading-relaxed">{selected.competition.description}</p>

            <div className="grid grid-cols-3 gap-3 mb-5">
              <DetailTile label="Type"       value={selected.competition.comp_type} valueClass="capitalize" />
              <DetailTile label="Prize Pool" value={formatUsd(selected.competition.prize_pool)} valueClass="text-yellow" />
              <DetailTile
                label="Status"
                value={selected.competition.status}
                valueClass={cn('capitalize', selected.competition.status === 'active' ? 'text-green' : 'text-dim')}
              />
            </div>

            <div className="bg-surface-2/30 border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <h4 className="text-[10px] font-semibold text-dim uppercase tracking-wider">Standings</h4>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-dim text-[10px] uppercase tracking-wider font-medium border-b border-border">
                    <th className="text-left px-3 py-2 w-14">Rank</th>
                    <th className="text-left px-3 py-2">Trader</th>
                    <th className="text-right px-3 py-2">PnL</th>
                    <th className="text-right px-3 py-2">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.standings.length > 0 ? selected.standings.map((s) => (
                    <tr key={s.address} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                      <td className="px-3 py-2.5">
                        <span className={cn(
                          'inline-flex items-center justify-center w-6 h-6 rounded-md font-mono font-bold text-[11px]',
                          s.rank === 1 ? 'text-yellow bg-yellow/10' :
                          s.rank === 2 ? 'text-foreground bg-surface-2' :
                          s.rank === 3 ? 'text-orange bg-orange/10' : 'text-dim bg-surface-2'
                        )}>{s.rank}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <AddressAvatar address={s.address} size={20} />
                          <span className="text-foreground font-mono text-[12px]">{shortenAddress(s.address)}</span>
                        </div>
                      </td>
                      <td className={cn('px-3 py-2.5 text-right font-mono font-semibold tabular-nums', s.pnl >= 0 ? 'text-green' : 'text-red')}>
                        {s.pnl >= 0 ? '+' : ''}{formatUsd(s.pnl)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-foreground font-mono tabular-nums">{formatUsd(s.volume)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={4} className="text-center py-8 text-dim text-xs">No participants yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {competitions.length > 0 ? competitions.map((c) => (
            <div key={c.id} className="bg-surface border border-border rounded-xl p-4 hover:border-primary/30 hover:bg-surface-2/30 transition-colors">
              <div className="flex items-start justify-between mb-2 gap-2">
                <h3 className="text-[15px] font-semibold text-foreground tracking-tight">{c.name}</h3>
                <span className={cn('shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider', statusTone(c.status))}>
                  {c.status}
                </span>
              </div>
              <p className="text-[12.5px] text-dim mb-3 leading-relaxed line-clamp-2">{c.description}</p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <DetailTile label="Prize" value={formatUsd(c.prize_pool)} valueClass="text-yellow" />
                <DetailTile label="Type"  value={c.comp_type} valueClass="capitalize" />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => viewDetails(c.id)}
                  className="flex-1 px-3 py-2 bg-surface-2 hover:bg-surface-2/70 text-foreground border border-border rounded-md text-[12px] font-semibold transition-colors"
                >
                  View Standings
                </button>
                {(c.status === 'active' || c.status === 'upcoming') && isConnected && (
                  <button
                    onClick={() => handleJoin(c.id)}
                    className="flex-1 px-3 py-2 bg-primary hover:bg-primary-hover text-white rounded-md text-[12px] font-semibold transition-colors"
                  >
                    Join
                  </button>
                )}
              </div>
            </div>
          )) : (
            <div className="md:col-span-2 bg-surface border border-border rounded-xl p-10 text-center">
              <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-surface-2 flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-dim">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </div>
              <h3 className="text-[14px] font-semibold text-foreground mb-1">Competitions coming soon</h3>
              <p className="text-[12px] text-dim max-w-sm mx-auto">
                Trading competitions with prize pools are being prepared. Follow our announcements to be the first to compete.
              </p>
              <div className="flex items-center justify-center gap-2 mt-5 flex-wrap">
                <DetailTile label="Prize pools" value="Up to $50K" />
                <DetailTile label="Types"       value="PnL & Volume" />
                <DetailTile label="Duration"    value="Weekly" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailTile({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-surface-2/40 border border-border/60 rounded-md px-3 py-2 min-w-[120px]">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-0.5">{label}</p>
      <p className={cn('text-[13px] font-mono font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>{value}</p>
    </div>
  );
}
