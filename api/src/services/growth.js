/**
 * Growth for the ops digests: wallets that appear for the first time each
 * day, and the last full week (Monday to Sunday, UTC) against the one before.
 *
 * New = first appearance: first transaction sent and first faucet payment
 * received (explorer index), first delegation (staking precompile), first
 * trade on either side (trade DB). Bots, the vault and excluded wallets
 * (excluded_addresses) are left out. Community sizes are recorded once a day
 * (growth_community) so the week can be compared with the one before.
 */
const { ethers } = require('ethers');
const pool = require('../db/pool');
const explorer = require('../db/explorerPool');
const chain = require('./chain');

const FAUCET = (process.env.FAUCET_ADDRESS || '0xecef1bb56f77fad9ed34b2fb4300393ace974ee6').toLowerCase();
const STAKING = '0x0000000000000000000000000000000000000400';
const DELEGATE = ethers.id('delegate(address,uint256)').slice(0, 10);
const DISCORD_INVITE = process.env.DISCORD_INVITE_CODE || 'aJSQ63PUes';
const DAY = 86_400_000;

async function excluded() {
  const r = await pool.query('SELECT LOWER(address) AS a FROM excluded_addresses');
  return r.rows.map((x) => x.a);
}

/** { 'YYYY-MM-DD': n } of first appearances since `sinceSec` (unix seconds). */
async function firstsPerDay(sql, params) {
  const r = await explorer.query(sql, params);
  return Object.fromEntries(r.rows.map((x) => [x.day, Number(x.n)]));
}

async function discordMembers() {
  try {
    const r = await fetch(`https://discord.com/api/v10/invites/${DISCORD_INVITE}?with_counts=true`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return Number.isFinite(j.approximate_member_count) ? j.approximate_member_count : null;
  } catch { return null; }
}

async function recordCommunity(telegram) {
  await pool.query(`CREATE TABLE IF NOT EXISTS growth_community (
    day DATE PRIMARY KEY, telegram INT, discord INT, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const discord = await discordMembers();
  await pool.query(
    `INSERT INTO growth_community (day, telegram, discord) VALUES (CURRENT_DATE, $1, $2)
     ON CONFLICT (day) DO UPDATE SET telegram = COALESCE(EXCLUDED.telegram, growth_community.telegram),
       discord = COALESCE(EXCLUDED.discord, growth_community.discord), recorded_at = NOW()`,
    [telegram, discord]);
  const r = await pool.query(
    `SELECT day::text, telegram, discord FROM growth_community WHERE day IN (CURRENT_DATE, CURRENT_DATE - 7)`);
  const by = Object.fromEntries(r.rows.map((x) => [x.day.slice(0, 10), x]));
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  return {
    telegram: by[today]?.telegram ?? telegram, discord: by[today]?.discord ?? discord,
    telegramWeekAgo: by[weekAgo]?.telegram ?? null, discordWeekAgo: by[weekAgo]?.discord ?? null,
  };
}

/** Human trading in [from, to): active traders, their volume, and who traded. */
async function tradingBetween(from, to, bots) {
  const ps = chain.priceScaleSql('t.market_id');
  const r = await pool.query(
    `WITH t AS (SELECT LOWER(taker) AS taker, LOWER(maker) AS maker, (price * size / ${ps})::float8 AS notional
                  FROM trades t WHERE block_timestamp >= $1 AND block_timestamp < $2)
     SELECT a, SUM(v)::float8 AS volume FROM (
       SELECT taker AS a, notional AS v FROM t WHERE NOT (taker = ANY($3) AND maker = ANY($3))
       UNION ALL
       SELECT maker AS a, 0 AS v FROM t WHERE NOT (taker = ANY($3) AND maker = ANY($3))
     ) s WHERE a <> ALL($3) GROUP BY a`,
    [new Date(from), new Date(to), bots]);
  return { traders: new Set(r.rows.map((x) => x.a)), volume: r.rows.reduce((s, x) => s + Number(x.volume), 0) };
}

/**
 * `days` of first appearances, and the last full week against the one before.
 * `telegram` is the current member count (the adoption service already asks).
 */
async function growth(days = 14, telegram = null) {
  const shown = days;
  days = Math.max(days, 21); // the week before last can start 20 days back
  const bots = await excluded();
  const now = Date.now();
  const sinceSec = Math.floor((now - days * DAY) / 1000);
  const [senders, funded, delegators, traders] = await Promise.all([
    firstsPerDay(`SELECT to_char(to_timestamp(t)::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM (
        SELECT LOWER(from_addr) AS a, MIN(timestamp) AS t FROM transactions GROUP BY 1) f
      WHERE t >= $1 AND a <> ALL($2) GROUP BY 1`, [sinceSec, bots]),
    firstsPerDay(`SELECT to_char(to_timestamp(t)::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM (
        SELECT LOWER(to_addr) AS a, MIN(timestamp) AS t FROM transactions WHERE LOWER(from_addr) = $3 GROUP BY 1) f
      WHERE t >= $1 AND a <> ALL($2) GROUP BY 1`, [sinceSec, bots, FAUCET]),
    firstsPerDay(`SELECT to_char(to_timestamp(t)::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM (
        SELECT LOWER(from_addr) AS a, MIN(timestamp) AS t FROM transactions
         WHERE LOWER(to_addr) = $3 AND LEFT(LOWER(method_id), 10) = $4 AND status = 1 GROUP BY 1) f
      WHERE t >= $1 AND a <> ALL($2) GROUP BY 1`, [sinceSec, bots, STAKING, DELEGATE]),
    pool.query(`SELECT to_char(f::date, 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM (
        SELECT a, MIN(at) AS f FROM (SELECT LOWER(taker) AS a, block_timestamp AS at FROM trades
                                     UNION ALL SELECT LOWER(maker), block_timestamp FROM trades) w
         WHERE a <> ALL($2) GROUP BY a) x
      WHERE f >= $1 GROUP BY 1`, [new Date(now - days * DAY), bots])
      .then((r) => Object.fromEntries(r.rows.map((x) => [x.day, Number(x.n)]))),
  ]);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    series.push({ day, newSenders: senders[day] || 0, newFunded: funded[day] || 0, newDelegators: delegators[day] || 0, newTraders: traders[day] || 0 });
  }

  // Last full week, Monday 00:00 UTC to Monday 00:00 UTC, and the one before.
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const weekEnd = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  const weeks = {};
  for (const [name, end] of [['last', weekEnd], ['before', weekEnd - 7 * DAY]]) {
    const start = end - 7 * DAY;
    const inWeek = series.filter((d) => Date.parse(d.day) >= start && Date.parse(d.day) < end);
    const sum = (k) => inWeek.reduce((s, d) => s + d[k], 0);
    const t = await tradingBetween(start, end, bots);
    weeks[name] = {
      start: new Date(start).toISOString().slice(0, 10), end: new Date(end - DAY).toISOString().slice(0, 10),
      complete: inWeek.length === 7,
      newSenders: sum('newSenders'), newFunded: sum('newFunded'), newDelegators: sum('newDelegators'), newTraders: sum('newTraders'),
      activeTraders: t.traders.size, humanVolume: t.volume, traders: t.traders,
    };
  }
  const returning = [...weeks.last.traders].filter((a) => weeks.before.traders.has(a)).length;
  for (const w of Object.values(weeks)) delete w.traders;
  const community = await recordCommunity(telegram).catch(() => ({}));
  return { generatedAt: new Date(now).toISOString(), days: series.slice(-shown), weeks: { ...weeks, returningTraders: returning }, community };
}

module.exports = { growth };
