const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');
const { sendError } = require('../middleware/httpError');

const router = Router();

// Launch dashboard: humans vs bots, per UTC day. Bots are the addresses the
// indexer lists in `excluded_addresses`; a fill counts as human when either
// side is not a bot. Network counters come from `daily_metrics` (cumulative
// snapshots written by the indexer) and are turned into per-day deltas here.
// One query set per minute, shared across callers.
const TTL_MS = 60_000;
let cache = { at: 0, days: 0, body: null, inflight: null };

async function compute(days) {
  const ps = chain.priceScaleSql('t.market_id');
  const [trading, firsts, metrics, totals] = await Promise.all([
    pool.query(`
      WITH bots AS (SELECT address FROM excluded_addresses),
      t AS (
        SELECT date_trunc('day', t.block_timestamp)::date AS day,
               (t.taker IN (SELECT address FROM bots) AND t.maker IN (SELECT address FROM bots)) AS bot,
               t.taker, t.maker, (t.price * t.size / ${ps})::float8 AS notional
        FROM trades t
        WHERE t.block_timestamp >= (CURRENT_DATE - ($1::int - 1) * interval '1 day')
      )
      SELECT day,
             COUNT(*) FILTER (WHERE NOT bot)::int AS human_trades,
             COALESCE(SUM(notional) FILTER (WHERE NOT bot), 0)::float8 AS human_volume,
             COUNT(DISTINCT taker) FILTER (WHERE NOT bot AND taker NOT IN (SELECT address FROM bots))::int AS human_traders,
             COUNT(*) FILTER (WHERE bot)::int AS bot_trades,
             COALESCE(SUM(notional) FILTER (WHERE bot), 0)::float8 AS bot_volume
      FROM t GROUP BY day ORDER BY day`, [days]),
    pool.query(`
      WITH bots AS (SELECT address FROM excluded_addresses),
      first_trade AS (
        SELECT taker AS wallet, MIN(block_timestamp) AS first_at FROM trades
        WHERE taker NOT IN (SELECT address FROM bots) GROUP BY taker
      )
      SELECT date_trunc('day', first_at)::date AS day, COUNT(*)::int AS new_traders
      FROM first_trade
      WHERE first_at >= (CURRENT_DATE - ($1::int - 1) * interval '1 day')
      GROUP BY day ORDER BY day`, [days]),
    pool.query(`
      SELECT day, faucet_txs, verified_nodes, validators, block_height,
             faucet_txs - LAG(faucet_txs) OVER (ORDER BY day) AS faucet_delta,
             block_height - LAG(block_height) OVER (ORDER BY day) AS blocks_delta
      FROM daily_metrics
      WHERE day >= (CURRENT_DATE - $1::int * interval '1 day')
      ORDER BY day`, [days]).catch(() => ({ rows: [] })),
    pool.query(`
      WITH bots AS (SELECT address FROM excluded_addresses)
      SELECT
        (SELECT COUNT(DISTINCT taker) FROM trades WHERE taker NOT IN (SELECT address FROM bots))::int AS human_traders_total,
        (SELECT COUNT(*) FROM trades WHERE NOT (taker IN (SELECT address FROM bots) AND maker IN (SELECT address FROM bots)))::int AS human_trades_total,
        (SELECT COUNT(*) FROM trades)::int AS trades_total,
        (SELECT COUNT(*) FROM verified_nodes WHERE consecutive_failures < 3)::int AS verified_nodes,
        (SELECT COUNT(*) FROM points_balance WHERE total_points > 0 AND address NOT IN (SELECT address FROM bots))::int AS points_holders,
        (SELECT COUNT(*) FROM referrals)::int AS referrals`).catch(() => ({ rows: [{}] })),
  ]);
  const byDay = new Map();
  const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(d, { day: d, humanTrades: 0, humanVolume: 0, humanTraders: 0, botTrades: 0, botVolume: 0, newTraders: 0, faucetTxs: null, blocks: null, verifiedNodes: null, validators: null });
  }
  for (const r of trading.rows) {
    const row = byDay.get(dayKey(r.day)); if (!row) continue;
    Object.assign(row, { humanTrades: r.human_trades, humanVolume: Number(r.human_volume), humanTraders: r.human_traders, botTrades: r.bot_trades, botVolume: Number(r.bot_volume) });
  }
  for (const r of firsts.rows) { const row = byDay.get(dayKey(r.day)); if (row) row.newTraders = r.new_traders; }
  for (const r of metrics.rows) {
    const row = byDay.get(dayKey(r.day)); if (!row) continue;
    row.faucetTxs = r.faucet_delta == null ? null : Number(r.faucet_delta);
    row.blocks = r.blocks_delta == null ? null : Number(r.blocks_delta);
    row.verifiedNodes = r.verified_nodes == null ? null : Number(r.verified_nodes);
    row.validators = r.validators == null ? null : Number(r.validators);
  }
  const latest = metrics.rows[metrics.rows.length - 1] || {};
  return {
    generatedAt: new Date().toISOString(),
    days: [...byDay.values()],
    totals: {
      ...totals.rows[0],
      validators: latest.validators == null ? null : Number(latest.validators),
      faucetTxs: latest.faucet_txs == null ? null : Number(latest.faucet_txs),
      blockHeight: latest.block_height == null ? null : Number(latest.block_height),
    },
    note: 'A fill is "bot" when both sides are market-making bots; volume in quote units (price × size ÷ priceScale). Faucet = transactions sent by the faucet wallet (drips and token claims).',
  };
}

router.get('/', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  try {
    const now = Date.now();
    if (cache.body && cache.days === days && now - cache.at < TTL_MS) return res.json(cache.body);
    if (!cache.inflight || cache.days !== days) {
      cache.days = days;
      cache.inflight = compute(days)
        .then((body) => { cache = { at: Date.now(), days, body, inflight: null }; return body; })
        .catch((e) => { cache.inflight = null; throw e; });
    }
    res.json(await cache.inflight);
  } catch (e) {
    sendError(res, e, 'launch');
  }
});

module.exports = router;
module.exports.compute = compute;
