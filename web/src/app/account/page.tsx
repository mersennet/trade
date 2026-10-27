'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useWallet } from '@/hooks/useWallet';
import { api, type AccountProduct, type AccountSummary } from '@/lib/api';
import { startPoll } from '@/lib/poll';
import { cn, shortenAddress } from '@/lib/utils';

const RUN_A_NODE = 'https://docs.mersennet.com/validators/run-a-node/';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const num = (n: number, digits = 2) => Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: digits });
const signed = (n: number, digits = 2) => (n > 0 ? '+' : n < 0 ? '−' : '') + num(n, digits);
const signedUsd = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + '$' + num(n, Math.abs(n) >= 100 ? 0 : 2);
const tone = (n: number | null) => (n == null || n === 0 ? 'text-foreground' : n > 0 ? 'text-green' : 'text-red');

/** One sentence on how a product's figure is counted, from the API's detail. */
function howCounted(p: AccountProduct): string {
  const d = p.detail || {};
  switch (p.key) {
    case 'exchange':
      if (!d.deposited && !d.equity) return 'No collateral deposited on the order book yet.';
      return `Equity ${num(d.equity ?? 0)} MRSN${d.unrealized ? ` (open PnL ${signed(d.unrealized)})` : ''} minus ${num(d.deposited ?? 0)} deposited${d.withdrawn ? `, plus ${num(d.withdrawn)} withdrawn` : ''}.`;
    case 'vault':
      if (!d.deposited) return 'No deposits in the maker vault yet.';
      return `Your shares are worth ${num(d.value ?? 0)} MRSN against ${num(d.deposited)} deposited${d.withdrawn ? ` and ${num(d.withdrawn)} withdrawn` : ''}.`;
    case 'staking': {
      if (!d.delegated && !d.claims) return 'No delegations yet.';
      const base = `Rewards not claimed yet on ${num(d.delegated ?? 0)} MRSN delegated.`;
      return d.claims
        ? `${base} Your ${d.claims} earlier claim${d.claims === 1 ? '' : 's'} are not included: the chain does not report what a claim paid yet.`
        : base;
    }
    case 'node': {
      const vals = d.validators || [];
      const parts = [];
      if (vals.length) parts.push(`${vals.length} validator${vals.length === 1 ? '' : 's'}, ${vals.reduce((s, v) => s + v.blocksProposed, 0).toLocaleString('en-US')} blocks proposed`);
      if (d.nodePoints) parts.push(`${Math.floor(d.nodePoints).toLocaleString('en-US')} node points`);
      if (!parts.length) return 'No node registered to this wallet.';
      const since = d.sinceBlock != null
        ? ` MRSN earnings are recorded from block ${d.sinceBlock.toLocaleString('en-US')}.`
        : vals.length ? ' MRSN earnings are recorded from the next epoch on.' : '';
      return `${parts.join(' · ')}.${since}`;
    }
    case 'referrals':
      return `${d.referees ?? 0} trader${d.referees === 1 ? '' : 's'} referred · ${Math.floor(d.referralPoints ?? 0).toLocaleString('en-US')} referral points. Referrals earn points, not MRSN.`;
  }
}

function productLink(p: AccountProduct): { href: string; label: string; external?: boolean } {
  if (p.key === 'node' && !(p.detail?.validators || []).length) return { href: RUN_A_NODE, label: 'Run a node', external: true };
  return { href: p.href, label: p.label === 'Node' ? 'Validators' : p.label };
}

export default function AccountPage() {
  return (
    <Suspense>
      <Account />
    </Suspense>
  );
}

