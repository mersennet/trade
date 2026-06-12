'use client';
import { useEffect, useState, useCallback } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type TradingAgent, type AgentPerformance, type Market } from '@/lib/api';
import { formatNumber, formatUsd, cn } from '@/lib/utils';

const STRATEGIES = [
  { value: 'momentum', label: 'Momentum', desc: 'Follows price trends using moving averages and RSI. Works best in trending markets.' },
  { value: 'meanReversion', label: 'Mean Reversion', desc: 'Trades price deviations from a rolling mean, expecting reversion. Best in ranging markets.' },
  { value: 'grid', label: 'Grid Trading', desc: 'Places layered buy/sell orders at fixed intervals. Profits from oscillation within a range.' },
];

export default function AIAgentsPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [agents, setAgents] = useState<TradingAgent[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [perfMap, setPerfMap] = useState<Record<number, AgentPerformance>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', strategy: 'momentum', markets: [] as number[], maxPosition: '1000', stopLoss: '5' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.getMarkets().then((d) => setMarkets(d.markets || [])).catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    if (!address) return;
    api.getAgents(address).then((d) => {
      setAgents(d.agents || []);
      (d.agents || []).forEach((a) => {
        api.getAgentPerformance(a.id).then((p) => setPerfMap((prev) => ({ ...prev, [a.id]: p }))).catch(() => {});
      });
    }).catch(() => {});
  }, [address]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!showCreate) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowCreate(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showCreate]);

  const handleCreate = async () => {
    if (!address || !form.name || form.markets.length === 0) {
      toast('Fill in all required fields', 'warning');
      return;
    }
    setSubmitting(true);
    try {
      await api.createAgent({
        owner: address,
        name: form.name,
        strategy: form.strategy,
        markets: form.markets,
        params: {},
        risk_limits: { max_position: Number(form.maxPosition), stop_loss_pct: Number(form.stopLoss) },
      });
      toast(`Agent "${form.name}" created`, 'success');
      setShowCreate(false);
      setForm({ name: '', strategy: 'momentum', markets: [], maxPosition: '1000', stopLoss: '5' });
      refresh();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (agent: TradingAgent) => {
    if (!address) { toast('Connect wallet first', 'error'); return; }
    try {
      if (agent.status === 'running') {
        await api.stopAgent(agent.id, address);
        toast(`Agent "${agent.name}" stopped`, 'info');
      } else {
        await api.startAgent(agent.id, address);
        toast(`Agent "${agent.name}" started`, 'success');
      }
      refresh();
    } catch (e) {
      toast(`Failed: ${(e as Error).message}`, 'error');
    }
  };

  const toggleMarket = (id: number) => {
    setForm((f) => ({
      ...f,
      markets: f.markets.includes(id) ? f.markets.filter((m) => m !== id) : [...f.markets, id],
    }));
  };

  return (
    <div className="p-3 md:p-4 max-w-full space-y-4">
      <div className="text-center mb-8">
        <div className="flex items-center justify-center gap-2 mb-2">
          <h2 className="text-2xl font-bold text-foreground">AI Trading Agents</h2>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow/10 text-yellow text-[10px] font-semibold uppercase tracking-wider">
            Preview · simulated
          </span>
        </div>
        <p className="text-dim text-sm">Configure automated strategies. Agents do not yet trade live — performance is simulated.</p>
      </div>
      {isConnected && (
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-semibold hover:shadow-[0_0_16px_rgba(139,92,246,0.15)] transition-all duration-200"
          >
            + Create Agent
          </button>
        </div>
      )}

      {/* Agent grid */}
      {!isConnected ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] text-center">
          <div className="w-16 h-16 bg-surface-2 rounded-2xl flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-foreground mb-2">Connect Wallet to Start</h3>
          <p className="text-dim text-sm max-w-md">Connect your wallet to create and manage AI trading agents that execute strategies autonomously.</p>
        </div>
      ) : agents.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center justify-center min-h-[40vh] text-center">
          <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-foreground mb-2">No Agents Yet</h3>
          <p className="text-dim text-sm max-w-md mb-6">Create your first AI agent to automate your trading with proven strategies.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full">
            {STRATEGIES.map((s) => (
              <div key={s.value} className="bg-surface border border-border rounded-xl p-4 text-left">
                <h4 className="text-sm font-semibold text-foreground mb-1">{s.label}</h4>
                <p className="text-[11px] text-dim leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents.map((agent) => {
            const perf = perfMap[agent.id];
            const isRunning = agent.status === 'running';
            return (
              <div key={agent.id} className="bg-surface border border-border rounded-xl p-4 hover:border-primary/20 transition-all duration-300">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={cn('w-2 h-2 rounded-full', isRunning ? 'bg-green animate-pulse' : 'bg-dim')} />
                    <h4 className="text-sm font-semibold text-foreground">{agent.name}</h4>
                  </div>
                  <span className={cn(
                    'text-[10px] px-2 py-0.5 rounded-md font-medium uppercase',
                    isRunning ? 'bg-green/10 text-green' : 'bg-surface-2 text-dim'
                  )}>{agent.status}</span>
                </div>

                <div className="bg-surface-2 rounded-lg p-3 mb-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] text-dim uppercase tracking-wider">Strategy</span>
                    <span className="text-xs text-cyan font-medium">{STRATEGIES.find((s) => s.value === agent.strategy)?.label || agent.strategy}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-dim uppercase tracking-wider">Markets</span>
                    <span className="text-xs text-foreground/70 font-mono">{agent.markets.length} active</span>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="text-center">
                    <p className="text-[9px] text-dim uppercase tracking-wider">PnL</p>
                    <p className={cn('text-sm font-mono font-bold', agent.pnl >= 0 ? 'text-green' : 'text-red')}>
                      {agent.pnl >= 0 ? '+' : ''}{formatUsd(agent.pnl)}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-[9px] text-dim uppercase tracking-wider">Trades</p>
                    <p className="text-sm font-mono text-foreground">{agent.trades}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[9px] text-dim uppercase tracking-wider">Win Rate</p>
                    <p className="text-sm font-mono text-foreground">{perf ? perf.winRate.toFixed(1) + '%' : '—'}</p>
                  </div>
                </div>

                {perf && (
                  <div className="bg-surface-2 rounded-lg p-2 mb-3">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-dim">Sharpe</span>
                      <span className="text-cyan font-mono">{perf.sharpe.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-[10px] mt-1">
                      <span className="text-dim">Max Drawdown</span>
                      <span className="text-red font-mono">{perf.maxDrawdown.toFixed(1)}%</span>
                    </div>
                  </div>
                )}

                <button
                  onClick={() => handleToggle(agent)}
                  className={cn(
                    'w-full py-2 rounded-lg text-xs font-semibold transition-all duration-200',
                    isRunning
                      ? 'bg-red/10 text-red hover:bg-red/20'
                      : 'bg-green/10 text-green hover:bg-green/20'
                  )}
                >
                  {isRunning ? 'Stop Agent' : 'Start Agent'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Create agent modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowCreate(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="create-agent-title" className="bg-surface border border-border rounded-2xl p-6 w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 id="create-agent-title" className="text-lg font-bold text-foreground">Create Agent</h3>
              <button onClick={() => setShowCreate(false)} aria-label="Close" className="text-dim hover:text-foreground text-xl leading-none">&times;</button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Agent Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="My Trading Bot"
                  className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/40 transition-colors"
                />
              </div>

              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Strategy</label>
                <div className="space-y-2">
                  {STRATEGIES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setForm((f) => ({ ...f, strategy: s.value }))}
                      className={cn(
                        'w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-200',
                        form.strategy === s.value
                          ? 'border-primary/30 bg-primary/5'
                          : 'border-border bg-surface-2 hover:border-border/80'
                      )}
                    >
                      <span className={cn('text-xs font-semibold', form.strategy === s.value ? 'text-primary' : 'text-foreground')}>{s.label}</span>
                      <p className="text-[10px] text-dim mt-0.5">{s.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Markets</label>
                <div className="flex flex-wrap gap-1.5">
                  {markets.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => toggleMarket(m.id)}
                      className={cn(
                        'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-200 border',
                        form.markets.includes(m.id)
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-border bg-surface-2 text-dim hover:text-muted'
                      )}
                    >{m.symbol}</button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Max Position ($)</label>
                  <input type="number" value={form.maxPosition} onChange={(e) => setForm((f) => ({ ...f, maxPosition: e.target.value }))} className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors" />
                </div>
                <div>
                  <label className="text-[10px] text-dim uppercase tracking-wider font-medium block mb-1">Stop Loss (%)</label>
                  <input type="number" value={form.stopLoss} onChange={(e) => setForm((f) => ({ ...f, stopLoss: e.target.value }))} className="w-full bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground font-mono outline-none focus:border-primary/40 transition-colors" />
                </div>
              </div>

              <button
                onClick={handleCreate}
                disabled={submitting || !form.name || form.markets.length === 0}
                className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:shadow-[0_0_16px_rgba(139,92,246,0.15)] transition-all duration-200"
              >
                {submitting ? 'Creating...' : 'Create Agent'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
