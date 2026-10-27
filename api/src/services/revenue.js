const { Pool } = require('pg');
const pool = require('../db/pool');
const explorer = require('../db/explorerPool');
const chain = require('./chain');
const upgrades = require('./upgrades');

// The daily job has a connection of its own: the shared explorer pool is often
// held by the adoption warmers, and its 5 s connect timeout kept failing the backfill.
const jobDb = new Pool({ connectionString: explorer.options.connectionString, max: 1, connectionTimeoutMillis: 120_000, idleTimeoutMillis: 60_000 });
jobDb.on('error', (e) => console.log('[revenue] job db:', e.message));

// Protocol revenue for the internal dashboard and the weekly ops summary.
//
// The treasury's income is its share of the base fee every block collects
// (from the fee switch); the rest of each fee goes to the proposer and is
// burned. The explorer's index has every transaction's gas, so fees are
// counted per day and per payer: our own wallets (bots, faucet), wallets we
// flagged (the ARB farm), and everyone else. The base fee has sat at its
// 1 gwei floor since the switch; `reconcile` compares the computed treasury
// income with the treasury's balance, which drifts apart if that changes.
const FEE_SWITCH_HEIGHT = 1_969_200;
const FEE_SWITCH_DAY = '2026-09-29';
const TREASURY = (process.env.FEE_TREASURY || '0xacACE2b290334e45f2db8Bd819BB4b6868477777').toLowerCase();
// Wallets we run that excluded_addresses does not list as bots.
const OPS_WALLETS = (process.env.OPS_WALLETS || '0xecef1bb56f77fad9ed34b2fb4300393ace974ee6')
  .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
// Trading is free on the testnet; the schedule planned for mainnet charges takers 0.035%.
const PLANNED_TAKER_FEE = 0.00035;
const PAYERS = ['users', 'flagged', 'ours'];
const DAY_S = 86_400;
const REFRESH_MS = 5 * 60_000;

let timer = null;
let topCache = { at: 0, value: null, running: false };

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS revenue_daily (
    day date NOT NULL, payer text NOT NULL, gas numeric NOT NULL, txs bigint NOT NULL,
    taker_volume_usd double precision NOT NULL DEFAULT 0, closed boolean NOT NULL DEFAULT false,
    updated_at timestamptz DEFAULT now(), PRIMARY KEY (day, payer))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ops_events (
    id serial PRIMARY KEY, at timestamptz NOT NULL, label text NOT NULL, kind text NOT NULL DEFAULT 'note')`);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ops_events');
  if (rows[0].n === 0) {
    await pool.query(`INSERT INTO ops_events (at, label, kind) VALUES
      ('2026-10-14T20:11:00Z', 'Public RPC node down (faucet, WebSocket) until 16 Oct 06:20 UTC', 'incident'),
      ('2026-10-21T00:00:00Z', 'ARB wash-trading farm flagged (50 wallets)', 'note'),
      ('2026-10-27T00:00:00Z', 'Insurance fund seeded with 500,000 MRSN', 'note')`);
  }
}

async function payerSets() {
  const { rows } = await pool.query('SELECT lower(address) AS address, reason FROM excluded_addresses');
  const ours = new Set(OPS_WALLETS);
  const flagged = new Set();
  for (const r of rows) (/^bot/i.test(r.reason || '') ? ours : flagged).add(r.address);
  return { ours: [...ours], flagged: [...flagged] };
}

const PAYER_SQL = (col) => `CASE WHEN ${col} = ANY($3) THEN 'ours' WHEN ${col} = ANY($4) THEN 'flagged' ELSE 'users' END`;

/** Gas, transactions and taker volume per payer between two unix times. */
async function aggregate(start, end, sets, db = explorer) {
  const [{ rows: fees }, { rows: vol }] = await Promise.all([
    db.query(
      `SELECT ${PAYER_SQL('from_addr')} AS payer, COALESCE(SUM(gas_used), 0)::text AS gas, COUNT(*)::bigint AS txs
         FROM transactions WHERE timestamp >= $1 AND timestamp < $2 AND block_number >= ${FEE_SWITCH_HEIGHT}
        GROUP BY 1`,
      [start, end, sets.ours, sets.flagged],
    ),
    pool.query(
      `SELECT ${PAYER_SQL('lower(taker)')} AS payer,
              COALESCE(SUM(${chain.notionalSql('trades')}), 0)::float8 AS usd
         FROM trades WHERE block_timestamp >= to_timestamp($1) AND block_timestamp < to_timestamp($2)
        GROUP BY 1`,
      [start, end, sets.ours, sets.flagged],
    ),
  ]);
  return Object.fromEntries(PAYERS.map((p) => {
    const f = fees.find((r) => r.payer === p);
    const v = vol.find((r) => r.payer === p);
    return [p, { gas: f ? BigInt(f.gas) : 0n, txs: f ? Number(f.txs) : 0, takerVolumeUsd: v ? Number(v.usd) : 0 }];
  }));
}

async function storeDay(day, sets, closed) {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  const w = await aggregate(start, start + DAY_S, sets, jobDb);
  for (const p of PAYERS) {
    await pool.query(
      `INSERT INTO revenue_daily (day, payer, gas, txs, taker_volume_usd, closed, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (day, payer) DO UPDATE SET gas = $3, txs = $4, taker_volume_usd = $5, closed = $6, updated_at = now()`,
      [day, p, w[p].gas.toString(), w[p].txs, w[p].takerVolumeUsd, closed],
    );
  }
}

const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_S * 1000).toISOString().slice(0, 10);

async function refresh() {
  const sets = await payerSets();
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM revenue_daily WHERE closed GROUP BY 1 HAVING COUNT(*) = ${PAYERS.length}`,
  );
  const done = new Set(rows.map((r) => r.day));
  for (let d = FEE_SWITCH_DAY; d < today; d = nextDay(d)) {
    if (!done.has(d)) await storeDay(d, sets, true);
  }
  await storeDay(today, sets, false);
}

