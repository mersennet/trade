'use client';
import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/shared/Toast';
import { useWallet } from '@/hooks/useWallet';
import { api, type GovernanceProposal } from '@/lib/api';

function votePct(forV: number, againstV: number) {
  const total = forV + againstV;
  if (total === 0) return { forPct: 50, againstPct: 50 };
  return { forPct: (forV / total) * 100, againstPct: (againstV / total) * 100 };
}

function fmtVotes(n: number) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toString();
}

const GOV_VOTES_KEY = 'mersennet-trade_gov_votes';
const LEGACY_GOV_VOTES_KEY = 'pt_gov_votes';

function loadVotedOn(): Record<number, 'for' | 'against'> {
  try {
    let v = localStorage.getItem(GOV_VOTES_KEY);
    if (!v) {
      const legacy = localStorage.getItem(LEGACY_GOV_VOTES_KEY);
      if (legacy) {
        localStorage.setItem(GOV_VOTES_KEY, legacy);
        localStorage.removeItem(LEGACY_GOV_VOTES_KEY);
        v = legacy;
      }
    }
    return v ? JSON.parse(v) : {};
  } catch { return {}; }
}

export default function GovernancePage() {
  const [filter, setFilter] = useState<'all' | 'active' | 'passed' | 'rejected'>('all');
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [votedOn, setVotedOn] = useState<Record<number, 'for' | 'against'>>({});
  const [votingPower, setVotingPower] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDays, setNewDays] = useState('7');
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();
  const { address, isConnected } = useWallet();

  useEffect(() => { setVotedOn(loadVotedOn()); }, []);

  const fetchProposals = useCallback(async () => {
    try {
      const res = await api.getProposals(filter);
      setProposals(res.proposals || []);
    } catch {
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  useEffect(() => {
    if (!address) { setVotingPower(0); return; }
    api.getVotingPower(address).then((r) => setVotingPower(r.votingPower)).catch(() => {});
  }, [address]);

  const handleVote = async (proposalId: number, direction: 'for' | 'against') => {
    if (!address) {
      toast('Connect wallet to vote', 'error');
      return;
    }
    if (votedOn[proposalId]) {
      toast('You have already voted on this proposal', 'error');
      return;
    }
    if (votingPower <= 0) {
      toast('You have no voting power. Stake MRSN to cast a weighted vote.', 'warning');
      return;
    }
    try {
      const res = await api.voteOnProposal(proposalId, address, direction);
      const next = { ...votedOn, [proposalId]: direction };
      setVotedOn(next);
      localStorage.setItem(GOV_VOTES_KEY, JSON.stringify(next));
      toast(`Voted ${direction} on PIP-${proposalId} (${res.votingPower} power)`, 'success');
      fetchProposals();
    } catch (e) {
      toast(`Vote failed: ${(e as Error).message}`, 'error');
    }
  };

  const handleCreateProposal = async () => {
    if (!address) { toast('Connect wallet first', 'error'); return; }
    if (!newTitle.trim() || !newDesc.trim()) { toast('Title and description required', 'error'); return; }
    setCreating(true);
    try {
      await api.createProposal(newTitle.trim(), newDesc.trim(), address, Number(newDays) || 7);
      toast('Proposal created!', 'success');
      setNewTitle(''); setNewDesc(''); setShowCreate(false);
      fetchProposals();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    } finally { setCreating(false); }
  };

  const filtered = proposals.filter((p) => filter === 'all' || p.status === filter);

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-foreground mb-2">Governance</h2>
        <p className="text-dim text-sm">Vote on proposals to shape the future of Mersennet Trade</p>
      </div>

      {/* Votes are unsigned and voting power doesn't yet read the on-chain
          staking precompile — this is a preview, and hiding that would be
          worse than the missing feature. */}
      <div className="max-w-2xl mx-auto flex items-start gap-2 px-4 py-3 rounded-lg bg-yellow/10 border border-yellow/30">
        <span className="text-yellow text-sm leading-none mt-0.5">⚠</span>
        <p className="text-xs text-yellow/90 leading-relaxed">
          Preview — governance is not yet on-chain. Votes are advisory and voting power is not
          linked to your staked MRSN on the staking precompile yet.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Your Voting Power</div>
          <div className="text-xl font-bold text-foreground">{isConnected ? votingPower.toLocaleString() : '—'}</div>
          <div className="text-[11px] text-muted mt-1">Preview — not yet linked to on-chain stake</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Active Proposals</div>
          <div className="text-xl font-bold text-primary">{proposals.filter((p) => p.status === 'active').length}</div>
          <div className="text-[11px] text-muted mt-1">Awaiting votes</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Passed Proposals</div>
          <div className="text-xl font-bold text-green">{proposals.filter((p) => p.status === 'passed').length}</div>
          <div className="text-[11px] text-muted mt-1">Successfully approved</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Total Proposals</div>
          <div className="text-xl font-bold text-foreground">{proposals.length}</div>
          <div className="text-[11px] text-muted mt-1">All time</div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-surface-2 rounded-lg p-0.5">
          {(['all', 'active', 'passed', 'rejected'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-4 py-2 text-sm rounded-md transition-all duration-200 capitalize',
                filter === f
                  ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(125,255,155,0.2)]'
                  : 'text-dim hover:text-muted'
              )}
            >
              {f}
            </button>
          ))}
        </div>
        {isConnected && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-medium hover:shadow-[0_0_16px_rgba(125,255,155,0.15)] transition-all duration-200"
          >
            {showCreate ? 'Cancel' : '+ New Proposal'}
          </button>
        )}
      </div>

      {showCreate && (
        <div className="bg-surface border border-primary/20 rounded-xl p-5 space-y-3">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Create Proposal</h3>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Proposal title"
            className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors"
          />
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Describe your proposal..."
            rows={4}
            className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors resize-none"
          />
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-dim uppercase tracking-wider font-medium">Voting Period</label>
              <select
                value={newDays}
                onChange={(e) => setNewDays(e.target.value)}
                className="bg-surface-2 border border-border rounded-lg px-2 py-1.5 text-sm text-foreground outline-none"
              >
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </select>
            </div>
            <div className="flex-1" />
            <p className="text-[10px] text-dim">Requires 100+ staked MRSN</p>
            <button
              onClick={handleCreateProposal}
              disabled={creating}
              className="px-5 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-medium disabled:opacity-50 transition-all duration-200"
            >
              {creating ? 'Creating...' : 'Submit Proposal'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {loading && (
          <div className="bg-surface border border-border rounded-xl p-8 text-center text-dim text-xs">
            Loading proposals...
          </div>
        )}
        {!loading && filtered.map((p) => {
          const { forPct, againstPct } = votePct(Number(p.for_votes), Number(p.against_votes));
          return (
            <div key={p.id} className="bg-surface border border-border rounded-xl p-5 space-y-4 hover:border-primary/20 transition-colors duration-200">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-dim">PIP-{p.id}</span>
                    <span
                      className={cn(
                        'text-[10px] px-2 py-0.5 rounded-full font-medium',
                        p.status === 'active' && 'bg-primary/10 text-primary',
                        p.status === 'passed' && 'bg-green/10 text-green',
                        p.status === 'rejected' && 'bg-red/10 text-red'
                      )}
                    >
                      {p.status}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">{p.title}</h3>
                  <p className="text-xs text-muted mt-1 leading-relaxed">{p.description}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-dim uppercase tracking-wider font-medium">
                    {p.status === 'active' ? 'Ends' : 'Status'}
                  </div>
                  <div className={cn('text-xs font-mono mt-0.5', p.status === 'active' ? 'text-yellow' : 'text-muted')}>
                    {p.end_time ? new Date(p.end_time).toLocaleDateString() : p.status}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-green font-medium">For {forPct.toFixed(1)}%</span>
                  <span className="text-red font-medium">Against {againstPct.toFixed(1)}%</span>
                </div>
                <div className="h-2 bg-surface-2 rounded-full overflow-hidden flex">
                  <div className="bg-green/60 rounded-l-full transition-all duration-500" style={{ width: `${forPct}%` }} />
                  <div className="bg-red/60 rounded-r-full transition-all duration-500" style={{ width: `${againstPct}%` }} />
                </div>
                <div className="flex items-center justify-between text-[10px] text-dim font-mono">
                  <span>{fmtVotes(Number(p.for_votes))} MRSN</span>
                  <span>{fmtVotes(Number(p.against_votes))} MRSN</span>
                </div>
              </div>

              {p.status === 'active' && (
                <div className="flex gap-2 pt-1">
                  {votedOn[p.id] ? (
                    <div className={cn(
                      'flex-1 py-2 text-xs font-medium rounded-lg text-center border',
                      votedOn[p.id] === 'for'
                        ? 'bg-green/15 text-green border-green/20'
                        : 'bg-red/15 text-red border-red/20'
                    )}>
                      Voted {votedOn[p.id] === 'for' ? 'For' : 'Against'}
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => handleVote(p.id, 'for')}
                        className="flex-1 py-2 text-xs font-medium rounded-lg bg-green/10 text-green hover:bg-green/20 transition-colors duration-200 border border-green/10"
                      >
                        Vote For
                      </button>
                      <button
                        onClick={() => handleVote(p.id, 'against')}
                        className="flex-1 py-2 text-xs font-medium rounded-lg bg-red/10 text-red hover:bg-red/20 transition-colors duration-200 border border-red/10"
                      >
                        Vote Against
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div className="bg-surface border border-border rounded-xl p-10 text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-primary/8 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary/50">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              </svg>
            </div>
            {proposals.length === 0 ? (
              <>
                <h3 className="text-sm font-medium text-foreground mb-1">Governance Launching Soon</h3>
                <p className="text-xs text-dim max-w-lg mx-auto mb-5">
                  Stake MRSN to earn voting power and help shape the future of Mersennet Trade. Proposals will cover fee structures, new market listings, and protocol upgrades.
                </p>
                <div className="flex items-center justify-center gap-4">
                  <div className="bg-surface-2 rounded-lg px-4 py-2.5 text-center">
                    <p className="text-[10px] text-dim uppercase tracking-wider mb-0.5">Quorum</p>
                    <p className="text-sm font-semibold text-foreground font-mono">10%</p>
                  </div>
                  <div className="bg-surface-2 rounded-lg px-4 py-2.5 text-center">
                    <p className="text-[10px] text-dim uppercase tracking-wider mb-0.5">Voting Period</p>
                    <p className="text-sm font-semibold text-foreground">7 Days</p>
                  </div>
                  <div className="bg-surface-2 rounded-lg px-4 py-2.5 text-center">
                    <p className="text-[10px] text-dim uppercase tracking-wider mb-0.5">Min Power</p>
                    <p className="text-sm font-semibold text-foreground font-mono">100 MRSN</p>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-xs text-dim">No proposals match this filter</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
