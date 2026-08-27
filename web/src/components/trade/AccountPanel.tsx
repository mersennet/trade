'use client';
import { useMemo, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useStore } from '@/stores/useStore';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api } from '@/lib/api';
import { formatNumber, cn } from '@/lib/utils';
import { explorerTx, MERSENNET_TESTNET } from '@/lib/chain';
import {
  depositToVault, withdrawFromVault,
  getCollateralAssets, getTokenWalletBalance, getTokenCollateralBalance,
  depositTokenToVault, withdrawTokenFromVault,
  type CollateralAsset,
} from '@/lib/vault';
import EmptyState from '@/components/shared/EmptyState';
import { startPoll } from '@/lib/poll';

export default function AccountPanel() {
  const { positions, marginMode } = useStore();
  const collateral = useStore((s) => Number(s.wallet.collateral) || 0);
  const setWallet = useStore((s) => s.setWallet);
  const { address, balance, provider, isConnected } = useWallet();
  const { toast } = useToast();
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferMode, setTransferMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [walletMrsn, setWalletMrsn] = useState(0);
  // Registered ERC-20 collateral (USDC today; the chain allowlist is dynamic).
  const [tokenAssets, setTokenAssets] = useState<CollateralAsset[]>([]);
  const [tokenBalances, setTokenBalances] = useState<Record<string, { wallet: number; deposited: number }>>({});
  // 'MRSN' or a registered token symbol — which asset the transfer panel moves.
  const [transferAsset, setTransferAsset] = useState('MRSN');
  const [feeTier, setFeeTier] = useState<{ name: string; makerFee: number; takerFee: number } | null>(null);
  const [points, setPoints] = useState<{ total: number; tier: string } | null>(null);

  // Points balance chip (Paradex keeps XP visible while trading).
  useEffect(() => {
    if (!address) return;
    api.getPoints(address)
      .then((r) => setPoints({ total: r.totalPoints, tier: r.tier }))
      .catch(() => {});
  }, [address]);

  // Fee tier from 30d volume (protocol tiers come from /api/v1/stats).
  useEffect(() => {
    if (!address) return;
    Promise.all([api.getStats(), api.getTraderProfile(address)])
      .then(([stats, profile]) => {
        const tiers = (stats.feeTiers || []) as { name: string; minVolume: number; makerFee: number; takerFee: number }[];
        const vol = Number(profile?.stats?.['30d']?.volume ?? profile?.stats?.['all']?.volume ?? 0);
        const tier = [...tiers].sort((a, b) => b.minVolume - a.minVolume).find((t) => vol >= t.minVolume) || tiers[0];
        if (tier) setFeeTier(tier);
      })
      .catch(() => {});
  }, [address]);

  // The header's Deposit button navigates here and bumps this timestamp —
  // open the transfer panel in deposit mode when it fires.
  const depositRequestTs = useStore((s) => s.depositRequestTs);
  useEffect(() => {
    if (!depositRequestTs) return;
    setTransferMode('deposit');
    setShowTransfer(true);
  }, [depositRequestTs]);

  const refreshBalances = useCallback(async () => {
    if (!address || !provider) { setWalletMrsn(0); setTokenBalances({}); return; }
    try {
      const { ethers } = await import('ethers');
      type EthersLike = typeof import('ethers');
      const e = ethers as EthersLike;
      // Native MRSN balance, read from the Mersennet RPC directly so it is
      // correct even when the wallet provider briefly serves another chain
      // (Rabby right after an add/switch).
      const rpc = new e.providers.JsonRpcProvider(MERSENNET_TESTNET.rpcUrls[0]);
      const bal = await rpc.getBalance(address);
      setWalletMrsn(Number(e.utils.formatEther(bal)));
    } catch { /* ignore */ }
    // Registered token collateral (USDC): wallet balance + deposited margin.
    try {
      const assets = await getCollateralAssets();
      setTokenAssets(assets);
      const entries = await Promise.all(
        assets.map(async (a) => {
          const [wallet, deposited] = await Promise.all([
            getTokenWalletBalance(address, a).catch(() => 0),
            getTokenCollateralBalance(address, a).catch(() => 0),
          ]);
          return [a.symbol, { wallet, deposited }] as const;
        }),
      );
      setTokenBalances(Object.fromEntries(entries));
    } catch { /* ignore */ }
  }, [address, provider]);

  useEffect(() => {
    refreshBalances();
    if (!address) return;
    return startPoll(refreshBalances, 12_000);
  }, [address, refreshBalances]);

  const stats = useMemo(() => {
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    const totalNotional = positions.reduce((sum, p) => {
      const size = Math.abs(Number(p.size));
      const mark = p.markPrice || Number(p.entryPrice);
      return sum + (size * mark);
    }, 0);
    const accountEquity = collateral + totalUnrealizedPnl;
    const marginRatio = collateral > 0 ? (totalNotional / collateral) * 100 : 0;
    const availableMargin = Math.max(0, collateral - (totalNotional * 0.05));
    // provider.getBalance returns the wallet's native MRSN balance (18 decimals).
    const nativeBalance = Number(balance || '0') / 1e18;

    return { accountEquity, totalUnrealizedPnl, totalNotional, marginRatio, availableMargin, nativeBalance };
  }, [positions, collateral, balance]);

  if (!isConnected) {
    return (
      <div className="bg-surface border border-border rounded-xl md:border-0 md:rounded-none p-3 shrink-0">
        <h3 className="text-[11px] text-dim font-medium uppercase tracking-wider mb-1">Account</h3>
        <EmptyState
          label="Wallet not connected"
          hint="Connect to view equity, margin and balances"
          compact
        />
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-xl md:border-0 md:rounded-none p-3 flex flex-col gap-2 shrink-0">
      <h3 className="text-[11px] text-dim font-medium uppercase tracking-wider">Account</h3>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">Equity</span>
          <span className="text-xs font-mono font-semibold text-foreground">{formatNumber(stats.accountEquity, 2)} MRSN</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">Margin Balance</span>
          <span className="text-xs font-mono font-medium text-foreground">{formatNumber(collateral, 2)} MRSN</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">Unrealized PnL</span>
          <span className={cn('text-xs font-mono font-semibold', stats.totalUnrealizedPnl >= 0 ? 'text-green' : 'text-red')}>
            {stats.totalUnrealizedPnl >= 0 ? '+' : ''}{formatNumber(stats.totalUnrealizedPnl, 2)}
          </span>
        </div>
        <div className="h-px bg-border" />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">Available</span>
          <span className="text-xs font-mono font-medium text-foreground">{formatNumber(stats.availableMargin, 2)} MRSN</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">{marginMode === 'cross' ? 'Cross' : 'Isolated'} Margin Ratio</span>
          <span className={cn(
            'text-xs font-mono font-semibold',
            stats.marginRatio > 80 ? 'text-red' : stats.marginRatio > 50 ? 'text-yellow' : 'text-foreground'
          )}>
            {formatNumber(stats.marginRatio, 1)}%
          </span>
        </div>
        {/* Margin usage bar — HL-style color states so risk is glanceable */}
        <div className="h-1 bg-surface-2 rounded-full overflow-hidden" title="Margin usage: notional / collateral">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              stats.marginRatio > 80 ? 'bg-red' : stats.marginRatio > 50 ? 'bg-yellow' : 'bg-green'
            )}
            style={{ width: `${Math.min(100, stats.marginRatio)}%` }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">Open Notional</span>
          <span className="text-xs font-mono font-medium text-foreground/70">{formatNumber(stats.totalNotional, 2)} MRSN</span>
        </div>
        <div className="h-px bg-border" />
        {/* Native MRSN is both the gas asset and the depositable balance —
            one row, not two rows disagreeing about the same number. */}
        <div className="flex items-center justify-between" title="Native MRSN in your wallet — pays gas, and is what you deposit as collateral">
          <span className="text-[11px] text-dim">Wallet (gas)</span>
          <span className={cn(
            'text-xs font-mono font-medium',
            walletMrsn < 1 ? 'text-yellow' : 'text-foreground',
          )}>
            {formatNumber(walletMrsn, walletMrsn >= 1 ? 2 : 4)} MRSN
          </span>
        </div>
        {/* Registered token collateral (multi-collateral margin, e.g. USDC at
            90% weight). One row per asset: deposited margin + wallet balance. */}
        {tokenAssets.map((a) => {
          const b = tokenBalances[a.symbol];
          if (!b) return null;
          return (
            <div
              key={a.token}
              className="flex items-center justify-between"
              title={`${a.symbol} margin collateral, counted at ${(a.weightBps / 100).toFixed(0)}% of value · wallet balance ${formatNumber(b.wallet, 2)}`}
            >
              <span className="text-[11px] text-dim">{a.symbol} Collateral <span className="text-dim/60">({(a.weightBps / 100).toFixed(0)}%)</span></span>
              <span className="text-xs font-mono font-medium text-foreground">
                {formatNumber(b.deposited, 2)} <span className="text-dim">/ {formatNumber(b.wallet, 2)} wallet</span>
              </span>
            </div>
          );
        })}
        {feeTier && (
          <div className="flex items-center justify-between" title="Your fee tier from 30d trading volume">
            <span className="text-[11px] text-dim">Fee Tier</span>
            <span className="text-xs font-mono font-medium text-primary">
              {feeTier.name} · {(feeTier.makerFee * 100).toFixed(3)}%/{(feeTier.takerFee * 100).toFixed(3)}%
            </span>
          </div>
        )}
        {points && points.total > 0 && (
          <div className="flex items-center justify-between" title="Mersennet points balance">
            <span className="text-[11px] text-dim">Points</span>
            <Link href="/points" className="text-xs font-mono font-medium text-yellow hover:underline">
              {formatNumber(points.total, 0)} · {points.tier}
            </Link>
          </div>
        )}
      </div>

      {/* Deposit/Withdraw — neutral pair with visible 1px divider */}
      <div className="flex gap-px bg-background rounded-md border border-border overflow-hidden mt-1">
        <button
          onClick={() => { setShowTransfer(true); setTransferMode('deposit'); }}
          className="flex-1 py-1.5 text-[11px] font-semibold bg-surface-2 text-foreground hover:bg-foreground/[0.07] transition-colors"
        >Deposit</button>
        <button
          onClick={() => { setShowTransfer(true); setTransferMode('withdraw'); }}
          className="flex-1 py-1.5 text-[11px] font-semibold bg-surface-2 text-dim hover:text-foreground transition-colors"
        >Withdraw</button>
      </div>

      {showTransfer && (
        <div className="p-2.5 bg-surface-2 rounded-lg border border-border space-y-2">
          <div className="flex gap-0.5 p-0.5 bg-surface rounded-md">
            <button onClick={() => setTransferMode('deposit')} className={cn(
              'flex-1 py-1.5 text-[11px] font-semibold rounded transition-all',
              transferMode === 'deposit' ? 'bg-green/10 text-green' : 'text-dim'
            )}>Deposit</button>
            <button onClick={() => setTransferMode('withdraw')} className={cn(
              'flex-1 py-1.5 text-[11px] font-semibold rounded transition-all',
              transferMode === 'withdraw' ? 'bg-red/10 text-red' : 'text-dim'
            )}>Withdraw</button>
          </div>
          {/* Asset selector — native MRSN plus registered token collateral. */}
          {tokenAssets.length > 0 && (
            <div className="flex gap-0.5 p-0.5 bg-surface rounded-md">
              {['MRSN', ...tokenAssets.map((a) => a.symbol)].map((sym) => (
                <button
                  key={sym}
                  onClick={() => setTransferAsset(sym)}
                  className={cn(
                    'flex-1 py-1 text-[11px] font-semibold rounded transition-all',
                    transferAsset === sym ? 'bg-primary/10 text-primary' : 'text-dim hover:text-foreground'
                  )}
                >{sym}</button>
              ))}
            </div>
          )}
          <div className="relative">
            <input
              type="number"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-primary/40"
            />
            <button
              onClick={() => {
                if (transferAsset === 'MRSN') {
                  setTransferAmount(transferMode === 'deposit' ? walletMrsn.toFixed(2) : collateral.toFixed(2));
                } else {
                  const b = tokenBalances[transferAsset];
                  setTransferAmount((transferMode === 'deposit' ? b?.wallet ?? 0 : b?.deposited ?? 0).toFixed(2));
                }
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-primary font-medium hover:underline"
            >MAX</button>
          </div>
          <button
            onClick={async () => {
              if (!address || !transferAmount || !provider) {
                toast('Connect wallet first', 'error');
                return;
              }
              setTransferring(true);
              try {
                let res;
                const tokenAsset = tokenAssets.find((a) => a.symbol === transferAsset);
                if (transferMode === 'deposit') {
                  res = tokenAsset
                    ? await depositTokenToVault(provider, tokenAsset, transferAmount)
                    : await depositToVault(provider, address, transferAmount);
                  toast(`Deposited ${transferAmount} ${transferAsset}`, 'success');
                  useStore.getState().addNotification('info', 'Deposit confirmed', `${transferAmount} ${transferAsset} added to trading collateral`);
                } else {
                  res = tokenAsset
                    ? await withdrawTokenFromVault(provider, tokenAsset, transferAmount)
                    : await withdrawFromVault(provider, address, transferAmount);
                  toast(`Withdrew ${transferAmount} ${transferAsset}`, 'success');
                  useStore.getState().addNotification('info', 'Withdrawal confirmed', `${transferAmount} ${transferAsset} returned to your wallet`);
                }
                if (typeof window !== 'undefined' && res?.vaultTx) {
                  console.log('[collateral] tx:', explorerTx(res.vaultTx));
                }
                setTransferAmount('');
                setShowTransfer(false);
                const r = await api.getCollateral(address);
                setWallet({ collateral: String(Number(r.collateral) || 0) });
                refreshBalances();
              } catch (e) {
                const msg = (e as Error).message || '';
                const friendly = /user (rejected|denied)/i.test(msg)
                  ? 'Cancelled in wallet'
                  : msg.replace(/^Error: /, '');
                toast(`${transferMode === 'deposit' ? 'Deposit' : 'Withdrawal'} failed: ${friendly}`, 'error');
              } finally {
                setTransferring(false);
              }
            }}
            disabled={transferring || !transferAmount}
            className={cn(
              'w-full py-2 rounded-md text-[12px] font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              transferMode === 'deposit' ? 'bg-green hover:bg-green/90' : 'bg-red hover:bg-red/90'
            )}
          >
            {transferring
              ? (transferMode === 'deposit' ? 'Depositing…' : 'Withdrawing…')
              : transferMode === 'deposit' ? 'Confirm Deposit' : 'Confirm Withdraw'}
          </button>
        </div>
      )}
    </div>
  );
}