function start() {
  if (timer) return;
  init()
    .then(() => {
      const run = () => refresh().catch((e) => console.log('[revenue]', e.message));
      // After the startup cache warmers, which hold the explorer connections for a while.
      setTimeout(run, 120_000).unref();
      timer = setInterval(run, REFRESH_MS);
    })
    .catch((e) => console.log('[revenue] init:', e.message));
}

/**
 * The 10 largest fee payers of the last 7 days, with the 7 before. The scan
 * takes several seconds, so a request gets the last result (empty at first)
 * and an hourly refresh runs behind it.
 */
function topPayers(sets) {
  if ((!topCache.value || Date.now() - topCache.at > 3600_000) && !topCache.running) {
    topCache.running = true;
    computeTopPayers(sets)
      .then((value) => { topCache = { at: Date.now(), value }; })
      .catch((e) => { console.log('[revenue] top payers:', e.message); topCache.running = false; });
  }
  return topCache.value || [];
}

async function computeTopPayers(sets) {
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await jobDb.query(
    `SELECT from_addr AS address, ${PAYER_SQL('from_addr')} AS payer,
            COALESCE(SUM(gas_used) FILTER (WHERE timestamp >= $1 + ${7 * DAY_S}), 0)::text AS gas,
            COALESCE(SUM(gas_used) FILTER (WHERE timestamp < $1 + ${7 * DAY_S}), 0)::text AS gas_before
       FROM transactions WHERE timestamp >= $1 AND timestamp < $2
      GROUP BY 1, 2 ORDER BY SUM(gas_used) FILTER (WHERE timestamp >= $1 + ${7 * DAY_S}) DESC NULLS LAST LIMIT 10`,
    [now - 14 * DAY_S, now, sets.ours, sets.flagged],
  );
  return rows.map((r) => ({ address: r.address, payer: r.payer, gas: BigInt(r.gas), gasBefore: BigInt(r.gas_before) }));
}

