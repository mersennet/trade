'use client';
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { api, type VerifiedNode } from '@/lib/api';
import type { JsonRpcSigner } from 'ethers';
import { cn } from '@/lib/utils';

/**
 * Verified node runner: prove you run a reachable Mersennet node and earn
 * daily points. Flow: node config names your wallet as operator → you sign a
 * short message here → the API asks your node (host:30303) for its signed
 * attestation and checks it names the same wallet.
 */
export default function NodeRunnerCard() {
  const { address, isConnected, signer } = useWallet();
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [mine, setMine] = useState<VerifiedNode[]>([]);
  const [pointsPerDay, setPointsPerDay] = useState(500);
  const [network, setNetwork] = useState<{ total: number; active: number } | null>(null);

  const refresh = useCallback(() => {
    if (address) api.getMyNodes(address).then((r) => { setMine(r.nodes); setPointsPerDay(r.pointsPerDay); }).catch(() => {});
    api.getVerifiedNodes().then((r) => setNetwork({ total: r.total, active: r.active })).catch(() => {});
  }, [address]);
  useEffect(() => { refresh(); }, [refresh]);

  const verify = async () => {
    if (!address || !signer) return;
    const h = host.trim();
    if (!h) { setResult({ ok: false, text: 'Enter your node\u2019s public IP or hostname.' }); return; }
    setBusy(true); setResult(null);
    try {
      const message = `Mersennet node runner verification\nnode: ${h}\nwallet: ${address.toLowerCase()}`;
      const signature = await (signer as JsonRpcSigner).signMessage(message);
      const r = await api.verifyNode({ host: h, wallet: address, signature });
      setResult({ ok: true, text: `Verified — node ${r.identity.slice(0, 10)}… at height ${r.height.toLocaleString()} (${r.version}). ${r.pointsPerDay} points per day while it stays online.` });
      setHost('');
      refresh();
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      setResult({ ok: false, text: err?.message || 'Verification failed', hint: err?.hint });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden" data-testid="node-runner-card">
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <h3 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Verified node runner</h3>
        {network && <span className="text-[10px] text-dim font-mono">{network.active} active / {network.total} verified</span>}
      </div>
      <div className="px-4 py-3 space-y-3">
        <p className="text-[12px] text-dim leading-relaxed">
          Run a Mersennet full node and earn <span className="text-foreground font-medium">{pointsPerDay} points a day</span> while it is online.
          Install in one command (<a href="https://docs.mersennet.com/validators/run-a-node/" target="_blank" rel="noopener" className="text-primary hover:underline">guide</a>),
          set <code className="font-mono text-[11px] text-foreground">&quot;operator_address&quot;: &quot;{address ? address.toLowerCase() : '0x…your wallet'}&quot;</code> in the
          <code className="font-mono text-[11px] text-foreground"> p2p</code> section of <code className="font-mono text-[11px] text-foreground">/etc/mersennet/config.json</code>, restart it, then verify here.
        </p>

        {mine.length > 0 && (
          <ul className="divide-y divide-border border border-border rounded-lg">
            {mine.map((n) => (
              <li key={n.identity} className="flex items-center justify-between px-3 py-2 text-[12px]">
                <div>
                  <span className="font-mono text-foreground">{n.host}</span>
                  <span className="text-dim"> · {n.identity.slice(0, 10)}… · {n.version || 'unknown build'}</span>
                </div>
                <span className={cn('font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded', n.active ? 'text-primary bg-primary/10' : 'text-dim bg-surface-2')}>
                  {n.active ? 'online' : 'offline'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {isConnected ? (
          <div className="flex gap-2">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Node public IP or hostname"
              spellCheck={false}
              className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-[12px] font-mono text-foreground placeholder:text-dim focus:outline-none focus:border-primary/60"
            />
            <button
              onClick={verify}
              disabled={busy}
              className="premium-gradient px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.14em] disabled:opacity-50"
            >{busy ? 'Checking…' : 'Sign & verify'}</button>
          </div>
        ) : (
          <p className="text-[12px] text-dim">Connect the wallet you configured as operator to verify a node.</p>
        )}

        {result && (
          <div className={cn('text-[12px] rounded-lg px-3 py-2 border', result.ok ? 'border-primary/30 bg-primary/5 text-foreground' : 'border-down/30 bg-down/5 text-foreground')}>
            {result.text}
            {result.hint && <p className="text-dim mt-1">{result.hint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
