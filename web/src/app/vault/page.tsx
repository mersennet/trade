'use client';
import { useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type VaultState, type VaultUserState } from '@/lib/api';
import { formatNumber, formatUsd, formatPct, cn } from '@/lib/utils';
import TokenLogo from '@/components/TokenLogo';

const VAULT_STRATEGIES = [
  { id: 1, name: 'Market Making',  desc: 'Avellaneda-Stoikov automated market maker across all perp markets', risk: 'Medium',     markets: 'MRSN · BTC · ETH · SOL · ARB' },
  { id: 2, name: 'Delta Neutral',  desc: 'Long spot + short perp for market-neutral yield',                    risk: 'Low',        markets: 'BTC · ETH' },
  { id: 3, name: 'Basis Trade',    desc: 'Spot vs futures arbitrage capturing funding-rate premium',            risk: 'Low-Medium', markets: 'BTC · ETH · SOL' },
  { id: 4, name: 'Yield Optimizer',desc: 'Auto-compound staking rewards for maximum APY',                       risk: 'Low',        markets: 'MRSN' },
];

function riskClass(r: string) {
  if (r === 'Low') return 'text-green bg-green/10';
  if (r === 'Low-Medium') return 'text-cyan bg-cyan/10';
  if (r === 'Medium') return 'text-yellow bg-yellow/10';
  return 'text-red bg-red/10';
}

function StatTile({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-3.5 py-3">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className={cn('text-[18px] font-mono font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>{value}</p>
    </div>
  );
}

