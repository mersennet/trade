'use client';
import { useState, useEffect, useCallback } from 'react';
import { cn, formatNumber, formatPrice } from '@/lib/utils';
import { useToast } from '@/components/shared/Toast';
import { useWallet } from '@/hooks/useWallet';
import { api, type PortfolioMarginData, type TraderProfile } from '@/lib/api';
import { useStore } from '@/stores/useStore';
import TokenLogo from '@/components/TokenLogo';
import EmptyState, { SkeletonRows } from '@/components/shared/EmptyState';
import EquityCurve from '@/components/shared/EquityCurve';
import { buildEquityCurve } from '@/lib/pnl';

type MarginMode = 'cross' | 'isolated' | 'portfolio';

// Spot-collateral haircut weights — must match the engine's HAIRCUTS map
// (api/src/services/portfolioMargin.js). Unlisted assets default to 50%.
const COLLATERAL_WEIGHTS: Record<string, number> = {
  USDC: 100,
  BTC: 85,
  ETH: 80,
  SOL: 70,
  MRSN: 60,
  ARB: 60,
};

function HealthGauge({ factor }: { factor: number }) {
  const f = typeof factor === 'number' && isFinite(factor) ? factor : 0;
  const clampedFactor = Math.min(Math.max(f, 0), 5);
  const pct = (clampedFactor / 5) * 100;
  const color = f >= 3 ? 'text-green' : f >= 1.5 ? 'text-yellow' : 'text-red';
  const bgColor = f >= 3 ? 'bg-green' : f >= 1.5 ? 'bg-yellow' : 'bg-red';
  const status = f >= 3 ? 'Healthy' : f >= 1.5 ? 'Warning' : f > 0 ? 'At risk' : '—';

  return (
    <div className="flex items-center gap-4">
      <div className="relative w-24 h-12 overflow-hidden shrink-0">
        <div className="absolute inset-0 rounded-t-full border-[3px] border-surface-2" style={{ borderBottom: 'none' }} />
        <div
          className={cn('absolute bottom-0 left-0 right-0 rounded-t-full transition-all duration-700', bgColor)}
          style={{ height: `${pct}%`, opacity: 0.18 }}
        />
        <div className="absolute inset-0 flex items-end justify-center pb-0.5">
          <span className={cn('text-lg font-bold font-mono leading-none', color)}>{f.toFixed(2)}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-dim leading-none">Health Factor</span>
        <span className={cn('text-[12px] font-semibold leading-none', color)}>{status}</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-3.5">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className={cn('text-[17px] font-mono font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>{value}</p>
    </div>
  );
}

