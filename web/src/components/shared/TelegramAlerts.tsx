'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useToast } from '@/components/shared/Toast';
import { API_BASE } from '@/lib/api';
import { cn } from '@/lib/utils';

type Kind = 'operator' | 'trader';
interface Status { linked: boolean; bot: string; chats: { kind: Kind; username: string | null; linkedAt: string }[] }

/**
 * "Telegram alerts" control. One wallet signature (no transaction) proves the
 * address; the API answers a one-time deep link to @mersennet_alerts_bot.
 * Pressing /start in Telegram completes the link — this component polls until
 * it sees it. Operators get validator alerts, traders liquidation alerts.
 */
export default function TelegramAlerts({ kind, compact = false, className }: { kind: Kind; compact?: boolean; className?: string }) {
  const { address, signer, isConnected } = useWallet();
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<{ deepLink: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!address) { setStatus(null); return; }
    try {
      const r = await fetch(`${API_BASE}/alerts/status/${address}`);
      if (r.ok) setStatus(await r.json());
    } catch { /* offline */ }
  }, [address]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const message = (k: Kind) => `Mersennet alerts · link Telegram to ${address!.toLowerCase()} · ${k} · ${new Date().toISOString().slice(0, 16)}Z`;

  const start = async () => {
    if (!address || !signer) { toast('Connect your wallet first', 'error'); return; }
    setBusy(true);
    try {
      const signature = await (signer as { signMessage: (m: string) => Promise<string> }).signMessage(message(kind));
      const r = await fetch(`${API_BASE}/alerts/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, kind, signature }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not create the link');
      setLink({ deepLink: j.deepLink, code: j.code });
      window.open(j.deepLink, '_blank', 'noopener');
      // Watch for the /start to land (up to 15 minutes).
      if (pollRef.current) clearInterval(pollRef.current);
      let n = 0;
      pollRef.current = setInterval(async () => {
        n++;
        await load();
        if (n > 180 && pollRef.current) clearInterval(pollRef.current);
      }, 5000);
    } catch (e) {
      const m = (e as Error).message || '';
      toast(/user rejected|denied|ACTION_REJECTED/i.test(m) ? 'Signature cancelled in the wallet.' : m.slice(0, 140), 'error');
    } finally { setBusy(false); }
  };
  useEffect(() => { if (status?.linked && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; setLink(null); } }, [status?.linked]);

  const stop = async () => {
    if (!address || !signer) return;
    if (!confirm('Stop Telegram alerts for this wallet?')) return;
    setBusy(true);
    try {
      const signature = await (signer as { signMessage: (m: string) => Promise<string> }).signMessage(message(kind));
      const r = await fetch(`${API_BASE}/alerts/unlink`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, signature }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Could not unlink');
      toast('Telegram alerts off', 'info');
      await load();
    } catch (e) { toast((e as Error).message.slice(0, 140), 'error'); }
    finally { setBusy(false); }
  };

  if (!isConnected) return null;
  const linked = !!status?.linked;
  const who = status?.chats.map((c) => (c.username ? `@${c.username}` : 'Telegram')).join(', ');

  if (compact) {
    return (
      <span className={cn('inline-flex items-center gap-2 text-[11px]', className)}>
        {linked ? (
          <>
            <span className="text-green">Telegram alerts on{who ? ` · ${who}` : ''}</span>
            <button onClick={stop} disabled={busy} className="text-dim hover:text-foreground underline">stop</button>
          </>
        ) : link ? (
          <a href={link.deepLink} target="_blank" rel="noopener" className="text-primary underline">Open Telegram and press Start ↗</a>
        ) : (
          <button onClick={start} disabled={busy} className="text-primary hover:underline">{busy ? 'Waiting for signature…' : 'Telegram alerts'}</button>
        )}
      </span>
    );
  }

  return (
    <div className={cn('border border-border rounded-lg p-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10px] font-semibold text-foreground uppercase tracking-wider flex-1">Telegram alerts</p>
        {linked ? (
          <>
            <span className="text-[11px] text-green">On{who ? ` · ${who}` : ''}</span>
            <button onClick={stop} disabled={busy} className="text-[10px] uppercase tracking-wider text-dim hover:text-foreground hover:underline">Stop</button>
          </>
        ) : link ? (
          <a href={link.deepLink} target="_blank" rel="noopener" className="premium-gradient px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase tracking-[0.14em] text-black">Open Telegram and press Start ↗</a>
        ) : (
          <button onClick={start} disabled={busy} className="premium-gradient px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase tracking-[0.14em] text-black disabled:opacity-50">{busy ? 'Waiting for signature…' : 'Enable'}</button>
        )}
      </div>
      <p className="text-[11px] text-dim mt-1.5 leading-relaxed">
        {kind === 'operator'
          ? 'A message when your validator misses slots, is benched or jailed, falls behind the chain, goes silent, runs an outdated build — and 24 h / 6 h / 1 h before every protocol switch. One wallet signature, no transaction; /stop in the chat ends it.'
          : 'A message when a position gets within 1.6× of maintenance margin, and when it becomes liquidatable. One wallet signature, no transaction; /stop in the chat ends it.'}
        {link && <> Waiting for you to press <b>Start</b> in Telegram (code <code className="font-mono">{link.code}</code>, valid 15 min)…</>}
      </p>
    </div>
  );
}
