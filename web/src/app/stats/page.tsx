'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdoptionStats } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Public adoption dashboard. Every number comes from /api/v1/stats/adoption —
 * the same feed the ops digest reads — so what the community sees is what we
 * see. Bots are stated, not hidden: the network runs its own market maker,
 * takers and liquidator, and their share is shown next to the human figure.
 */
export default function StatsPage() {
  const [d, setD] = useState<AdoptionStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.getAdoption().then((r) => { if (alive) { setD(r); setErr(null); } }).catch((e) => { if (alive) setErr((e as Error).message); });
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const n = (v: number | null | undefined, dp = 0) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: dp }));
  // Millions read as "5.04M MRSN" so the tile never truncates; below that, full digits.
  const mrsn = (v: number | null | undefined) => (v == null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M MRSN` : `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} MRSN`);
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
  const usd = (v: number | null | undefined) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

  const v = d?.network.validators;
  const share = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const humanShare24h = d && d.trading.trades24h ? (d.trading.humanTrades24h ?? 0) / d.trading.trades24h : null;

  return (
    <div className="page-shell space-y-6" data-testid="stats-page">
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="page-title">Network stats</h1>
          <span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[9px] font-semibold uppercase tracking-wider">Public testnet · live</span>
        </div>
        <p className="page-sub">
          Adoption and activity on the Mersennet testnet, from the chain and the terminal&apos;s own database.
          {/* Rendered before the data too: appended later, it wrapped the line and moved the page. */}
          {' '}Updated {d ? new Date(d.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '--:--'} UTC, refreshes every five minutes.
        </p>
      </header>

      {err && !d && <p className="text-sm text-red">Could not load the numbers ({err}) — retrying.</p>}

      {/* Adoption */}
      <Section title="People" sub="Wallets are addresses; the network's own bots (market maker, takers, liquidator) are excluded where the source can tell them apart.">
        <Tile label="Faucet-funded wallets" value={n(d?.wallets.fundedByFaucet)} hint="unique addresses that ever received a drip" />
        <Tile label="Human traders" value={n(d?.wallets.humanTradersTotal)} lines={[['last 7 days', n(d?.wallets.humanTraders7d)], ['today', n(d?.wallets.humanTraders24h)]]} />
        <Tile label="Active addresses · 24 h" value={n(d?.wallets.activeSenders24h)} lines={[['7 days', n(d?.wallets.activeSenders7d)], ['30 days', n(d?.wallets.activeSenders30d)]]} hint="bots included" />
        <Tile label="Maker vault depositors" value={n(d?.wallets.vaultDepositors)} hint="wallets holding vault shares" />
        <Tile label="Points holders" value={n(d?.wallets.pointsHolders)} lines={[['referrals', <Link key="referrals" href="/referrals" className="text-primary hover:underline">{n(d?.wallets.referrals)}</Link>]]} />
        <Tile label="Telegram members" value={n(d?.community.telegramMembers)} lines={d?.community.github ? [['GitHub repos', n(d.community.github.repos)], ['GitHub stars', n(d.community.github.stars)]] : [['GitHub', '—']]} />
      </Section>

      {/* Trading */}
      <Section title="Trading" sub="Volume in USD-quoted notional. A fill counts as human when either side is not a bot.">
        <Tile label="Trades · 24 h" value={n(d?.trading.trades24h)} lines={[
          ['human', `${n(d?.trading.humanTrades24h)} (${share(humanShare24h)})`],
          ['bots', `${n(d ? (d.trading.trades24h ?? 0) - (d.trading.humanTrades24h ?? 0) : null)} (${share(humanShare24h == null ? null : 1 - humanShare24h)})`],
        ]} />
        <Tile label="Volume · 24 h" value={usd(d?.trading.volume24h)} lines={[['human', usd(d?.trading.humanVolume24h)]]} />
        <Tile label="Trades · 7 d" value={n(d?.trading.trades7d)} lines={[['human', n(d?.trading.humanTrades7d)], ['volume', usd(d?.trading.volume7d)]]} />
        <Tile label="Trades · all time" value={n(d?.trading.tradesTotal)} lines={[['human', n(d?.trading.humanTradesTotal)], ['volume', usd(d?.trading.volumeTotal)]]} />
        <Tile label="Markets" value={n(d?.trading.markets)} hint="perpetuals on the native order book" />
        <Tile label="Bot wallets" value={n(d?.wallets.botWallets)} hint="market maker, takers, liquidator — the network's own" />
      </Section>

      {/* TVL */}
      <Section title="Value on the network" sub="Testnet MRSN has no monetary value; these are balances, not dollars.">
        <Tile label="Order-book collateral" value={mrsn(d?.tvl.orderBookCollateralMrsn)} lines={[['funded accounts', n(d?.tvl.orderBookAccounts)]]} hint="native MRSN, plus token collateral at its margin weight" />
        <Tile label="Maker vault" value={mrsn(d?.tvl.makerVaultNavMrsn)} hint="net asset value" />
        <Tile label="Staked" value={mrsn(d?.tvl.stakedMrsn)} lines={[['delegated', mrsn(v?.delegatedMrsn)]]} />
        <Tile label="Total" value={mrsn(d?.tvl.totalMrsn)} hint="collateral + vault + stake" accent />
      </Section>

      {/* Network */}
      <Section title="Network" sub={<>Validators from the chain, as listed on the <Link href="/staking" className="text-primary hover:underline">staking page</Link>; transactions from the <a href="https://explorer.mersennet.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">explorer</a>; uptime from the <a href="https://status.mersennet.com/status/mersennet" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">status page</a>.</>}>
        <Tile label="Validators" value={n(v?.registered)} lines={v ? [
          ['genesis', n(v.genesis ?? v.registered - v.community)],
          ['community-run', n(v.community)],
          ['epoch', `${n(v.epoch)} (every 60 m)`],
        ] : undefined} />
        <Tile label="Node status" value={v ? `${n(v.active)} / ${n(v.registered)}` : '—'} unit="active" lines={v ? nodeStatusLines(v, d?.network) : undefined} />
        <Tile label="Transactions" value={n(d?.network.tx24h)} unit="24 h" lines={[['since genesis', n(d?.network.txTotal)], ['contracts deployed', n(d?.network.contractsDeployed)]]} />
        <Tile label="Block time" value={d?.network.blockTimeSec == null ? '—' : `${d.network.blockTimeSec.toFixed(2)} s`} lines={[['block height', n(d?.network.height)]]} />
        <Tile label="Uptime · 24 h" value={pct(d?.network.uptime?.avg24h)} lines={[['public monitors', n(d?.network.uptime?.monitors)]]} />
      </Section>

      {/* 30-day bars */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Bars title="Human traders per day" sub="distinct wallets that traded, last 30 days" data={(d?.daily ?? []).map((x) => ({ day: x.day, v: x.humanTraders }))} />
        <Bars title="Wallets funded per day" sub="first drips to new addresses, last 30 days" data={(d?.wallets.fundedPerDay ?? []).map((x) => ({ day: x.day, v: x.wallets }))} />
      </div>

      <p className="text-[11px] text-dim leading-relaxed">
        {d?.note} Raw feed: <code className="font-mono text-foreground/80">/api/v1/stats/adoption</code>. Methodology and program rules:{' '}
        <a href="https://docs.mersennet.com/resources/testnet-policies/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Testnet Policies</a>.
        Live health: <a href="https://status.mersennet.com/status/mersennet" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">status.mersennet.com</a> ·{' '}
        <Link href="/leaderboard" className="text-primary hover:underline">leaderboard</Link> · <Link href="/staking" className="text-primary hover:underline">validators</Link>.
      </p>
    </div>
  );
}

type Validators = NonNullable<AdoptionStats['network']['validators']>;

/** Every registered validator by state (benched ones are still in the active set), then nodes nobody registered. */
function nodeStatusLines(v: Validators, net: AdoptionStats['network'] | undefined): [string, React.ReactNode][] {
  const fmt = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('en-US'));
  const st = v.statuses ?? {};
  const benched = v.benched ?? 0;
  const lines: [string, React.ReactNode][] = [
    ['active', fmt(v.active == null ? null : v.active - benched)],
    ['active (benched)', fmt(benched)],
    ['jailed', fmt(v.jailed)],
  ];
  for (const s of ['standby', 'pending', 'exiting']) if (st[s]) lines.push([s, fmt(st[s])]);
  if (v.unregisteredNodesOnline != null) lines.push(['unregistered', fmt(v.unregisteredNodesOnline)]);
  if (net) lines.push(['verified online', `${fmt(net.verifiedNodesOnline)} / ${fmt(net.verifiedNodes)}`]);
  return lines;
}

function Section({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">{title}</h2>
        {sub && <p className="text-[11px] text-dim mt-0.5">{sub}</p>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">{children}</div>
    </section>
  );
}

/** A headline number; `lines` are "label: value" pairs, one per line; `hint` is a plain note under them. */
function Tile({ label, value, unit, lines, hint, accent }: {
  label: string; value: string; unit?: string; lines?: [string, React.ReactNode][]; hint?: string; accent?: boolean;
}) {
  return (
    <div className={cn('bg-surface border rounded-xl px-3.5 py-3 min-w-0', accent ? 'border-primary/30' : 'border-border')}>
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium mb-1.5 truncate" title={label}>{label}</p>
      <p className={cn('text-[18px] font-mono font-semibold tabular-nums leading-none truncate', accent ? 'text-primary' : 'text-foreground')} title={unit ? `${value} ${unit}` : value}>
        {value}{unit && <span className="ml-1 text-[10px] font-sans font-medium text-dim">{unit}</span>}
      </p>
      {lines && lines.length > 0 && (
        <div className="mt-1.5 space-y-px">
          {lines.map(([k, val]) => (
            <p key={k} className="text-[10px] text-dim leading-snug">{k}: <span className="font-mono tabular-nums text-foreground/80">{val}</span></p>
          ))}
        </div>
      )}
      {hint && <p className="text-[10px] text-dim mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

/** Tiny dependency-free bar chart: 30 bars, hover shows the day's value. */
function Bars({ title, sub, data }: { title: string; sub: string; data: { day: string; v: number }[] }) {
  const max = Math.max(1, ...data.map((x) => x.v));
  const w = 600, h = 120, pad = 2;
  const bw = data.length ? (w - pad * (data.length - 1)) / data.length : w;
  return (
    <div className="bg-surface border border-border rounded-xl px-3.5 py-3">
      <p className="text-[10px] text-dim uppercase tracking-wider font-medium">{title}</p>
      <p className="text-[10px] text-dim mb-2">{sub} · peak {max.toLocaleString()}</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[120px]" role="img" aria-label={title}>
        {data.map((x, i) => {
          const bh = Math.max(x.v > 0 ? 2 : 0, (x.v / max) * (h - 14));
          return (
            <g key={x.day}>
              <rect x={i * (bw + pad)} y={h - 14 - bh} width={bw} height={bh} rx={1.5} className={x.v > 0 ? 'fill-primary/70' : 'fill-surface-2'} />
              <title>{x.day}: {x.v.toLocaleString()}</title>
            </g>
          );
        })}
        {data.length > 0 && (
          <>
            <text x={0} y={h - 2} className="fill-current text-dim" style={{ fontSize: 10 }}>{data[0].day.slice(5)}</text>
            <text x={w} y={h - 2} textAnchor="end" className="fill-current text-dim" style={{ fontSize: 10 }}>{data[data.length - 1].day.slice(5)}</text>
          </>
        )}
      </svg>
    </div>
  );
}
