'use client';
import { useState, useEffect } from 'react';
import { cn, formatNumber } from '@/lib/utils';
import { api, type FundingComparison, type FundingOpportunity } from '@/lib/api';
import { startPoll } from '@/lib/poll';

function formatRate(rate: number) {
  const pct = (rate * 100).toFixed(4);
  return (rate >= 0 ? '+' : '') + pct + '%';
}

export default function FundingArbPage() {
  const [comparison, setComparison] = useState<FundingComparison[]>([]);
  const [opportunities, setOpportunities] = useState<FundingOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'spread' | 'annualized'>('annualized');

  useEffect(() => {
    async function load() {
      try {
        const [comp, opps] = await Promise.all([
          api.getFundingComparison(),
          api.getFundingOpportunities(),
        ]);
        setComparison(comp.comparison || []);
        setOpportunities(opps.opportunities || []);
      } catch (e) {
        console.error('[funding-arb] load error:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
    return startPoll(load, 30000);
  }, []);

  const sortedOpps = [...opportunities].sort((a, b) =>
    sortBy === 'annualized' ? b.annualized - a.annualized : b.spread - a.spread
  );

  const rateCell = (rate: number) => (
    <span className={cn('font-mono tabular-nums', rate > 0 ? 'text-green' : rate < 0 ? 'text-red' : 'text-dim')}>
      {formatRate(rate)}
    </span>
  );

  return (
    <div className="page-shell space-y-6">
      <div className="text-center mb-8">
        <h1 className="page-title">Funding Rate Arbitrage</h1>
        <p className="page-sub">Cross-exchange funding rate comparison and arbitrage opportunities</p>
      </div>

      {/* External-venue rates (Hyperliquid / dYdX / Binance) are not yet wired to live
          feeds, so this page renders simulated comparison data for preview/demo. */}
      <div className="bg-yellow/10 border border-yellow/40 rounded-lg p-3 flex items-start gap-2.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow shrink-0 mt-0.5">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="text-[12px] leading-relaxed">
          <span className="text-yellow font-semibold">Preview &middot; Simulated data.</span>{' '}
          <span className="text-foreground/80">
            Cross-exchange funding rates and arbitrage opportunities shown here are simulated for demo purposes.
            Live external-venue feeds are not yet connected.
          </span>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4 text-center">
          <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Markets Tracked</p>
          <p className="text-xl font-bold text-foreground font-mono">{comparison.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4 text-center">
          <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Opportunities</p>
          <p className="text-xl font-bold text-cyan font-mono">{opportunities.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4 text-center">
          <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">Best Annualized</p>
          <p className="text-xl font-bold text-green font-mono">
            {sortedOpps.length > 0 ? formatNumber(sortedOpps[0].annualized, 1) + '%' : '—'}
          </p>
        </div>
      </div>

      {/* Cross-Exchange Comparison Table */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Cross-Exchange Funding Rates</h3>
          <p className="text-[10px] text-dim mt-0.5">8-hour funding rates across exchanges</p>
        </div>
        {loading ? (
          <div className="p-8 text-center text-xs text-dim">Loading funding rates...</div>
        ) : comparison.length === 0 ? (
          <div className="p-8 text-center text-xs text-dim">No funding data available</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border">
                  <th className="px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="px-4 py-2 text-right font-medium">Mersennet Trade</th>
                  <th className="px-4 py-2 text-right font-medium">Hyperliquid</th>
                  <th className="px-4 py-2 text-right font-medium">dYdX</th>
                  <th className="px-4 py-2 text-right font-medium">Binance</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((c) => (
                  <tr key={c.symbol} className="border-b border-border last:border-0 hover:bg-surface-2/50 transition-colors">
                    <td className="px-4 py-2.5 font-mono font-medium text-foreground">{c.symbol}</td>
                    <td className="px-4 py-2.5 text-right">{rateCell(c.mersennetTrade)}</td>
                    <td className="px-4 py-2.5 text-right">{rateCell(c.hyperliquid)}</td>
                    <td className="px-4 py-2.5 text-right">{rateCell(c.dydx)}</td>
                    <td className="px-4 py-2.5 text-right">{rateCell(c.binance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Arbitrage Opportunities */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Arbitrage Opportunities</h3>
            <p className="text-[10px] text-dim mt-0.5">Sorted by potential return</p>
          </div>
          <div className="flex gap-1 bg-surface-2 rounded-lg p-0.5">
            <button
              onClick={() => setSortBy('annualized')}
              className={cn(
                'px-3 py-1 text-[11px] rounded-md transition-all duration-200',
                sortBy === 'annualized'
                  ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(43,217,106,0.2)]'
                  : 'text-dim hover:text-muted'
              )}
            >
              Annualized
            </button>
            <button
              onClick={() => setSortBy('spread')}
              className={cn(
                'px-3 py-1 text-[11px] rounded-md transition-all duration-200',
                sortBy === 'spread'
                  ? 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(43,217,106,0.2)]'
                  : 'text-dim hover:text-muted'
              )}
            >
              Spread
            </button>
          </div>
        </div>
        {loading ? (
          <div className="p-8 text-center text-xs text-dim">Loading opportunities...</div>
        ) : sortedOpps.length === 0 ? (
          <div className="p-8 text-center text-xs text-dim">No arbitrage opportunities found</div>
        ) : (
          <div className="divide-y divide-border">
            {sortedOpps.map((opp, i) => (
              <div key={`${opp.symbol}-${i}`} className="px-4 py-4 hover:bg-surface-2/50 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono font-bold text-foreground">{opp.symbol}</span>
                    <span className={cn(
                      'text-[10px] px-2 py-0.5 rounded-full font-medium',
                      opp.annualized >= 50 ? 'bg-green/10 text-green' : opp.annualized >= 20 ? 'bg-cyan/10 text-cyan' : 'bg-yellow/10 text-yellow'
                    )}>
                      {opp.annualized >= 50 ? 'High Yield' : opp.annualized >= 20 ? 'Medium' : 'Low'}
                    </span>
                  </div>
                  <span className="text-lg font-bold text-green font-mono">
                    {formatNumber(opp.annualized, 1)}% <span className="text-[10px] text-dim font-normal">APR</span>
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-4 text-xs">
                  <div>
                    <p className="text-[10px] text-dim uppercase tracking-wider font-medium">Long On</p>
                    <p className="text-foreground font-medium mt-0.5">{opp.long_exchange}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-dim uppercase tracking-wider font-medium">Short On</p>
                    <p className="text-foreground font-medium mt-0.5">{opp.short_exchange}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-dim uppercase tracking-wider font-medium">8h Spread</p>
                    <p className="text-cyan font-mono font-medium mt-0.5">{formatRate(opp.spread)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-dim uppercase tracking-wider font-medium">Annualized</p>
                    <p className="text-green font-mono font-medium mt-0.5">{formatNumber(opp.annualized, 1)}%</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
