'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { cn, shortenAddress } from '@/lib/utils';
import { startPoll } from '@/lib/poll';
import { getDefaultChain } from '@/lib/chain';
import ValidatorSetPanel from '@/components/staking/ValidatorSetPanel';
import {
  claimRewards,
  delegate,
  fmtMrsnWei,
  maxSpendable,
  getDelegation,
  getUnbonding,
  getValidatorsFull,
  getValidatorSet,
  stakingErrorMessage,
  undelegate,
  weiToMrsn,
  withdrawUnbonded,
  type UnbondingView,
} from '@/lib/staking';

interface ValidatorRow {
  address: string;
  selfStake: string; // wei
  delegatedTotal: string; // wei
  commissionBps: number;
  myDelegation: string; // wei
  myPending: string; // wei
}

// Validators listed on 30 Sep; more registered ones add a row or two of shift.
const PLACEHOLDER_ROWS = 11;

function StatTile({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-3.5 py-3">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1.5">{label}</p>
      <p className={cn('text-[18px] font-mono font-semibold tabular-nums leading-none', valueClass ?? 'text-foreground')}>{value}</p>
    </div>
  );
}

export default function StakingPage() {
  const { address, provider, isConnected } = useWallet();
  const { toast } = useToast();
  const [rows, setRows] = useState<ValidatorRow[]>([]);
  const [unbonding, setUnbonding] = useState<UnbondingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Record<string, 'delegate' | 'undelegate'>>({});
  // Native balance, so delegate/undelegate amounts are checked before the
  // wallet popup (a 50,000 MRSN delegation from a 5,500 MRSN wallet reached
  // the signer on 17 Sep and would only have failed on-chain).
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  // Where the operator's "Your node" card renders (portal from the validator
  // set panel), so an operator sees self-stake and its actions first.
  const [ownSlot, setOwnSlot] = useState<HTMLDivElement | null>(null);
  // Validators this wallet operates → the matching rows are labelled "your node".
  const [myIdentities, setMyIdentities] = useState<Set<string>>(new Set());
  const amountRefs = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => {
    if (!address) { setMyIdentities(new Set()); return; }
    let alive = true;
    const load = () => getValidatorSet().then((v) => {
      if (alive) setMyIdentities(new Set(v.validators.filter((x) => x.operator.toLowerCase() === address.toLowerCase()).map((x) => x.identity.toLowerCase())));
    }).catch(() => {});
    load();
    const stop = startPoll(load, 60_000);
    return () => { alive = false; stop(); };
  }, [address]);
  useEffect(() => {
    if (!address) { setWalletBalance(null); return; }
    let alive = true;
    const load = () => fetch(getDefaultChain().rpcUrls[0], {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
    }).then((r) => r.json()).then((j) => { if (alive && j.result) setWalletBalance(Number(BigInt(j.result)) / 1e18); }).catch(() => {});
    load();
    const stop = startPoll(load, 15_000);
    return () => { alive = false; stop(); };
  }, [address]);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const validators = await getValidatorsFull();
      const enriched = await Promise.all(
        validators.map(async (v) => {
          const mine = address
            ? await getDelegation(address, v.address).catch(() => ({ amount: '0', pending: '0' }))
            : { amount: '0', pending: '0' };
          return { ...v, myDelegation: mine.amount, myPending: mine.pending };
        }),
      );
      setRows(enriched);
      setLoadError(false);
      if (address) {
        setUnbonding(await getUnbonding(address).catch(() => null));
      }
      setLoading(false);
      return true;
    } catch {
      setLoadError(true);
      setLoading(false);
      return false;
    }
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    // Initial load with quick retries so a transient failure doesn't leave
    // the page empty until the next slow poll cycle.
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (cancelled || (await refresh())) return;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    })();
    const stopPoll = startPoll(refresh, 15_000);
    return () => { cancelled = true; stopPoll(); };
  }, [refresh]);

  const act = async (key: string, fn: () => Promise<string>, okMsg: string) => {
    if (!isConnected || !provider) { toast('Connect your wallet first', 'error'); return; }
    setBusy(key);
    try {
      await fn();
      toast(okMsg, 'success');
      await refresh();
    } catch (e) {
      toast(stakingErrorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  // Largest stake first, as the validator set below ranks them (the chain lists
  // validators in registration order).
  const sortedRows = [...rows].sort((a, b) => {
    const sa = BigInt(a.selfStake) + BigInt(a.delegatedTotal);
    const sb = BigInt(b.selfStake) + BigInt(b.delegatedTotal);
    return sa === sb ? a.address.localeCompare(b.address) : sb > sa ? 1 : -1;
  });
  const totalMine = rows.reduce((s, r) => s + BigInt(r.myDelegation), 0n);
  const totalPending = rows.reduce((s, r) => s + BigInt(r.myPending), 0n);
  const totalNetwork = rows.reduce((s, r) => s + BigInt(r.selfStake) + BigInt(r.delegatedTotal), 0n);

  return (
    <div className="page-shell">
      <div className="mb-6">
        <h1 className="page-title">Staking</h1>
        <p className="page-sub">
          Delegate MRSN to a validator and earn a share of the rewards it earns in
          every block, minus the validator&apos;s commission. Undelegating starts a
          ~4 hour unbonding period before the principal is withdrawable.
          Delegation is native to the chain — no contracts, no custodians.
          {!isConnected && <> Run a node? Connect its operator wallet to see your node, add self-stake or unregister.</>}
        </p>
      </div>

      <div ref={setOwnSlot} data-testid="your-node-slot" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatTile label="Network stake" value={`${fmtMrsnWei(totalNetwork, 0)} MRSN`} />
        <StatTile label="Your delegation" value={`${fmtMrsnWei(totalMine, 2, true)} MRSN`} valueClass="text-primary" />
        <StatTile label="Claimable rewards" value={`${fmtMrsnWei(totalPending, 6)} MRSN`} valueClass={totalPending > 0n ? 'text-green' : undefined} />
        <StatTile
          label="Unbonding"
          value={unbonding ? `${fmtMrsnWei(unbonding.total)} MRSN` : '—'}
          valueClass={unbonding && BigInt(unbonding.withdrawable) > 0n ? 'text-yellow' : undefined}
        />
      </div>

      {unbonding && BigInt(unbonding.withdrawable) > 0n && (
        <div className="mb-6 flex items-center justify-between bg-yellow/5 border border-yellow/20 rounded-xl px-4 py-3">
          <p className="text-sm text-foreground">
            <span className="font-mono font-semibold">{fmtMrsnWei(unbonding.withdrawable)} MRSN</span>{' '}
            finished unbonding and is ready to withdraw.
          </p>
          <button
            onClick={() => act('withdraw', () => withdrawUnbonded(provider), 'Unbonded MRSN withdrawn')}
            disabled={busy !== null}
            className="px-4 py-1.5 premium-gradient text-black rounded-lg text-xs font-semibold hover:brightness-110 transition-all disabled:opacity-50"
          >{busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}</button>
        </div>
      )}

      {/* overflow-x-auto: seven columns are ~1,000px wide; on a phone the Stake /
          Delegate actions were clipped off the right edge with no way to reach them.
          Keep the row within the 1,050px content box of a 1152–1280px window, or
          Claim is cut off at the edge there with no sign that the table scrolls. */}
      <div className="bg-surface border border-border rounded-xl overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-[10px] text-dim uppercase tracking-wider border-b border-border">
              <th className="text-left font-medium px-3 py-3">Validator</th>
              <th className="text-right font-medium px-3 py-3" title="Bonded by the operator">Self-stake (MRSN)</th>
              <th className="text-right font-medium px-3 py-3" title="Staked behind the validator by delegators">Delegated (MRSN)</th>
              <th className="text-right font-medium px-3 py-3" title="Share of delegators' rewards the operator keeps">Commission</th>
              <th className="text-right font-medium px-3 py-3" title="MRSN this wallet has delegated to the validator">Your delegation (MRSN)</th>
              <th className="text-right font-medium px-3 py-3" title="Claimable rewards on your delegation">Rewards (MRSN)</th>
              <th className="text-right font-medium px-3 py-3 w-[300px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {/* Rows of the real height while loading: one "Loading" line swapped
                for eleven rows pushed the whole page down. */}
            {loading && Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
              <tr key={`placeholder-${i}`} className="border-b border-border/50 last:border-0 h-[51px]">
                <td colSpan={7} className="px-3 text-dim text-xs">
                  {i === 0 ? 'Loading validators…' : <span aria-hidden className="block h-2.5 max-w-[560px] rounded bg-surface-2/70 animate-pulse" />}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-dim">
                  {loadError ? 'Could not reach the network — retrying automatically…' : 'No validators found.'}
                </td>
              </tr>
            )}
            {!loading && sortedRows.map((r) => {
              const m = mode[r.address] ?? 'delegate';
              const amt = amounts[r.address] ?? '';
              const own = myIdentities.has(r.address.toLowerCase());
              return (
                <tr key={r.address} id={`delegate-${r.address.toLowerCase()}`} className={cn('border-b border-border/50 last:border-0', own && 'bg-primary/5')}>
                  <td className="px-3 py-3 font-mono text-foreground">{shortenAddress(r.address)}{own && <span className="text-primary"> · your node</span>}</td>
                  {/* Both stake columns in fixed decimals so they read as one unit:
                      0.00 · 1,004.91 · 41,002.00 (community feedback). Exact value on hover. */}
                  <td className="px-3 py-3 text-right font-mono tabular-nums" title={`${fmtMrsnWei(r.selfStake, 18)} MRSN`}>{fmtMrsnWei(r.selfStake, 2, true)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums" title={`${fmtMrsnWei(r.delegatedTotal, 18)} MRSN`}>
                    {fmtMrsnWei(r.delegatedTotal, 2, true)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{(r.commissionBps / 100).toFixed(1)}%</td>
                  <td className={cn('px-3 py-3 text-right font-mono tabular-nums', BigInt(r.myDelegation) > 0n && 'text-primary')} title={`${fmtMrsnWei(r.myDelegation, 18)} MRSN`}>
                    {fmtMrsnWei(r.myDelegation, 2, true)}
                  </td>
                  <td className={cn('px-3 py-3 text-right font-mono tabular-nums', BigInt(r.myPending) > 0n && 'text-green')}>
                    {fmtMrsnWei(r.myPending, 6, true)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="flex rounded-lg border border-border overflow-hidden">
                        <button
                          onClick={() => setMode((s) => ({ ...s, [r.address]: 'delegate' }))}
                          className={cn('px-2 py-1 text-[10px] font-semibold', m === 'delegate' ? 'bg-green/15 text-green' : 'text-dim hover:text-foreground')}
                        >Stake</button>
                        <button
                          onClick={() => setMode((s) => ({ ...s, [r.address]: 'undelegate' }))}
                          className={cn('px-2 py-1 text-[10px] font-semibold', m === 'undelegate' ? 'bg-red/15 text-red' : 'text-dim hover:text-foreground')}
                        >Unstake</button>
                      </div>
                      <div className="relative">
                        <input
                          ref={(el) => { amountRefs.current[r.address] = el; }}
                          value={amt}
                          onChange={(e) => setAmounts((s) => ({ ...s, [r.address]: e.target.value }))}
                          placeholder="MRSN"
                          inputMode="decimal"
                          aria-label={`Amount in MRSN to ${m} with ${shortenAddress(r.address)}`}
                          className="w-24 bg-surface-2 border border-border rounded-lg pl-2 pr-9 py-1 text-xs font-mono text-right focus:outline-none focus:border-primary"
                        />
                        <button
                          type="button"
                          title={m === 'delegate' ? 'Whole wallet balance minus a little gas' : 'Everything you have delegated here'}
                          onClick={() => {
                            const v = m === 'delegate' ? maxSpendable(walletBalance) : weiToMrsn(r.myDelegation, 6);
                            if (!v || v === '0') { toast(m === 'delegate' ? 'No MRSN in this wallet to delegate — claim from the faucet first' : 'Nothing delegated to this validator', 'error'); return; }
                            setAmounts((s) => ({ ...s, [r.address]: v }));
                          }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider text-primary hover:bg-primary/10"
                        >Max</button>
                      </div>
                      <button
                        onClick={() => {
                          if (!isConnected) { toast('Connect your wallet first', 'error'); return; }
                          // An empty amount used to leave this button faded, which read
                          // as "not available"; ask for the amount instead.
                          if (!amt || Number(amt) <= 0) {
                            toast(`Enter the amount of MRSN to ${m === 'delegate' ? 'delegate' : 'undelegate'} first`, 'error');
                            amountRefs.current[r.address]?.focus();
                            return;
                          }
                          const n = Number(amt);
                          if (m === 'delegate' && walletBalance !== null && n + 0.001 > walletBalance) {
                            toast(`You have ${walletBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} MRSN in this wallet — you can delegate at most ${Math.max(0, Math.floor(walletBalance - 0.001)).toLocaleString()} (keep a little for gas; the faucet gives 1,001 an hour)`, 'error');
                            return;
                          }
                          if (m === 'undelegate' && n > Number(BigInt(r.myDelegation)) / 1e18 + 1e-9) {
                            toast(`You have ${(Number(BigInt(r.myDelegation)) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 })} MRSN delegated to this validator`, 'error');
                            return;
                          }
                          act(
                            `stake-${r.address}`,
                            () => (m === 'delegate' ? delegate(provider, r.address, amt) : undelegate(provider, r.address, amt)),
                            m === 'delegate' ? `Delegated ${amt} MRSN` : `Unbonding ${amt} MRSN started (~4h)`,
                          );
                        }}
                        disabled={busy !== null}
                        className={cn(
                          'px-3 py-1 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-40',
                          m === 'delegate' ? 'premium-gradient text-black hover:brightness-110' : 'bg-red/15 text-red hover:bg-red/25',
                        )}
                      >{busy === `stake-${r.address}` ? '…' : m === 'delegate' ? 'Delegate' : 'Undelegate'}</button>
                      {/* Always occupies its slot so the Delegate buttons line up across
                          rows; only clickable (and visible) when there is something to claim. */}
                      <button
                        onClick={() => act(`claim-${r.address}`, () => claimRewards(provider, r.address), 'Rewards claimed')}
                        disabled={busy !== null || BigInt(r.myPending) === 0n}
                        aria-hidden={BigInt(r.myPending) === 0n}
                        tabIndex={BigInt(r.myPending) === 0n ? -1 : 0}
                        className={cn(
                          'w-[54px] px-2.5 py-1 bg-green/15 text-green rounded-lg text-[11px] font-semibold hover:bg-green/25 transition-all disabled:opacity-40',
                          BigInt(r.myPending) === 0n && 'invisible',
                        )}
                      >{busy === `claim-${r.address}` ? '…' : 'Claim'}</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {(loading || rows.length > 0) && (
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-2/40">
                <td className="px-3 py-3 text-xs font-semibold text-foreground">Grand total <span className="text-dim font-normal">· {loading ? '—' : rows.length} validators</span></td>
                <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold" title="Grand total staked (MRSN)">
                  {loading ? '—' : fmtMrsnWei(rows.reduce((s, r) => s + BigInt(r.selfStake), 0n), 2, true)}
                  <div className="text-[10px] text-dim font-normal">staked (MRSN)</div>
                </td>
                <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold" title="Grand total delegated (MRSN)">
                  {loading ? '—' : fmtMrsnWei(rows.reduce((s, r) => s + BigInt(r.delegatedTotal), 0n), 2, true)}
                  <div className="text-[10px] text-dim font-normal">delegated (MRSN)</div>
                </td>
                <td className="px-3 py-3" />
                <td className={cn('px-3 py-3 text-right font-mono tabular-nums font-semibold', totalMine > 0n && 'text-primary')} title="Your total delegation (MRSN)">
                  {loading ? '—' : fmtMrsnWei(totalMine, 2, true)}
                  <div className="text-[10px] text-dim font-normal">yours (MRSN)</div>
                </td>
                <td className={cn('px-3 py-3 text-right font-mono tabular-nums font-semibold', totalPending > 0n && 'text-green')} title="Your claimable rewards (MRSN)">
                  {loading ? '—' : fmtMrsnWei(totalPending, 6, true)}
                  <div className="text-[10px] text-dim font-normal">claimable (MRSN)</div>
                </td>
                <td className="px-3 py-3" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="text-[11px] text-dim mt-4">
        Delegated stake earns rewards and counts toward a validator&apos;s ranking in the open validator set below. Rewards accrue per block and are
        claimable at any time; principal follows the unbonding period.
      </p>

      <div className="mt-4">
        <ValidatorSetPanel ownNodesSlot={ownSlot} />
      </div>
    </div>
  );
}