export default function PortfolioPage() {
  const { address, isConnected, connect } = useWallet();
  const { toast } = useToast();
  const [data, setData] = useState<PortfolioMarginData | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<TraderProfile | null>(null);
  const marginMode = useStore((s) => s.marginMode);
  const setMarginMode = useStore((s) => s.setMarginMode);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const res = await api.getPortfolioMargin(address);
      setData(res);
    } catch (e) {
      console.error('[portfolio] load error:', e);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    refresh();
    if (address) {
      api.getTraderProfile(address).then(setProfile).catch(() => {});
      const interval = setInterval(refresh, 10000);
      return () => clearInterval(interval);
    }
  }, [refresh, address]);

  const handleModeChange = (mode: MarginMode) => {
    setMarginMode(mode);
    toast(`Margin mode set to ${mode}`, 'info');
  };

  if (!isConnected) {
    return (
      <div className="page-shell">
        <header className="mb-6">
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">Unified view of positions, collateral, and margin</p>
        </header>
        <div className="bg-surface border border-border rounded-xl p-10 text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-surface-2 flex items-center justify-center">
            <svg className="w-6 h-6 text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
            </svg>
          </div>
          <p className="text-sm text-foreground mb-0.5">Connect your wallet</p>
          <p className="text-xs text-dim">Your positions, collateral, and margin will appear here</p>
          <button
            onClick={() => { connect().catch(() => {}); }}
            className="mt-4 px-5 h-8 premium-gradient text-black rounded-lg text-[11.5px] font-semibold transition-all hover:brightness-110"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  const upnlTotal = (data?.positions ?? []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  return (
    <div className="page-shell space-y-5">
      {/* Header — left-aligned, with margin-mode segmented control on the right */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">Unified view of positions, collateral, and margin</p>
        </div>
        <div className="flex items-center gap-px bg-background rounded-md border border-border overflow-hidden">
          {(['cross', 'isolated', 'portfolio'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => handleModeChange(mode)}
              className={cn(
                'px-3 py-1.5 text-[11.5px] font-medium transition-colors capitalize',
                marginMode === mode
                  ? 'bg-foreground/[0.07] text-foreground'
                  : 'bg-surface-2 text-dim hover:text-foreground'
              )}
            >{mode}</button>
          ))}
        </div>
      </header>

      {loading ? (
        <div className="bg-surface border border-border rounded-xl py-4">
          <SkeletonRows rows={5} />
        </div>
      ) : !data ? (
        <div className="bg-surface border border-border rounded-xl">
          <EmptyState
            label="No portfolio data"
            hint="Connect a wallet and place a trade to build your portfolio"
          />
        </div>
      ) : (
        <>
          {/* Overview row: 4 stat cards + health gauge card */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Total Collateral" value={`${formatNumber(data.totalCollateral ?? 0)} MRSN`} />
            <StatCard
              label="Margin Used"
              value={`${formatNumber(data.totalMarginUsed ?? 0)} MRSN`}
              valueClass="text-yellow"
            />
            <StatCard
              label="Available Margin"
              value={`${formatNumber(data.availableMargin ?? 0)} MRSN`}
              valueClass="text-green"
            />
            <StatCard
              label="Margin Ratio"
              value={`${((data.marginRatio ?? 0) * 100).toFixed(2)}%`}
              valueClass={(data.marginRatio ?? 0) < 0.8 ? 'text-green' : 'text-red'}
            />
            <div className="col-span-2 lg:col-span-1 bg-surface border border-border rounded-xl p-3.5 flex items-center justify-center">
              <HealthGauge factor={data.healthFactor ?? 0} />
            </div>
          </div>

          {/* Trading performance: realized cash-flow PnL curve + headline stats
              from the indexer leaderboard (same model as the analytics page) */}
          {profile && (profile.recentTrades?.length ?? 0) > 0 && (
            <div className="bg-surface border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Trading Performance</h3>
                <div className="flex items-center gap-4 text-[11px] font-mono">
                  {(() => {
                    const all = profile.stats?.['all'] || {};
                    const pnl = Number(all.pnl ?? 0);
                    const wins = Number(all.win_count ?? 0);
                    const losses = Number(all.loss_count ?? 0);
                    const decided = wins + losses;
                    return (
                      <>
                        <span className="text-dim">Realized PnL <span className={cn('font-semibold', pnl >= 0 ? 'text-green' : 'text-red')}>{pnl >= 0 ? '+' : ''}{formatNumber(pnl, 2)}</span></span>
                        <span className="text-dim">Win rate <span className="text-foreground">{decided > 0 ? `${Math.round((wins / decided) * 100)}%` : '—'}</span></span>
                        <span className="text-dim">Volume <span className="text-foreground">{formatNumber(Number(all.volume ?? 0), 0)}</span></span>
                      </>
                    );
                  })()}
                </div>
              </div>
              <EquityCurve data={buildEquityCurve(profile.recentTrades || [])} height={160} />
            </div>
          )}

          {/* Collateral Breakdown */}
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
              <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Collateral Breakdown</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
              <div className="p-4">
                <h4 className="text-[10px] text-dim uppercase tracking-wider font-medium mb-3">Perp Margin</h4>
                <div className="space-y-2">
                  <Row label="MRSN Deposited" value={`${formatNumber(data.totalCollateral ?? 0)} MRSN`} />
                  <Row
                    label="Unrealized PnL"
                    value={`${upnlTotal >= 0 ? '+' : '−'}${formatNumber(Math.abs(upnlTotal))} MRSN`}
                    valueClass={upnlTotal >= 0 ? 'text-green' : 'text-red'}
                  />
                  <div className="h-px bg-border my-2" />
                  <Row
                    label="Account Equity"
                    labelClass="text-foreground font-medium"
                    value={`${formatNumber((data.totalCollateral ?? 0) + upnlTotal)} MRSN`}
                    valueClass="text-foreground font-medium"
                  />
                </div>
              </div>

              <div className="p-4">
                <h4 className="text-[10px] text-dim uppercase tracking-wider font-medium mb-3">Spot Holdings (with haircuts)</h4>
                {data.spotBalances && Array.isArray(data.spotBalances) && data.spotBalances.length > 0 ? (
                  <div className="space-y-2">
                    {data.spotBalances.map((sb) => (
                      <div key={sb.asset} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <TokenLogo symbol={sb.asset} size={18} />
                          <span className="text-foreground font-medium">{sb.asset}</span>
                          <span className="text-[10px] text-dim font-mono">({COLLATERAL_WEIGHTS[sb.asset] ?? 50}% weight)</span>
                        </div>
                        <span className="font-mono text-muted tabular-nums">{formatNumber(sb.available + sb.locked, 4)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-dim">No spot holdings</p>
                )}
              </div>
            </div>
          </div>

          {/* Positions table — with paired logos */}
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
              <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
                Positions
              </h3>
              <span className="text-[10px] text-dim font-mono tabular-nums">
                {(data.positions ?? []).length} open
              </span>
            </div>
            {(data.positions ?? []).length === 0 ? (
              <EmptyState label="No open positions" hint="Place your first order on the trade page" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border bg-surface-2/30">
                      <th className="px-4 py-2 text-left font-medium">Market</th>
                      <th className="px-3 py-2 text-left font-medium">Side</th>
                      <th className="px-3 py-2 text-right font-medium">Size</th>
                      <th className="px-3 py-2 text-right font-medium">Entry</th>
                      <th className="px-3 py-2 text-right font-medium">Mark</th>
                      <th className="px-3 py-2 text-right font-medium">uPnL</th>
                      <th className="px-3 py-2 text-right font-medium">Margin</th>
                      <th className="px-4 py-2 text-right font-medium">Liq. Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.positions ?? []).map((p, i) => {
                      const sizeNum = Number(p.size);
                      const isLong = sizeNum > 0;
                      const pnl = p.unrealizedPnl ?? 0;
                      const base = (p.symbol || '').split('/')[0] || (p.symbol || '?');
                      return (
                        <tr key={i} className="border-b border-border last:border-0 hover:bg-surface-2/40 transition-colors">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <TokenLogo symbol={base} size={20} />
                              <span className="font-medium text-foreground">{p.symbol || `#${p.marketId}`}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={cn(
                              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider',
                              isLong ? 'text-green bg-green/10' : 'text-red bg-red/10'
                            )}>
                              {isLong ? 'Long' : 'Short'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-foreground tabular-nums">{formatNumber(Math.abs(sizeNum), 4)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-muted tabular-nums">{formatPrice(Number(p.entryPrice))}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-muted tabular-nums">{formatPrice(p.markPrice ?? 0)}</td>
                          <td className={cn('px-3 py-2.5 text-right font-mono font-medium tabular-nums', pnl >= 0 ? 'text-green' : 'text-red')}>
                            {pnl >= 0 ? '+' : ''}{formatNumber(pnl)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-dim tabular-nums">{formatNumber(p.margin ?? 0)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-yellow tabular-nums">{p.liquidationPrice ? formatPrice(p.liquidationPrice) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, labelClass, value, valueClass }: { label: string; labelClass?: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className={cn('text-muted', labelClass)}>{label}</span>
      <span className={cn('font-mono tabular-nums text-foreground', valueClass)}>{value}</span>
    </div>
  );
}
