'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, type RevenuePayer, type RevenueReport } from '@/lib/api';
import { startPoll } from '@/lib/poll';
import { cn, shortenAddress } from '@/lib/utils';

const KEY_STORE = 'mersennet-ops-admin-key';
// The admin key lives in sessionStorage (this tab only); a change notifies the page.
const keyStore = {
  subscribe: (cb: () => void) => { window.addEventListener('ops-admin-key', cb); return () => window.removeEventListener('ops-admin-key', cb); },
  get: () => sessionStorage.getItem(KEY_STORE),
  set: (k: string | null) => {
    if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE);
    window.dispatchEvent(new Event('ops-admin-key'));
  },
};
const WINDOWS = ['24h', '7d', '30d', '1y', 'all'] as const;
type WindowKey = (typeof WINDOWS)[number];
const WINDOW_LABEL: Record<WindowKey, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '1y': '1 year', all: 'All time' };
const PAYERS: { key: RevenuePayer; label: string; color: string; note: string }[] = [
  { key: 'users', label: 'Users', color: '#2bd96a', note: 'everyone we do not run or flag' },
  { key: 'flagged', label: 'Flagged', color: '#e5b93b', note: 'the ARB farm and other excluded wallets' },
  { key: 'ours', label: 'Our wallets', color: '#7d8a99', note: 'market makers, takers, keeper, faucet' },
];