function Account() {
  const { address, isConnected, connect } = useWallet();
  // ?address=0x… shows any wallet (everything here is public chain data).
  const query = useSearchParams().get('address');
  const viewing = query && ADDR_RE.test(query) ? query.toLowerCase() : address ? address.toLowerCase() : null;
  const [loaded, setLoaded] = useState<AccountSummary | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const data = loaded && loaded.address === viewing ? loaded : null;
  const failed = failedFor === viewing;

  useEffect(() => {
    if (!viewing) return;
    let alive = true;
    const load = () => api.getAccountSummary(viewing)
      .then((s) => { if (alive) { setLoaded(s); setFailedFor(null); } })
      .catch(() => { if (alive) setFailedFor(viewing); });
    load();
    const stop = startPoll(load, 60_000);
    return () => { alive = false; stop(); };
  }, [viewing]);

  const header = (
    <header className="mb-2">
      <h1 className="page-title">Account summary</h1>
      <p className="page-sub">
        What this wallet has made or lost on every Mersennet product since it started, in MRSN and in dollars.
      </p>
    </header>
  );

  if (!viewing) {
    return (
      <div className="page-shell space-y-4">
        {header}
        <div className="bg-surface border border-border rounded-xl p-6 md:p-8 flex flex-col md:flex-row items-start md:items-center gap-5">
          <div className="flex-1">
            <p className="text-sm text-foreground font-semibold">Connect a wallet to see its summary</p>
            <p className="text-xs text-dim mt-1 leading-relaxed">
              Trading, the maker vault, staking, your node and referrals in one place, all read from the chain.
            </p>
          </div>
          {!isConnected && (
            <button
              onClick={() => { connect().catch(() => {}); }}
              className="px-5 h-9 premium-gradient text-black rounded-lg text-[11.5px] font-semibold transition-all hover:brightness-110 shrink-0"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    );
  }

  const own = address && viewing === address.toLowerCase();
  return (
    <div className="page-shell space-y-4">
      {header}

      <div className="bg-surface border border-border rounded-xl p-5 md:p-6" data-testid="account-total">
        <p className="text-[11px] text-dim uppercase tracking-wider">
          Lifetime result · {own ? 'your wallet' : <span className="font-mono normal-case">{shortenAddress(viewing)}</span>}
        </p>
        {data ? (
          <>
            <p className={cn('mt-2 text-3xl font-mono font-semibold tabular-nums', tone(data.total.mrsn))}>
              {signed(data.total.mrsn)} <span className="text-base text-dim font-normal">MRSN</span>
            </p>
            <p className="mt-1 text-sm text-dim font-mono tabular-nums">
              {data.total.usd != null ? `≈ ${signedUsd(data.total.usd)}` : 'Dollar value unavailable'}
              {data.mrsnUsd ? ` · 1 MRSN = $${data.mrsnUsd.toFixed(2)} on the testnet's MRSN/USD market` : ''}
            </p>
            {!data.complete && (
              <p className="mt-2 text-xs text-yellow">Some products could not be read just now; the total leaves them out and retries every minute.</p>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-dim">{failed ? 'Could not load the summary. Retrying…' : 'Loading…'}</p>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="hidden md:grid grid-cols-[150px_150px_130px_1fr_110px] gap-4 px-5 py-2.5 border-b border-border text-[10.5px] text-dim uppercase tracking-wider">
          <span>Product</span><span className="text-right">MRSN</span><span className="text-right">Dollars</span><span>How it is counted</span><span />
        </div>
        <div className="divide-y divide-border">
          {(data?.products ?? []).map((p) => {
            const link = productLink(p);
            return (
              <div key={p.key} className="grid grid-cols-2 md:grid-cols-[150px_150px_130px_1fr_110px] gap-x-4 gap-y-1 px-5 py-3.5 items-center" data-testid={`account-${p.key}`}>
                <span className="text-sm text-foreground font-medium">{p.label}</span>
                <span className={cn('text-right font-mono tabular-nums text-sm font-semibold', tone(p.mrsn))}>
                  {p.mrsn != null ? signed(p.mrsn) : '—'}
                </span>
                <span className="hidden md:block text-right font-mono tabular-nums text-sm text-dim">
                  {p.usd != null ? signedUsd(p.usd) : '—'}
                </span>
                <span className="col-span-2 md:col-span-1 text-xs text-dim leading-relaxed">
                  {p.error ? 'Could not be read just now.' : howCounted(p)}
                  <span className="md:hidden font-mono"> {p.usd != null ? `(${signedUsd(p.usd)})` : ''}</span>
                </span>
                {link.external ? (
                  <a href={link.href} target="_blank" rel="noopener" className="col-span-2 md:col-span-1 text-xs text-primary hover:underline md:text-right">{link.label} ↗</a>
                ) : (
                  <Link href={link.href} className="col-span-2 md:col-span-1 text-xs text-primary hover:underline md:text-right">{link.label} →</Link>
                )}
              </div>
            );
          })}
          {!data && <div className="px-5 py-6 text-sm text-dim">{failed ? 'Retrying…' : 'Reading the chain…'}</div>}
        </div>
      </div>

      <p className="text-[11px] text-dim leading-relaxed">
        MRSN is a testnet token with no outside market: the dollar figures use the price on the testnet&apos;s MRSN/USD market and
        are a sense of scale. Exchange results count the margin you deposited with your wallet; node earnings are worked out
        epoch by epoch from the validator set and are an estimate. Updated every minute.
      </p>
    </div>
  );
}
