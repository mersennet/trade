'use client';
import { useState, useEffect, useCallback } from 'react';
import { cn, formatNumber, shortenAddress, formatTimeAgo } from '@/lib/utils';
import { useToast } from '@/components/shared/Toast';
import { useWallet } from '@/hooks/useWallet';
import { api, type MarketProposal } from '@/lib/api';

function votePct(forV: number, againstV: number) {
  const total = forV + againstV;
  if (total === 0) return { forPct: 50, againstPct: 50 };
  return { forPct: (forV / total) * 100, againstPct: (againstV / total) * 100 };
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow/10 text-yellow',
  approved: 'bg-green/10 text-green',
  rejected: 'bg-red/10 text-red',
  active: 'bg-primary/10 text-primary',
};

export default function CreateMarketPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [proposals, setProposals] = useState<MarketProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [symbol, setSymbol] = useState('');
  const [baseAsset, setBaseAsset] = useState('');
  const [quoteAsset, setQuoteAsset] = useState('USDC');
  const [maxLeverage, setMaxLeverage] = useState(20);

  const fetchProposals = useCallback(async () => {
    try {
      const res = await api.getMarketProposals();
      setProposals(res.proposals || []);
    } catch {
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  const handleSubmit = async () => {
    if (!address) { toast('Connect wallet to propose a market', 'error'); return; }
    if (!symbol.trim() || !baseAsset.trim() || !quoteAsset.trim()) {
      toast('Fill in all fields', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await api.proposeMarket({
        proposer: address,
        symbol: symbol.trim().toUpperCase(),
        base: baseAsset.trim().toUpperCase(),
        quote: quoteAsset.trim().toUpperCase(),
        max_leverage: maxLeverage,
      });
      toast('Market proposal submitted!', 'success');
      setSymbol('');
      setBaseAsset('');
      setQuoteAsset('USDC');
      setMaxLeverage(20);
      fetchProposals();
    } catch (e) {
      toast(`Proposal failed: ${(e as Error).message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVote = async (id: number, direction: 'for' | 'against') => {
    if (!address) { toast('Connect wallet to vote', 'error'); return; }
    try {
      await api.voteOnMarketProposal(id, address, direction);
      toast(`Voted ${direction} on proposal #${id}`, 'success');
      fetchProposals();
    } catch (e) {
      toast(`Vote failed: ${(e as Error).message}`, 'error');
    }
  };

  const activeProposals = proposals.filter((p) => p.status === 'pending' || p.status === 'active');
  const pastProposals = proposals.filter((p) => p.status === 'approved' || p.status === 'rejected');

  return (
    <div className="p-4 max-w-full space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-foreground mb-2">Create Market</h2>
        <p className="text-dim text-sm">Propose new perpetual markets through permissionless listing</p>
      </div>

      {/* Proposal Form */}
      <div className="bg-surface border border-primary/20 rounded-xl p-5 space-y-4 shadow-[0_0_24px_rgba(125,255,155,0.04)]">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Propose New Market</h3>
            <p className="text-[10px] text-dim">Requires 1,000 MRSN stake to submit</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Symbol</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="e.g. DOGE/USDC"
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Base Asset</label>
            <input
              value={baseAsset}
              onChange={(e) => setBaseAsset(e.target.value)}
              placeholder="e.g. DOGE"
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1 block">Quote Asset</label>
            <input
              value={quoteAsset}
              onChange={(e) => setQuoteAsset(e.target.value)}
              placeholder="USDC"
              className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors font-mono"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] text-dim uppercase tracking-wider font-medium">Max Leverage</label>
            <span className="text-sm font-bold text-primary font-mono">{maxLeverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            value={maxLeverage}
            onChange={(e) => setMaxLeverage(Number(e.target.value))}
            className="w-full h-1.5 bg-surface-2 rounded-full appearance-none cursor-pointer accent-primary"
          />
          <div className="flex justify-between text-[10px] text-dim font-mono mt-1">
            <span>1x</span>
            <span>25x</span>
            <span>50x</span>
            <span>100x</span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-yellow/10 rounded-md flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <span className="text-xs text-dim">Stake required: <span className="text-yellow font-semibold font-mono">1,000 MRSN</span></span>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting || !isConnected}
            className="px-6 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:shadow-[0_0_16px_rgba(139,92,246,0.15)] transition-all duration-200"
          >
            {submitting ? 'Submitting...' : 'Submit Proposal'}
          </button>
        </div>
      </div>

      {/* Active Proposals */}
      <div>
        <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">
          Active Proposals ({activeProposals.length})
        </h3>
        <div className="space-y-3">
          {loading && (
            <div className="bg-surface border border-border rounded-xl p-8 text-center text-dim text-xs">Loading proposals...</div>
          )}
          {!loading && activeProposals.length === 0 && (
            <div className="bg-surface border border-border rounded-xl p-8 text-center text-dim text-xs">No active proposals</div>
          )}
          {!loading && activeProposals.map((p) => {
            const { forPct, againstPct } = votePct(p.votes_for, p.votes_against);
            return (
              <div key={p.id} className="bg-surface border border-border rounded-xl p-5 space-y-3 hover:border-primary/20 transition-colors duration-200">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold text-foreground font-mono">{p.symbol}</span>
                      <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium capitalize', STATUS_STYLES[p.status] || 'bg-surface-2 text-dim')}>
                        {p.status}
                      </span>
                      <span className="text-[10px] text-dim font-mono">{p.max_leverage}x max</span>
                    </div>
                    <p className="text-[11px] text-muted">
                      {p.base}/{p.quote}, proposed by {shortenAddress(p.proposer)}
                    </p>
                    <p className="text-[10px] text-dim mt-0.5">{formatTimeAgo(p.created_at)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] text-dim uppercase tracking-wider font-medium">Stake</p>
                    <p className="text-xs font-semibold text-yellow font-mono">{formatNumber(p.stake_amount)} MRSN</p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-green font-medium">For {forPct.toFixed(1)}%</span>
                    <span className="text-red font-medium">Against {againstPct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-surface-2 rounded-full overflow-hidden flex">
                    <div className="bg-green/60 rounded-l-full transition-all duration-500" style={{ width: `${forPct}%` }} />
                    <div className="bg-red/60 rounded-r-full transition-all duration-500" style={{ width: `${againstPct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-dim font-mono">
                    <span>{formatNumber(p.votes_for)} MRSN</span>
                    <span>{formatNumber(p.votes_against)} MRSN</span>
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
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
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Past Proposals */}
      {!loading && pastProposals.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider mb-3">
            Past Proposals ({pastProposals.length})
          </h3>
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="grid grid-cols-5 px-4 py-2 text-[10px] text-dim uppercase tracking-wider border-b border-border">
              <span>Symbol</span>
              <span>Pair</span>
              <span>Leverage</span>
              <span>Votes</span>
              <span className="text-right">Status</span>
            </div>
            {pastProposals.map((p) => (
              <div key={p.id} className="grid grid-cols-5 px-4 py-3 text-xs border-b border-border last:border-0 hover:bg-surface-2/50 transition-colors">
                <span className="font-mono text-foreground font-medium">{p.symbol}</span>
                <span className="text-muted">{p.base}/{p.quote}</span>
                <span className="font-mono text-dim">{p.max_leverage}x</span>
                <span className="font-mono text-dim">
                  <span className="text-green">{formatNumber(p.votes_for)}</span>
                  {' / '}
                  <span className="text-red">{formatNumber(p.votes_against)}</span>
                </span>
                <span className="text-right">
                  <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium capitalize', STATUS_STYLES[p.status] || 'bg-surface-2 text-dim')}>
                    {p.status}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