async function report() {
  const sets = await payerSets();
  const now = Math.floor(Date.now() / 1000);
  const top = topPayers(sets);
  const [{ rows: days }, live, protocol, treasuryWei, price, upg, { rows: notes }, owed] = await Promise.all([
    pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, payer, gas::text AS gas, txs, taker_volume_usd, closed
         FROM revenue_daily ORDER BY day`,
    ),
    aggregate(now - DAY_S, now + 60, sets),
    chain.getProtocol().catch(() => null),
    chain.getBalance(TREASURY).catch(() => null),
    chain.getMarkPrice(1).then((p) => chain.toHumanPrice(1, p) || null).catch(() => null),
    upgrades.report().catch(() => ({ completed: [] })),
    pool.query('SELECT at, label, kind FROM ops_events ORDER BY at'),
    // What the treasury owes delegators for the reward split (nodeRewards.js), not paid yet.
    pool.query(
      `SELECT COALESCE(SUM(owed_mrsn), 0)::float8 AS mrsn, COUNT(DISTINCT delegator)::int AS delegators, MIN(epoch) AS since_epoch
         FROM delegator_shortfall WHERE paid_tx IS NULL`,
    ).then((r) => r.rows[0]).catch(() => null),
  ]);

  const baseFeeWei = BigInt(protocol?.fees?.minBaseFeeWei || 1_000_000_000);
  const treasuryShare = (protocol?.fees?.treasuryBps ?? 5000) / 10_000;
  const proposerShare = (protocol?.fees?.proposerBps ?? 2500) / 10_000;
  const mrsnOf = (gas) => Number((gas * baseFeeWei) / 10n ** 12n) / 1e6;

  const summarize = (byPayer) => {
    const out = { byPayer: {}, feesMrsn: 0, treasuryMrsn: 0, proposersMrsn: 0, burnedMrsn: 0, txs: 0, takerVolumeUsd: 0 };
    for (const p of PAYERS) {
      const x = byPayer[p] || { gas: 0n, txs: 0, takerVolumeUsd: 0 };
      const fees = mrsnOf(x.gas);
      out.byPayer[p] = { feesMrsn: fees, treasuryMrsn: fees * treasuryShare, txs: x.txs, takerVolumeUsd: x.takerVolumeUsd };
      out.feesMrsn += fees;
      out.txs += x.txs;
      out.takerVolumeUsd += x.takerVolumeUsd;
    }
    out.treasuryMrsn = out.feesMrsn * treasuryShare;
    out.proposersMrsn = out.feesMrsn * proposerShare;
    out.burnedMrsn = out.feesMrsn - out.treasuryMrsn - out.proposersMrsn;
    out.treasuryUsd = price ? out.treasuryMrsn * price : null;
    out.plannedTradingFeesUsd = out.takerVolumeUsd * PLANNED_TAKER_FEE;
    return out;
  };

  const byDay = new Map();
  for (const r of days) {
    if (!byDay.has(r.day)) byDay.set(r.day, { closed: r.closed });
    byDay.get(r.day)[r.payer] = { gas: BigInt(r.gas), txs: Number(r.txs), takerVolumeUsd: Number(r.taker_volume_usd) };
  }
  const dayList = [...byDay.keys()].sort();
  const sumDays = (list) => {
    const acc = Object.fromEntries(PAYERS.map((p) => [p, { gas: 0n, txs: 0, takerVolumeUsd: 0 }]));
    for (const d of list) for (const p of PAYERS) {
      const x = byDay.get(d)[p];
      if (!x) continue;
      acc[p].gas += x.gas;
      acc[p].txs += x.txs;
      acc[p].takerVolumeUsd += x.takerVolumeUsd;
    }
    return acc;
  };
  const lastDays = (n) => dayList.slice(-n);

  const closedDays = dayList.filter((d) => byDay.get(d).closed);
  const week = sumDays(closedDays.slice(-7));
  const weekBefore = sumDays(closedDays.slice(-14, -7));
  const weekSummary = summarize(week);
  const beforeSummary = summarize(weekBefore);
  const drivers = PAYERS.map((p) => ({
    payer: p,
    treasuryMrsn: weekSummary.byPayer[p].treasuryMrsn,
    treasuryMrsnBefore: beforeSummary.byPayer[p].treasuryMrsn,
    deltaMrsn: weekSummary.byPayer[p].treasuryMrsn - beforeSummary.byPayer[p].treasuryMrsn,
  })).sort((a, b) => Math.abs(b.deltaMrsn) - Math.abs(a.deltaMrsn));

  const all = summarize(sumDays(dayList));
  const events = [
    ...(upg.completed || [])
      .filter((u) => u.activatedAt)
      .map((u) => ({ at: u.activatedAt, label: `Upgrade: ${u.label} (block ${Number(u.height).toLocaleString('en-US')})`, kind: 'upgrade' })),
    ...notes.map((n) => ({ at: new Date(n.at).toISOString(), label: n.label, kind: n.kind })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    generatedAt: new Date().toISOString(),
    mrsnUsd: price,
    baseFeeGwei: Number(baseFeeWei) / 1e9,
    split: { treasury: treasuryShare, proposers: proposerShare, burned: 1 - treasuryShare - proposerShare },
    plannedTakerFee: PLANNED_TAKER_FEE,
    treasury: TREASURY,
    reconcile: {
      treasuryBalanceMrsn: treasuryWei != null ? Number(BigInt(treasuryWei) / 10n ** 12n) / 1e6 : null,
      computedMrsn: all.treasuryMrsn,
    },
    insurance: protocol ? { fundMrsn: Number(protocol.insuranceFund ?? 0), badDebtMrsn: Number(protocol.badDebt ?? 0) } : null,
    delegatorShortfall: owed ? { owedMrsn: owed.mrsn, delegators: owed.delegators, sinceEpoch: owed.since_epoch != null ? Number(owed.since_epoch) : null } : null,
    windows: {
      '24h': summarize(live),
      '7d': summarize(sumDays(lastDays(7))),
      '30d': summarize(sumDays(lastDays(30))),
      '1y': summarize(sumDays(lastDays(365))),
      all,
    },
    change: {
      week: { from: closedDays.slice(-7)[0] || null, to: closedDays.slice(-1)[0] || null, ...weekSummary },
      weekBefore: { from: closedDays.slice(-14, -7)[0] || null, to: closedDays.slice(-8, -7)[0] || null, ...beforeSummary },
      drivers,
    },
    topPayers: top.map((t) => ({
      address: t.address, payer: t.payer, feesMrsn: mrsnOf(t.gas), feesMrsnBefore: mrsnOf(t.gasBefore),
    })),
    daily: dayList.map((d) => ({
      day: d,
      closed: byDay.get(d).closed,
      feesMrsn: Object.fromEntries(PAYERS.map((p) => [p, mrsnOf(byDay.get(d)[p]?.gas ?? 0n)])),
      takerVolumeUsd: Object.fromEntries(PAYERS.map((p) => [p, byDay.get(d)[p]?.takerVolumeUsd ?? 0])),
    })),
    events,
    since: FEE_SWITCH_DAY,
  };
}

module.exports = { start, report };
