'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { api, type VerifiedNode, type NodeBuild } from '@/lib/api';
import UpgradeBadge from '@/components/shared/UpgradeBadge';
import { cn, shortenAddress } from '@/lib/utils';
import { getDefaultChain } from '@/lib/chain';
import { startPoll } from '@/lib/poll';
import {
  addSelfStake, getValidatorSet, nextProtocolSwitch, registerValidator, unregisterValidator, weiToMrsn,
  type ValidatorSetEntry, type ValidatorSetView,
} from '@/lib/staking';

/**
 * Open validator set: who is producing blocks, and the one-click path from
 * "verified node runner" to "validator". Registration needs the node's
 * signed proof, which the terminal already has for verified nodes (the API
 * stores the `registrationProof` from the node's whoami), so an operator
 * picks a node, chooses a self-stake and commission, and signs one tx.
 */
const STATUS_TONE: Record<string, string> = {
  active: 'text-primary bg-primary/10',
  pending: 'text-yellow-400 bg-yellow-400/10',
  standby: 'text-dim bg-surface-2',
  jailed: 'text-down bg-down/10',
  exiting: 'text-dim bg-surface-2',
};

function fmtMrsn(wei: string) { return Number(weiToMrsn(wei, 0)).toLocaleString(); }

export default function ValidatorSetPanel() {
  const { address, provider, isConnected } = useWallet();
  const { toast } = useToast();
  const [view, setView] = useState<ValidatorSetView | null>(null);
  const [mine, setMine] = useState<VerifiedNode[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [stake, setStake] = useState('1000');
  const [commission, setCommission] = useState('500');
  const [busy, setBusy] = useState<string | null>(null);
  const [topUp, setTopUp] = useState<Record<string, string>>({});
  const [balance, setBalance] = useState<number | null>(null);
  const [latestSha, setLatestSha] = useState<string | null>(null);
  // Live height of the operator's own nodes, probed through the API once a
  // minute and compared with the head read at the same moment. The stored
  // height from the periodic recheck can be half an hour old, which made a
  // healthy validator look "670 blocks behind" (first outside validator).
  const [live, setLive] = useState<Record<string, { height: number; head: number; at: number }>>({});
  const [builds, setBuilds] = useState<{ latest: string | null; byId: Record<string, NodeBuild> }>({ latest: null, byId: {} });

  const refresh = useCallback(async () => {
    try { setView(await getValidatorSet()); } catch { /* rpc hiccup */ }
    api.getNodeBuilds().then((r) => setBuilds({ latest: r.latest, byId: Object.fromEntries((r.nodes || []).map((n) => [n.identity.toLowerCase(), n])) })).catch(() => {});
    if (address) api.getMyNodes(address).then((r) => { setMine(r.nodes); setLatestSha(r.latest_sha || null); }).catch(() => {});
    if (address) {
      // Native balance straight from the Mersennet RPC (the wallet provider
      // may still be pointed at another chain right after connecting).
      fetch(getDefaultChain().rpcUrls[0], {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
      }).then((r) => r.json()).then((j) => { if (j.result) setBalance(Number(BigInt(j.result)) / 1e18); }).catch(() => {});
    }
  }, [address]);
  useEffect(() => { refresh(); return startPoll(refresh, 15_000); }, [refresh]);

  const registered = useMemo(() => new Set((view?.validators || []).map((v) => v.identity.toLowerCase())), [view]);
  const candidates = useMemo(() => mine.filter((n) => n.registration_proof && !registered.has(n.identity.toLowerCase())), [mine, registered]);
  const nodeByIdentity = useMemo(() => Object.fromEntries(mine.map((n) => [n.identity.toLowerCase(), n])), [mine]);
  useEffect(() => {
    if (!address || mine.length === 0) return;
    let alive = true;
    const probe = async () => {
      for (const n of mine) {
        try {
          const [r, v] = await Promise.all([api.probeNode(n.host), getValidatorSet()]);
          if (alive && r.reachable && typeof r.height === 'number') {
            setLive((prev) => ({ ...prev, [n.identity.toLowerCase()]: { height: r.height as number, head: v.height, at: Date.now() } }));
          }
        } catch { /* probe endpoint is rate limited; try again next minute */ }
      }
    };
    probe();
    const t = setInterval(probe, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [address, mine]);
  useEffect(() => { if (!selected && candidates[0]) setSelected(candidates[0].identity); }, [candidates, selected]);
  const minStake = view ? Number(weiToMrsn(view.params.minSelfStake, 0)) : 1000;
  const blocksToEpoch = view ? Math.max(0, view.nextEpochAt - view.height) : 0;
  const myEntries = (view?.validators || []).filter((v) => address && v.operator.toLowerCase() === address.toLowerCase());
  const activationPending = !!view && !view.active;

  const act = async (label: string, fn: () => Promise<string>, ok: string) => {
    if (!isConnected || !provider) { toast('Connect your wallet first', 'error'); return; }
    setBusy(label);
    try { await fn(); toast(ok, 'success'); await refresh(); }
    catch (e) { toast((e as Error).message?.slice(0, 160) || 'Transaction failed', 'error'); }
    finally { setBusy(null); }
  };

  const sorted = [...(view?.validators || [])].sort((a, b) => (BigInt(b.votingStake) > BigInt(a.votingStake) ? 1 : -1));
  const outdatedNodes = useMemo(() => mine.filter((n) => n.outdated), [mine]);
  const nextSwitch = view ? nextProtocolSwitch(view.params, view.height) : 0;

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="validator-set-panel">
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Validator set</h3>
        {view && (
          <span className="text-[10px] text-dim font-mono text-right">
            {view.active
              ? `epoch ${view.epoch} · ${view.validators.length} registered · ${view.activeSet.length}/${view.params.maxValidators} active · next epoch in ${blocksToEpoch.toLocaleString()} blocks (~${Math.round(blocksToEpoch * 2 / 60)} min)`
              : `opens at block ${view.params.activationHeight.toLocaleString()} · ${Math.max(0, view.params.activationHeight - view.height).toLocaleString()} blocks to go`}
          </span>
        )}
      </div>

      <div className="px-4 py-3 space-y-3">
        <p className="text-[12px] text-dim leading-relaxed">
          Anyone can become a validator. Run a node with your wallet as operator (it appears below once verified), bond at least{' '}
          <span className="text-foreground font-medium">{minStake.toLocaleString()} MRSN</span> as self-stake, and register. You join the active set at the next epoch
          (epochs are {view ? Math.round(view.params.epochBlocks * 2 / 60) : 60} minutes; the top {view?.params.maxValidators ?? 12} by self + delegated stake produce blocks).
          Miss more than {view ? view.params.jailMissBps / 100 : 20}% of your leader slots in an epoch and you sit out the next one{view?.params.benchHeight ? (view.height >= view.params.benchHeight ? '; three missed slots bench you for the rest of the epoch' : ` (from block ${view.params.benchHeight.toLocaleString()}, three missed slots bench you for the rest of the epoch)`) : ''}. Unregister any time; your stake unbonds over ~{view ? Math.round(view.params.unbondingBlocks * 2 / 3600) : 3} hours.
        </p>

        {outdatedNodes.length > 0 && (
          <div className="border border-yellow-400/40 bg-yellow-400/5 rounded-lg p-3 space-y-1" data-testid="node-upgrade-notice">
            <p className="text-[11px] font-semibold text-yellow-400 uppercase tracking-wider">Upgrade required</p>
            <p className="text-[12px] text-dim leading-relaxed">
              {outdatedNodes.length > 1 ? 'Your nodes run' : 'Your node runs'} build{' '}
              {outdatedNodes.map((n) => <code key={n.identity} className="font-mono text-[11px] text-foreground">{n.build_sha || n.version || 'unknown'} </code>)}
              and the current release is <code className="font-mono text-[11px] text-foreground">{latestSha}</code>.
              {nextSwitch > 0 && (
                <> A protocol switch is scheduled at block <span className="text-foreground font-medium">{nextSwitch.toLocaleString()}</span> (~{Math.round((nextSwitch - (view?.height || 0)) * 2 / 3600)} h); a validator on an old build forks off there.</>
              )}
              {' '}Upgrading is the install command again and keeps your keys and data:
            </p>
            <code className="block font-mono text-[11px] text-foreground bg-surface-2 rounded px-2 py-1 overflow-x-auto">curl -fsSL https://mersennet.com/downloads/install.sh | sudo bash -s -- --operator {address?.toLowerCase()}</code>
          </div>
        )}

        {isConnected && (
          <div className="border border-border rounded-lg p-3 space-y-2">
            <p className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Register a node</p>
            {candidates.length === 0 ? (
              myEntries.length > 0 ? (
                <p className="text-[12px] text-dim">
                  Your node{myEntries.length > 1 ? 's are' : ' is'} registered: {myEntries.map((v) => shortenAddress(v.identity)).join(', ')} — status and slots in the table below. To add another node, install it with <code className="font-mono text-[11px] text-foreground">--operator {address?.toLowerCase()}</code>; it appears here within ~10 minutes of being online.
                </p>
              ) : (
                <p className="text-[12px] text-dim">
                  No verified node for this wallet yet. Install one with <code className="font-mono text-[11px] text-foreground">--operator {address?.toLowerCase()}</code> (see <a className="text-primary hover:underline" href="https://docs.mersennet.com/validators/run-a-node/" target="_blank" rel="noopener">the guide</a>); it shows up here within ~10 minutes of being online.
                </p>
              )
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                <label className="text-[10px] text-dim uppercase tracking-wider md:col-span-2">Node
                  <select value={selected} onChange={(e) => setSelected(e.target.value)} className="mt-1 w-full bg-surface-2 border border-border rounded-lg px-2 py-2 text-[12px] font-mono text-foreground">
                    {candidates.map((n) => <option key={n.identity} value={n.identity}>{n.host} · identity {shortenAddress(n.identity)} · {n.version}</option>)}
                  </select>
                  <span className="block mt-1 text-[10px] normal-case tracking-normal text-dim">The identity is your node&apos;s signing key, not your wallet; your wallet {address ? shortenAddress(address) : ''} is recorded as the operator and receives the rewards.</span>
                </label>
                <label className="text-[10px] text-dim uppercase tracking-wider">Self-stake (MRSN)
                  <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" className="mt-1 w-full bg-surface-2 border border-border rounded-lg px-2 py-2 text-[12px] font-mono text-foreground" />
                  {balance !== null && (
                    <span className={cn('block mt-1 text-[10px] normal-case tracking-normal', balance < minStake + 0.001 ? 'text-down' : 'text-dim')}>
                      Balance {balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} MRSN
                      {balance < minStake + 0.001 && address && (
                        <> · <a className="underline" href={`https://faucet.mersennet.com/?address=${address}`} target="_blank" rel="noopener noreferrer">claim from the faucet</a> (bond + gas)</>
                      )}
                    </span>
                  )}
                </label>
                <label className="text-[10px] text-dim uppercase tracking-wider">Commission (bps)
                  <input value={commission} onChange={(e) => setCommission(e.target.value)} inputMode="numeric" className="mt-1 w-full bg-surface-2 border border-border rounded-lg px-2 py-2 text-[12px] font-mono text-foreground" />
                </label>
                <button
                  disabled={!!busy || activationPending}
                  onClick={() => {
                    const node = candidates.find((n) => n.identity === selected);
                    if (!node?.registration_proof) { toast('This node has no registration proof yet — restart it on the latest build', 'error'); return; }
                    if (Number(stake) < minStake) { toast(`Self-stake must be at least ${minStake} MRSN`, 'error'); return; }
                    // The precompile pulls the bond from the balance after gas: bonding your whole balance fails.
                    if (balance !== null && balance < Number(stake) + 0.001) {
                      toast(balance < minStake + 0.001
                        ? `You need ${minStake.toLocaleString()} MRSN plus a little gas; you have ${balance.toFixed(3)}. Claim from the faucet, then register.`
                        : `Bonding ${Number(stake).toLocaleString()} MRSN leaves nothing for gas — bond a little less than your ${balance.toFixed(3)} MRSN balance.`, 'error');
                      return;
                    }
                    const proof = node.registration_proof;
                    act('register', () => registerValidator(provider, node.identity, stake, Number(commission) || 0, proof), 'Registered — active from the next epoch');
                  }}
                  className="premium-gradient px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.14em] disabled:opacity-50 md:col-span-4"
                >{activationPending ? `Registration opens at block ${view?.params.activationHeight.toLocaleString()}` : busy === 'register' ? 'Registering…' : `Bond ${Number(stake || 0).toLocaleString()} MRSN & register`}</button>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-dim text-[10px] uppercase tracking-wider border-b border-border">
                <th className="text-left py-1.5 pr-3" title="By self + delegated stake; the top N produce blocks">#</th>
                <th className="text-left py-1.5 pr-3">Validator</th>
                <th className="text-left py-1.5 pr-3">Operator</th>
                <th className="text-right py-1.5 pr-3">Self-stake</th>
                <th className="text-right py-1.5 pr-3">Delegated</th>
                <th className="text-right py-1.5 pr-3">Proposed / missed (this epoch)</th>
                <th className="text-left py-1.5 pr-3" title="Node build reported by the node itself (whoami); the current release is on mersennet.com/downloads">Build</th>
                <th className="text-right py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr><td colSpan={8} className="py-3 text-dim">{view?.active ? 'No registrations yet.' : 'The set opens at activation; the four genesis validators are seeded then.'}</td></tr>
              )}
              {sorted.map((v: ValidatorSetEntry, i: number) => {
                const own = !!address && v.operator.toLowerCase() === address.toLowerCase();
                // In the active set this epoch? Registrations join at the boundary; below
                // the top-N line they wait for stake to rank them in. Both shown dimmed.
                const inSet = !!view?.activeSet.some((a) => a.toLowerCase() === v.identity.toLowerCase());
                const b = builds.byId[v.identity.toLowerCase()];
                return (
                  <tr key={v.identity} className={cn('border-b border-border last:border-0', own && 'bg-primary/5', !inSet && 'opacity-50')}>
                    <td className="py-1.5 pr-3 font-mono text-dim" title={inSet ? 'In the active set: proposes and votes this epoch' : 'Not in the active set this epoch'}>{i < (view?.params.maxValidators ?? 12) ? `#${i + 1}` : '—'}</td>
                    <td className="py-1.5 pr-3 font-mono text-foreground">{shortenAddress(v.identity)}{v.genesis && <span className="text-dim"> · genesis</span>}</td>
                    <td className="py-1.5 pr-3 font-mono text-dim">{shortenAddress(v.operator)}{own && <span className="text-primary"> · you</span>}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{fmtMrsn(v.selfStake)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{fmtMrsn(v.delegated)}</td>
                    <td className={cn('py-1.5 pr-3 text-right font-mono', v.missedSlots > 0 && v.proposedSlots === 0 ? 'text-down' : '')} title="Leader slots this epoch: blocks your node proposed vs. slots it missed. Missing more than 20% of at least 5 slots jails the node for the next epoch.">{v.proposedSlots} proposed<span className="text-dim"> · {v.missedSlots} missed</span></td>
                    <td className="py-1.5 pr-3 font-mono" title={b?.version || 'The node has not answered a build query yet'}>
                      {!b?.build && <span className="text-dim">—</span>}
                      {b?.build && !b.outdated && <span className="text-dim">{b.build}</span>}
                      {b?.build && b.outdated && <UpgradeBadge build={b.build} latest={builds.latest} />}
                    </td>
                    <td className="py-1.5 text-right"><span className={cn('font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded', STATUS_TONE[v.status] || 'text-dim')}>{v.status}</span>{v.benched && <span title="Missed 3 leader slots this epoch: out of the leader rotation until the epoch boundary (still voting)" className="ml-1 font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded text-yellow-400 bg-yellow-400/10">benched</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {myEntries.map((v) => {
          const node = nodeByIdentity[v.identity.toLowerCase()];
          const probe = live[v.identity.toLowerCase()];
          // Only a live reading may drive a warning; the stored height is shown as information.
          const behind = probe ? Math.max(0, probe.head - probe.height) : null;
          const proposing = v.proposedSlots > 0 && v.missedSlots === 0;
          const silent = v.status === 'active' && v.proposedSlots === 0 && v.missedSlots >= 2;
          const lagging = behind !== null && behind > 100 && !proposing;
          return (
          <div key={v.identity} className={cn('border rounded-lg px-3 py-2 text-[12px] space-y-1', silent || lagging ? 'border-down/50 bg-down/5' : 'border-border')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-foreground">{shortenAddress(v.identity)}</span>
            <span className="text-dim">self-stake {fmtMrsn(v.selfStake)} MRSN · {v.commissionBps / 100}% commission · {v.status}{v.status === 'jailed' ? ` until epoch ${v.jailedUntilEpoch}` : ''}</span>
            {probe ? (
              <span className={cn('font-mono text-[11px]', lagging ? 'text-down' : 'text-dim')} title="Your node's height, probed live through the API and compared with the head at the same moment">
                node at {probe.height.toLocaleString()}{behind !== null && behind > 100 ? ` · ${behind.toLocaleString()} blocks behind` : ' · in sync'}
              </span>
            ) : node ? (
              <span className="font-mono text-[11px] text-dim" title="Height at the network's last periodic check (up to 30 minutes old); a live reading follows shortly">
                last seen at {node.height.toLocaleString()}
              </span>
            ) : null}
            <span className="flex-1" />
            {!v.genesis && !v.exiting && (
              <>
                <input value={topUp[v.identity] || ''} onChange={(e) => setTopUp({ ...topUp, [v.identity]: e.target.value })} placeholder="MRSN" title={balance !== null ? `Wallet balance ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} MRSN` : undefined} className={cn('w-24 bg-surface-2 border rounded-lg px-2 py-1 text-[11px] font-mono', balance !== null && Number(topUp[v.identity] || 0) + 0.001 > balance ? 'border-down/60 text-down' : 'border-border')} />
                <button disabled={!!busy} onClick={() => {
                  const amt = Number(topUp[v.identity] || 0);
                  if (!(amt > 0)) { toast('Enter the amount of MRSN to add', 'error'); return; }
                  // The bond is taken from the wallet balance after gas: refuse
                  // before the wallet popup instead of letting the transaction fail.
                  if (balance !== null && amt + 0.001 > balance) {
                    toast(`You have ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} MRSN in this wallet — enter at most ${Math.max(0, Math.floor(balance - 0.001)).toLocaleString()} (the faucet gives 1,001 an hour)`, 'error');
                    return;
                  }
                  act('top', () => addSelfStake(provider, v.identity, String(amt)), `Added ${amt.toLocaleString()} MRSN to the self-stake of ${shortenAddress(v.identity)}`);
                }} className="text-[10px] uppercase tracking-wider text-primary hover:underline">Add stake</button>
                <button disabled={!!busy} onClick={() => { if (confirm('Leave the validator set at the next epoch? Your self-stake unbonds afterwards.')) act('exit', () => unregisterValidator(provider, v.identity), 'Exit scheduled for the next epoch'); }} className="text-[10px] uppercase tracking-wider text-down hover:underline">Unregister</button>
              </>
            )}
          </div>
          {(silent || lagging) && (
            <p className="text-[11px] text-down">
              {lagging
                ? `Your node is ${behind!.toLocaleString()} blocks behind the chain, so it cannot propose. `
                : 'Your node is in the active set but has not proposed any of its slots this epoch. '}
              {v.benched
                ? 'It is benched: out of the leader rotation until the epoch boundary (it still votes), and the boundary will jail it for the next epoch. '
                : 'Each missed slot delays the network by a failover round; missing more than 20% of your slots jails the validator for the next epoch. '}
              Check the server: <code className="font-mono">systemctl status mersennet</code>, <code className="font-mono">mersennet-check</code>, and <code className="font-mono">journalctl -u mersennet -n 100</code>. If the node is stuck, re-run the installer with <code className="font-mono">--reset-state</code>; if you cannot fix it now, <span className="underline">Unregister</span> so the network does not wait on it.
            </p>
          )}
          </div>
          );
        })}
      </div>
    </div>
  );
}