const mrsn = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: n !== 0 && Math.abs(n) < 10 ? Math.min(d, 2) : 0 });
const usd = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 }));
const pct = (now: number, before: number) => (before > 0 ? `${now >= before ? '+' : '−'}${Math.abs(((now - before) / before) * 100).toFixed(0)}%` : now > 0 ? 'new' : '—');
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${mrsn(Math.abs(n))}`;

function DailyChart({ data, events }: { data: RevenueReport['daily']; events: RevenueReport['events'] }) {
  const days = data.slice(-60);
  if (!days.length) return <p className="text-xs text-dim">No days recorded yet.</p>;
  const total = (d: (typeof days)[number]) => PAYERS.reduce((s, p) => s + d.feesMrsn[p.key], 0);
  const max = Math.max(...days.map(total), 1e-9);
  const W = 720, H = 170, gap = 2;
  const bw = W / days.length - gap;
  const dayIndex = new Map(days.map((d, i) => [d.day, i]));
  const marks = events
    .map((e) => ({ ...e, i: dayIndex.get(e.at.slice(0, 10)) }))
    .filter((e): e is typeof e & { i: number } => e.i != null);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full h-auto" role="img" aria-label="Network fees per day by payer">
        {days.map((d, i) => {
          let y = H;
          return (
            <g key={d.day}>
              <title>{`${d.day}${d.closed ? '' : ' (so far)'}: ${mrsn(total(d), 3)} MRSN in fees, ${mrsn(total(d) / 2, 3)} to the treasury`}</title>
              {PAYERS.map((p) => {
                const h = (d.feesMrsn[p.key] / max) * (H - 6);
                y -= h;
                return <rect key={p.key} x={i * (bw + gap)} y={y} width={bw} height={h} fill={p.color} opacity={d.closed ? 0.9 : 0.5} />;
              })}
            </g>
          );
        })}
        {marks.map((m, k) => (
          <g key={k}>
            <title>{`${m.at.slice(0, 16).replace('T', ' ')} UTC · ${m.label}`}</title>
            <line x1={m.i * (bw + gap) + bw / 2} x2={m.i * (bw + gap) + bw / 2} y1={0} y2={H} stroke={m.kind === 'incident' ? '#ef4444' : '#60a5fa'} strokeDasharray="3 3" strokeWidth={1} />
            <circle cx={m.i * (bw + gap) + bw / 2} cy={4} r={3} fill={m.kind === 'incident' ? '#ef4444' : '#60a5fa'} />
          </g>
        ))}
        <text x={0} y={H + 14} fontSize={10} fill="currentColor" opacity={0.6}>{days[0].day}</text>
        <text x={W} y={H + 14} fontSize={10} fill="currentColor" opacity={0.6} textAnchor="end">{days[days.length - 1].day}</text>
      </svg>
      <div className="flex flex-wrap gap-4 mt-2 text-[11px] text-dim">
        {PAYERS.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />{p.label}</span>
        ))}
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-0.5 bg-[#60a5fa]" />upgrade / note</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-0.5 bg-[#ef4444]" />incident</span>
        <span>Hover a bar or a line for the figures.</span>
      </div>
    </div>
  );
}

export default function RevenuePage() {
  const key = useSyncExternalStore(keyStore.subscribe, keyStore.get, () => null);
  const [input, setInput] = useState('');
  const [data, setData] = useState<RevenueReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState<WindowKey>('7d');

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () => api.getRevenue(key)
      .then((r) => { if (alive) { setData(r); setError(null); } })
      .catch((e: Error) => {
        if (!alive) return;
        if (/admin key/i.test(e.message)) {
          setError('That key was refused.');
          keyStore.set(null);
        } else {
          setError(`Could not load the report: ${e.message}`);
        }
      });
    load();
    const stop = startPoll(load, 60_000);
    return () => { alive = false; stop(); };
  }, [key]);

  if (!key) {
    return (
      <div className="page-shell max-w-md space-y-4">
        <h1 className="page-title">Revenue</h1>
        <p className="page-sub">Internal. Enter the admin API key; it stays in this browser tab only.</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (input.trim()) { keyStore.set(input.trim()); setInput(''); } }}
        >
          <input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Admin key" autoComplete="off"
            className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
          <button type="submit" className="px-4 py-2 bg-primary hover:bg-primary-hover text-black rounded-lg text-sm font-medium">Open</button>
        </form>
        {error && <p className="text-xs text-red">{error}</p>}
      </div>
    );
  }

  const w = data?.windows[win];
  const rec = data?.reconcile;
  const recOk = rec && rec.treasuryBalanceMrsn != null && Math.abs(rec.treasuryBalanceMrsn - rec.computedMrsn) <= Math.max(0.01, rec.computedMrsn * 0.001);
  const week = data?.change.week;
  const before = data?.change.weekBefore;

  return (
    <div className="page-shell space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Revenue</h1>
          <p className="page-sub">
            Internal. The protocol earns {data ? Math.round(data.split.treasury * 100) : 50}% of every base fee (the treasury); trading is free on the testnet.
            Fees are split by who paid them. Updated every minute.
          </p>
        </div>
        <button onClick={() => { keyStore.set(null); setData(null); }} className="text-xs text-dim hover:text-foreground shrink-0">Lock</button>
      </header>

      {error && <p className="text-xs text-red">{error}</p>}
      {!data ? <p className="text-sm text-dim">Loading…</p> : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS.map((k) => (
              <button key={k} onClick={() => setWin(k)} className={cn('px-3 py-1.5 rounded-lg text-xs border', win === k ? 'border-primary text-primary bg-primary/10' : 'border-border text-dim hover:text-foreground')}>
                {WINDOW_LABEL[k]}
              </button>
            ))}
            <span className="text-[11px] text-dim self-center ml-2">
              {win === '24h' ? 'rolling' : win === 'all' ? `since the fee switch (${data.since})` : 'UTC days, today so far'}
            </span>
          </div>

          {w && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-[11px] text-dim uppercase tracking-wider">Protocol revenue</p>
                <p className="mt-1 text-2xl font-mono font-semibold text-green">{mrsn(w.treasuryMrsn)} <span className="text-sm text-dim font-normal">MRSN</span></p>
                <p className="text-xs text-dim font-mono">≈ {usd(w.treasuryUsd)} at ${data.mrsnUsd?.toFixed(2) ?? '—'}</p>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-[11px] text-dim uppercase tracking-wider">Network fees</p>
                <p className="mt-1 text-2xl font-mono font-semibold">{mrsn(w.feesMrsn)} <span className="text-sm text-dim font-normal">MRSN</span></p>
                <p className="text-xs text-dim">{mrsn(w.proposersMrsn)} to proposers · {mrsn(w.burnedMrsn)} burned · {w.txs.toLocaleString('en-US')} txs</p>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-[11px] text-dim uppercase tracking-wider">Trading fees</p>
                <p className="mt-1 text-2xl font-mono font-semibold">0</p>
                <p className="text-xs text-dim">
                  Testnet. At the planned {(data.plannedTakerFee * 100).toFixed(3)}% taker fee users would pay {usd(w.byPayer.users.takerVolumeUsd * data.plannedTakerFee)}{' '}
                  ({usd(w.plannedTradingFeesUsd)} with our bots and flagged wallets)
                </p>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-[11px] text-dim uppercase tracking-wider">Insurance fund</p>
                <p className="mt-1 text-2xl font-mono font-semibold">{data.insurance ? mrsn(data.insurance.fundMrsn, 0) : '—'}</p>
                <p className="text-xs text-dim">Liquidation fees land here · bad debt {data.insurance ? mrsn(data.insurance.badDebtMrsn, 0) : '—'}</p>
              </div>
            </div>
          )}

          {w && (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border text-xs font-medium uppercase tracking-wider">Who pays · {WINDOW_LABEL[win]}</div>
              <div className="divide-y divide-border">
                {PAYERS.map((p) => {
                  const x = w.byPayer[p.key];
                  return (
                    <div key={p.key} className="grid grid-cols-2 md:grid-cols-[180px_1fr_120px_120px_140px] gap-x-4 gap-y-1 px-4 py-2.5 text-sm items-center">
                      <span className="flex items-center gap-2"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />{p.label}</span>
                      <span className="text-xs text-dim">{p.note}</span>
                      <span className="font-mono text-right">{mrsn(x.treasuryMrsn)} <span className="text-dim text-xs">MRSN</span></span>
                      <span className="font-mono text-right text-dim">{w.feesMrsn > 0 ? Math.round((x.feesMrsn / w.feesMrsn) * 100) : 0}%</span>
                      <span className="font-mono text-right text-dim text-xs">{usd(x.takerVolumeUsd)} taken</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="bg-surface border border-border rounded-xl p-4">
            <p className="text-xs font-medium uppercase tracking-wider mb-3">Fees per day, last 60 days</p>
            <DailyChart data={data.daily} events={data.events} />
          </div>

          {week && before && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-xs font-medium uppercase tracking-wider">What changed</p>
                <p className="text-[11px] text-dim mt-0.5">Last full week ({week.from} to {week.to}) against the one before</p>
                <p className="mt-2 text-sm">
                  Protocol revenue <span className="font-mono">{mrsn(week.treasuryMrsn)}</span> MRSN against <span className="font-mono">{mrsn(before.treasuryMrsn)}</span>:{' '}
                  <span className={cn('font-mono', week.treasuryMrsn >= before.treasuryMrsn ? 'text-green' : 'text-red')}>{pct(week.treasuryMrsn, before.treasuryMrsn)}</span>
                </p>
                <div className="mt-2 space-y-1">
                  {data.change.drivers.map((d) => (
                    <div key={d.payer} className="flex justify-between text-xs">
                      <span className="text-dim">{PAYERS.find((p) => p.key === d.payer)?.label}</span>
                      <span className="font-mono">{signed(d.deltaMrsn)} MRSN <span className="text-dim">({pct(d.treasuryMrsn, d.treasuryMrsnBefore)})</span></span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] text-dim">
                  Volume {usd(week.takerVolumeUsd)} against {usd(before.takerVolumeUsd)} ({pct(week.takerVolumeUsd, before.takerVolumeUsd)}).
                  The dollar figures also move with the MRSN price; the chart marks upgrades, incidents and notes.
                </p>
              </div>
              <div className="bg-surface border border-border rounded-xl p-4">
                <p className="text-xs font-medium uppercase tracking-wider">Largest payers, last 7 days</p>
                {data.topPayers.length === 0 ? (
                  <p className="text-xs text-dim mt-2">Being worked out; refresh in a minute.</p>
                ) : (
                  <div className="mt-2 space-y-1">
                    {data.topPayers.map((t) => (
                      <div key={t.address} className="grid grid-cols-[1fr_90px_110px_60px] gap-2 text-xs items-center">
                        <a href={`https://explorer.mersennet.com/address/${t.address}`} target="_blank" rel="noopener" className="font-mono text-primary hover:underline truncate">{shortenAddress(t.address, 6)}</a>
                        <span className="text-dim">{PAYERS.find((p) => p.key === t.payer)?.label}</span>
                        <span className="font-mono text-right">{mrsn(t.feesMrsn)} MRSN</span>
                        <span className="font-mono text-right text-dim">{pct(t.feesMrsn, t.feesMrsnBefore)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="bg-surface border border-border rounded-xl p-4">
            <p className="text-xs font-medium uppercase tracking-wider mb-2">Events</p>
            <div className="space-y-1">
              {[...data.events].reverse().slice(0, 15).map((e, i) => (
                <div key={i} className="flex gap-3 text-xs">
                  <span className="font-mono text-dim shrink-0">{e.at.slice(0, 10)}</span>
                  <span className={cn(e.kind === 'incident' && 'text-red')}>{e.label}</span>
                </div>
              ))}
            </div>
          </div>

          {rec && (
            <p className={cn('text-[11px]', recOk ? 'text-dim' : 'text-yellow')}>
              {recOk ? 'Checked:' : 'Does not reconcile:'} the treasury ({shortenAddress(data.treasury, 6)}) holds {rec.treasuryBalanceMrsn != null ? mrsn(rec.treasuryBalanceMrsn, 4) : '—'} MRSN;
              fees at the {data.baseFeeGwei} gwei floor give {mrsn(rec.computedMrsn, 4)}.
              {!recOk && ' The base fee rose above its floor or the treasury moved funds: the figures above undercount.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