export default function VaultPage() {
  const { address, isConnected } = useWallet();
  const { toast } = useToast();
  const [vault, setVault] = useState<VaultState | null>(null);
  const [userVault, setUserVault] = useState<VaultUserState | null>(null);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedVault, setSelectedVault] = useState(1);
  const [showLpCollateral, setShowLpCollateral] = useState(false);

  useEffect(() => {
    api.getVaultState().then(setVault).catch(() => {});
    if (isConnected && address) {
      api.getVaultUser(address).then(setUserVault).catch(() => {});
    }
  }, [address, isConnected]);

  const handleDeposit = async () => {
    if (!address || !amount) return;
    setLoading(true);
    try {
      const res = await api.vaultDeposit(address, Number(amount));
      toast(`Deposited. You received ${formatNumber(res.shares, 4)} LP tokens`, 'success');
      setAmount('');
      api.getVaultState().then(setVault);
      api.getVaultUser(address).then(setUserVault);
    } catch (e) { toast(`Deposit failed: ${(e as Error).message}`, 'error'); }
    finally { setLoading(false); }
  };

  const handleWithdraw = async () => {
    if (!address || !userVault || userVault.shares <= 0) return;
    setLoading(true);
    try {
      const res = await api.vaultWithdraw(address, userVault.shares);
      toast(`Withdrawn ${formatNumber(res.amount, 4)} USDC`, 'success');
      api.getVaultState().then(setVault);
      api.getVaultUser(address).then(setUserVault);
    } catch (e) { toast(`Withdraw failed: ${(e as Error).message}`, 'error'); }
    finally { setLoading(false); }
  };

  const currentStrategy = VAULT_STRATEGIES.find(v => v.id === selectedVault) || VAULT_STRATEGIES[0];

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      {/* Header — left-aligned with USDC token chip to clarify deposit asset */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground tracking-tight flex items-center gap-2">
            Mersennet Vault
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-2 text-[10px] text-dim font-mono">
              <TokenLogo symbol="USDC" size={12} /> USDC
            </span>
          </h1>
          <p className="text-dim text-xs md:text-[13px] mt-0.5">Earn yield across multiple automated strategies</p>
        </div>
      </header>

      {/* Beta-only: yield strategies are not yet wired to on-chain contracts.
          Without this banner a beta tester clicks "Deposit" and gets a green
          toast even though no funds left their wallet. */}
      <div className="bg-yellow/10 border border-yellow/40 rounded-lg p-3 flex items-start gap-2.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow shrink-0 mt-0.5">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="text-[12px] leading-relaxed">
          <span className="text-yellow font-semibold">Preview &middot; Not yet on-chain.</span>{' '}
          <span className="text-foreground/80">
            Strategy vault deposits are simulated for UX testing only. No tokens move from your wallet.
            Real yield strategies will ship in a future release. To allocate native MRSN collateral for trading,
            use the <a href="/portfolio" className="text-primary hover:underline">Portfolio collateral vault</a> instead.
          </span>
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Total TVL" value={vault ? formatUsd(vault.totalTvl) : '—'} />
        <StatTile label="APY (7d)"  value={vault ? formatPct(vault.apy7d)  : '—'} valueClass="text-green" />
        <StatTile label="APY (30d)" value={vault ? formatPct(vault.apy30d) : '—'} valueClass="text-green" />
        <StatTile label="Depositors" value={vault?.depositors?.toString() || '—'} />
      </div>

      {/* Strategy vaults */}
      <div>
        <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider mb-2.5">Strategy Vaults</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {VAULT_STRATEGIES.map((s) => {
            const active = selectedVault === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedVault(s.id)}
                className={cn(
                  'bg-surface border rounded-xl p-4 text-left transition-colors',
                  active ? 'border-primary/40 bg-primary/[0.03]' : 'border-border hover:border-border/80 hover:bg-surface-2/30'
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <h4 className={cn('text-[14px] font-semibold tracking-tight', active ? 'text-primary' : 'text-foreground')}>{s.name}</h4>
                  <span className={cn('px-1.5 py-0.5 text-[10px] font-medium rounded', riskClass(s.risk))}>{s.risk} Risk</span>
                </div>
                <p className="text-[11.5px] text-dim mb-3 leading-relaxed">{s.desc}</p>
                <div className="flex items-center justify-between text-[10.5px] pt-2.5 border-t border-border/50">
                  <span className="text-dim">{s.markets}</span>
                  <span className="text-green font-mono font-semibold tabular-nums">
                    {vault ? formatPct(vault.apy7d * (0.6 + s.id * 0.15)) : '—'} APY
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* User position */}
      {isConnected && userVault && userVault.shares > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
              Your Position: {currentStrategy.name}
            </h3>
            <button
              onClick={() => setShowLpCollateral(!showLpCollateral)}
              className="text-[11px] text-primary hover:text-primary-hover font-medium"
            >
              {showLpCollateral ? 'Hide LP details' : 'Use as collateral'}
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <PosTile label="LP Tokens"      value={formatNumber(userVault.shares, 4)} />
            <PosTile label="Value"          value={formatUsd(userVault.value)} />
            <PosTile label="Share of Vault" value={`${userVault.shareOfVault}%`} />
            <PosTile label="Collateral Value" value={formatUsd(userVault.value * 0.7)} valueClass="text-cyan" />
          </div>
          {showLpCollateral && (
            <div className="mt-2 p-3 bg-surface-2 rounded-lg border border-cyan/20">
              <p className="text-xs text-foreground mb-2">
                Your LP tokens can be used as collateral for perpetual trading with a <span className="text-cyan font-semibold">70% haircut</span>.
              </p>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-[10.5px] text-dim font-mono">
                  {formatNumber(userVault.shares, 4)} LP = {formatUsd(userVault.value * 0.7)} margin
                </span>
                <button className="px-3 py-1.5 bg-cyan/10 text-cyan text-[11px] font-semibold rounded-md hover:bg-cyan/20 transition-colors">
                  Enable as Collateral
                </button>
              </div>
            </div>
          )}
          {Array.isArray(userVault.history) && userVault.history.length > 0 && (
            <div className="border-t border-border pt-3 mt-3">
              <h4 className="text-[10px] text-dim uppercase tracking-wider font-medium mb-2">Transaction History</h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(userVault.history as {action: string; amount: number; shares: number; created_at: string}[]).map((h, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider',
                        h.action === 'deposit' ? 'bg-green/10 text-green' : 'bg-red/10 text-red'
                      )}>{h.action}</span>
                      <span className="text-dim font-mono">{new Date(h.created_at).toLocaleDateString()}</span>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <span className="text-foreground">{formatNumber(h.amount, 2)} USDC</span>
                      <span className="text-dim ml-2">({formatNumber(h.shares, 4)} LP)</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Deposit / Withdraw */}
      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <span>Deposit to {currentStrategy.name}</span>
          <span className="text-dim font-normal normal-case tracking-normal text-[11px]">· USDC accepted</span>
        </h3>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <TokenLogo symbol="USDC" size={18} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-surface-2 border border-border rounded-md pl-9 pr-3 py-2.5 text-sm text-foreground font-mono tabular-nums outline-none focus:border-primary/40 transition-colors"
            />
          </div>
          <button
            onClick={handleDeposit}
            disabled={loading || !isConnected || !amount}
            className="px-5 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-md text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Processing…' : 'Deposit'}
          </button>
        </div>
        {!isConnected && (
          <p className="text-[11px] text-dim mt-2">Connect a wallet to deposit.</p>
        )}
        {isConnected && userVault && userVault.shares > 0 && (
          <button
            onClick={handleWithdraw}
            disabled={loading}
            className="mt-3 w-full py-2 bg-surface-2 hover:bg-red/10 text-foreground hover:text-red border border-border rounded-md text-[12.5px] font-semibold disabled:opacity-50 transition-colors"
          >
            Withdraw All ({formatNumber(userVault.shares, 4)} LP)
          </button>
        )}
      </div>
    </div>
  );
}

function PosTile({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-surface-2/40 border border-border/60 rounded-lg px-3 py-2.5">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1">{label}</p>
      <p className={cn('text-[15px] font-mono font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>{value}</p>
    </div>
  );
}
