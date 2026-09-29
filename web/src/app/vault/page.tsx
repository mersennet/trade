'use client';
import { useCallback, useEffect, useState } from 'react';
import { startPoll } from '@/lib/poll';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type VaultState, type VaultUserState, type VaultInfo } from '@/lib/api';
import { formatNumber, formatPct, formatUtcShort, cn } from '@/lib/utils';
import TokenLogo from '@/components/TokenLogo';
import { MAKER_VAULT_ADDRESS, readVault, depositToMakerVault, withdrawFromMakerVault, vaultErrorMessage, type VaultOnChain } from '@/lib/makerVault';

const EXPLORER = 'https://explorer.mersennet.com';

function StatTile({ label, value, valueClass, hint }: { label: string; value: string; valueClass?: string; hint?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-3.5 py-3" title={hint}>
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className={cn('text-[18px] font-mono font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>{value}</p>
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

export default function VaultPage() {
  const { address, isConnected, provider, balance: walletBalanceWei } = useWallet();
  const { toast } = useToast();
  const [chain, setChain] = useState<VaultOnChain | null>(null);
  const [indexed, setIndexed] = useState<VaultState | null>(null);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [user, setUser] = useState<VaultUserState | null>(null);
  const [amount, setAmount] = useState('');
  const [withdrawPct, setWithdrawPct] = useState(100);
  const [loading, setLoading] = useState<'deposit' | 'withdraw' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    readVault(address).then(setChain).catch(() => {});
    api.getVaultState().then(setIndexed).catch(() => {});
    api.getVaultInfo().then(setInfo).catch(() => {});
    if (address) api.getVaultUser(address).then(setUser).catch(() => {});
  }, [address]);

  useEffect(() => {
    refresh();
    return startPoll(refresh, 30_000); // pauses while the tab is hidden
  }, [refresh]);

  const handleDeposit = async () => {
    if (!provider || !amount) return;
    setLoading('deposit'); setError(null);
    try {
      const hash = await depositToMakerVault(provider, amount);
      toast(`Deposited ${amount} MRSN into the maker vault`, 'success');
      setAmount('');
      await refresh();
      void hash;
    } catch (e) { setError(vaultErrorMessage(e)); }
    finally { setLoading(null); }
  };

  const handleWithdraw = async () => {
    if (!provider || !chain || chain.myShares <= 0) return;
    setLoading('withdraw'); setError(null);
    try {
      const shares = withdrawPct >= 100 ? chain.myShares : chain.myShares * withdrawPct / 100;
      await withdrawFromMakerVault(provider, shares);
      toast(`Withdrew ${formatNumber(shares * chain.sharePrice, 2)} MRSN`, 'success');
      await refresh();
    } catch (e) { setError(vaultErrorMessage(e)); }
    finally { setLoading(null); }
  };

  const agentLive = chain && chain.agent && chain.agent !== '0x0000000000000000000000000000000000000000';
  // Deposits need the CLOB to treat the vault contract as its own account
  // (frame-caller switch); before that the contract cannot hold collateral.
  const depositsOpen = !info || info.active;
  const blocksToOpen = info && !info.active && info.activeFromBlock && info.height ? Math.max(0, info.activeFromBlock - info.height) : 0;
  // ETA from the observed block time (the API's switch schedule), not a fixed 2.1 s.
  const [openEta, setOpenEta] = useState<string | null>(null);
  useEffect(() => {
    if (!info || info.active || !info.activeFromBlock) { setOpenEta(null); return; }
    api.getProtocolSwitches().then((s) => {
      const sw = s.switches.find((x) => x.height === info.activeFromBlock);
      if (!sw) return;
      const h = sw.etaSec / 3600;
      const when = formatUtcShort(sw.etaAt);
      setOpenEta(`${h >= 48 ? `~${Math.round(h / 24)} d` : h >= 1 ? `~${Math.round(h)} h` : `~${Math.max(1, Math.round(sw.etaSec / 60))} min`} · ${when} UTC`);
    }).catch(() => {});
  }, [info]);
  const capLeft = chain && chain.depositCap > 0 ? Math.max(0, chain.depositCap - chain.nav) : null;
  const deployed = chain ? chain.collateral : 0;
  const deployedPct = chain && chain.nav > 0 ? (deployed / chain.nav) * 100 : 0;

  return (
    <div className="page-shell space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">
            Maker Vault
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-2 text-[10px] text-dim font-mono">
              <TokenLogo symbol="MRSN" size={12} /> MRSN → mvMRSN
            </span>
          </h1>
          <p className="page-sub">Pool MRSN behind the market maker that quotes every Mersennet market. Maker PnL accrues to the share price; you earn LP points for every MRSN-day parked.</p>
        </div>
        <a href={`${EXPLORER}/address/${MAKER_VAULT_ADDRESS}`} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-dim hover:text-primary">
          {MAKER_VAULT_ADDRESS.slice(0, 10)}…{MAKER_VAULT_ADDRESS.slice(-6)} ↗
        </a>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Vault NAV" value={chain ? `${formatNumber(chain.nav, 2)} MRSN` : '—'} hint="Free MRSN + collateral on the precompile + unrealized PnL at book mid" />
        <StatTile label="Share price" value={chain ? `${chain.sharePrice.toFixed(6)} MRSN` : '—'} valueClass={chain && chain.sharePrice >= 1 ? 'text-green' : 'text-red'} hint="MRSN per mvMRSN share (starts at 1.000000)" />
        {indexed && indexed.return7d ? (
          <StatTile label="7-day return" value={formatPct(indexed.return7d)} valueClass={indexed.return7d >= 0 ? 'text-green' : 'text-red'} hint="Share-price change over the last 7 days, not annualised: on the testnet the maker trades against the network's own bots, so a yearly rate would mean nothing" />
        ) : (
          <StatTile label="Since launch" value={chain ? formatPct((chain.sharePrice - 1) * 100) : '—'} valueClass={!chain || chain.sharePrice >= 1 ? 'text-green' : 'text-red'} hint="Share-price change since the vault opened (20 Sep). The 7-day return appears once the vault is a week old." />
        )}
        <StatTile label="Depositors" value={chain ? String(chain.depositors) : '—'} hint={chain && chain.seedShares > 0 ? 'Including the protocol\'s seed deposit' : undefined} />
      </div>

      {/* How the pool is deployed right now */}
      {chain && (
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Where the MRSN is</h3>
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider', agentLive ? 'bg-green/10 text-green' : 'bg-yellow/10 text-yellow')}>
              {agentLive ? 'maker quoting' : depositsOpen ? 'awaiting agent grant' : 'opens at the switch'}
            </span>
          </div>
          <div className="h-2 rounded bg-surface-2 overflow-hidden flex">
            <div className="bg-primary h-full" style={{ width: `${Math.min(100, deployedPct)}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-dim font-mono">
            <span><span className="text-primary">■</span> collateral on the book {formatNumber(chain.collateral, 2)} MRSN</span>
            <span>free reserve {formatNumber(chain.freeBalance, 2)} MRSN</span>
            <span className={chain.unrealizedPnl >= 0 ? 'text-green' : 'text-red'}>unrealized {chain.unrealizedPnl >= 0 ? '+' : ''}{formatNumber(chain.unrealizedPnl, 2)} MRSN</span>
            {capLeft !== null && <span>cap left {formatNumber(capLeft, 0)} MRSN</span>}
          </div>
          {chain.seedShares > 0 && (
            <p className="text-[11px] text-dim mt-2">
              <span className="text-foreground">Protocol seed liquidity:</span> {formatNumber(chain.seedValue, 0)} MRSN ({chain.seedPct.toFixed(1)}% of shares) is the
              market-making treasury&apos;s own stake, deposited so the books are deep from day one. It earns no LP points; every other depositor does.
            </p>
          )}
          {!agentLive && (
            <p className="text-[11px] text-dim mt-2">
              The maker bot trades for the vault through <span className="text-foreground">agent delegation</span>, which activates at the next consensus switch. Until then deposits sit as free MRSN (withdrawable any time) and earn LP points.
            </p>
          )}
        </div>
      )}

      {/* My position */}
      {isConnected && chain && chain.myShares > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider mb-3">Your position</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <PosTile label="mvMRSN shares" value={formatNumber(chain.myShares, 4)} />
            <PosTile label="Value now" value={`${formatNumber(chain.myValue, 2)} MRSN`} />
            <PosTile label="Share of vault" value={chain.totalShares > 0 ? `${((chain.myShares / chain.totalShares) * 100).toFixed(3)}%` : '—'} />
            <PosTile label="LP points" value={user ? formatNumber(user.lpPoints ?? 0, 1) : '—'} valueClass="text-cyan" />
          </div>
          {user && Array.isArray(user.history) && user.history.length > 0 && (
            <div className="border-t border-border pt-3 mt-3">
              <h4 className="text-[10px] text-dim uppercase tracking-wider font-medium mb-2">History</h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(user.history as { action: string; amount: number; shares: number; created_at: string; tx_hash?: string }[]).map((h, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider', h.action === 'deposit' ? 'bg-green/10 text-green' : 'bg-red/10 text-red')}>{h.action}</span>
                      <span className="text-dim font-mono">{new Date(h.created_at).toLocaleString()}</span>
                      {h.tx_hash && <a href={`${EXPLORER}/tx/${h.tx_hash}`} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-primary font-mono">{h.tx_hash.slice(0, 10)}…</a>}
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <span className="text-foreground">{formatNumber(Number(h.amount), 2)} MRSN</span>
                      <span className="text-dim ml-2">({formatNumber(Number(h.shares), 4)} mvMRSN)</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Deposit / withdraw */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider mb-3">Deposit MRSN</h3>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <TokenLogo symbol="MRSN" size={18} className="absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="number" inputMode="decimal" min={chain?.minDeposit ?? 1} step="any"
                value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`min ${chain?.minDeposit ?? 1}`}
                aria-label="Deposit amount in MRSN"
                className="w-full bg-surface-2 border border-border rounded-md pl-9 pr-14 py-2.5 text-sm text-foreground font-mono tabular-nums outline-none focus:border-primary/40 transition-colors"
              />
              {isConnected && (
                <button
                  type="button"
                  title="Whole wallet balance minus a little gas"
                  onClick={() => {
                    // Wallet balance is wei; leave 0.01 MRSN for gas, two decimals.
                    const bal = Number(BigInt(walletBalanceWei || '0')) / 1e18;
                    const max = Math.max(0, Math.floor((bal - 0.01) * 100) / 100);
                    if (max <= 0) { setError('No MRSN in this wallet to deposit — claim from the faucet first.'); return; }
                    setAmount(String(max));
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider text-primary hover:bg-primary/10"
                >Max</button>
              )}
            </div>
            <button
              onClick={handleDeposit}
              disabled={!!loading || !isConnected || !amount || !!chain?.paused || !depositsOpen}
              className="px-5 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-md text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading === 'deposit' ? 'Confirm in wallet…' : 'Deposit'}
            </button>
          </div>
          {amount && chain && Number(amount) > 0 && (
            <p className="text-[11px] text-dim mt-2 font-mono">≈ {formatNumber(Number(amount) / chain.sharePrice, 4)} mvMRSN at today&apos;s share price</p>
          )}
          {!depositsOpen && info?.activeFromBlock && (
            <p className="text-[11px] text-yellow mt-2">
              Deposits open at block {info.activeFromBlock.toLocaleString()} ({openEta ? `${openEta}` : `~${Math.round(blocksToOpen * 2.1 / 3600)} h`}) — the protocol switch that lets contracts hold their own order-book accounts. Until then the vault cannot take collateral.
            </p>
          )}
          {!isConnected && <p className="text-[11px] text-dim mt-2">Connect a wallet to deposit. Need MRSN? <a href="https://faucet.mersennet.com" className="text-primary hover:underline">Faucet</a>.</p>}
          {chain?.paused && <p className="text-[11px] text-yellow mt-2">Deposits are paused by the manager; withdrawals still work.</p>}
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider mb-3">Withdraw</h3>
          {isConnected && chain && chain.myShares > 0 ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                {[25, 50, 75, 100].map((p) => (
                  <button key={p} onClick={() => setWithdrawPct(p)} className={cn('px-2.5 py-1 rounded text-[11px] font-semibold border', withdrawPct === p ? 'border-primary/50 text-primary bg-primary/5' : 'border-border text-dim hover:text-foreground')}>{p}%</button>
                ))}
              </div>
              <button
                onClick={handleWithdraw} disabled={!!loading}
                className="w-full py-2.5 bg-surface-2 hover:bg-red/10 text-foreground hover:text-red border border-border rounded-md text-[12.5px] font-semibold disabled:opacity-50 transition-colors"
              >
                {loading === 'withdraw' ? 'Confirm in wallet…' : `Withdraw ${withdrawPct}% ≈ ${formatNumber(chain.myValue * withdrawPct / 100, 2)} MRSN`}
              </button>
              <p className="text-[11px] text-dim mt-2">Paid at the live share price from the vault&apos;s free reserve, then from collateral not backing positions.</p>
            </>
          ) : (
            <p className="text-[11px] text-dim">Nothing to withdraw yet.</p>
          )}
        </div>
      </div>

      {error && <p className="text-[12px] text-red">{error}</p>}

      <div className="text-[11px] text-dim leading-relaxed">
        <span className="text-foreground font-medium">How it works.</span> The vault is a contract on Mersennet ({' '}
        <a href={`${EXPLORER}/address/${MAKER_VAULT_ADDRESS}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">view on the explorer</a>). It holds the pool as collateral on the orders precompile in its own name and grants the market-maker key permission to place and cancel orders for it — never to withdraw. Shares are minted and burned at NAV, so fills the maker earns (or loses) show up in the share price. Testnet: the manager can pause deposits and cap the pool; MRSN has no monetary value here.
      </div>
    </div>
  );
}
