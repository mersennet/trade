const { Router } = require('express');
const pool = require('../db/pool');
const { sendError } = require('../middleware/httpError');

const router = Router();

router.get('/', async (req, res) => {
  try {
    const period = req.query.period || 'alltime';
    const sortBy = req.query.sort || 'pnl';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const validPeriods = ['daily', 'weekly', 'monthly', 'alltime'];
    const validSorts = ['pnl', 'volume', 'trade_count', 'pnl_pct'];
    if (!validPeriods.includes(period)) return res.status(400).json({ error: 'Invalid period' });
    if (!validSorts.includes(sortBy)) return res.status(400).json({ error: 'Invalid sort' });

    // Discover available columns once per request so this route never 500s on
    // older deployments that haven't run the schema migration yet.
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'leaderboard'`
    );
    const has = new Set(cols.rows.map((r) => r.column_name));
    const col = (name, def = '0') => (has.has(name) ? name : `${def} AS ${name}`);

    // Map sortBy through the same column-presence guard so a stale schema
    // doesn't make a sort option crash the page.
    const sortExpr = has.has(sortBy) ? sortBy : 'pnl';

    const result = await pool.query(
      `SELECT address,
              ${col('pnl')},
              ${col('pnl_pct')},
              ${col('volume')},
              ${col('trade_count')},
              ${col('win_count')},
              ${col('loss_count')},
              ${col('best_trade')},
              ${col('worst_trade')},
              ${col('max_drawdown')},
              ${has.has('updated_at') ? 'updated_at' : 'NOW() AS updated_at'}
       FROM leaderboard
       WHERE period = $1
       ORDER BY ${sortExpr} DESC
       LIMIT $2 OFFSET $3`,
      [period, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM leaderboard WHERE period = $1', [period]
    );

    res.json({
      period, sortBy,
      traders: result.rows.map((r, i) => {
        const wins = Number(r.win_count) || 0;
        const losses = Number(r.loss_count) || 0;
        // win_count + loss_count = number of (trader, market) buckets that
        // settled with non-zero cashflow. trade_count is total fills, which
        // is a different denominator and would deflate the win rate when a
        // trader scales into a position with several partial fills.
        const decided = wins + losses;
        return {
          rank: offset + i + 1,
          address: r.address,
          pnl: Number(r.pnl) || 0,
          pnlPct: Number(r.pnl_pct) || 0,
          volume: Number(r.volume) || 0,
          trades: Number(r.trade_count) || 0,
          wins,
          losses,
          winRate: decided > 0 ? ((wins / decided) * 100).toFixed(1) : '0',
          bestTrade: Number(r.best_trade) || 0,
          worstTrade: Number(r.worst_trade) || 0,
        };
      }),
      total: Number(countResult.rows[0].count),
      limit, offset,
    });
  } catch (e) {
    console.error('[leaderboard] error:', e.message);
    sendError(res, e, 'leaderboard');
  }
});

router.get('/trader/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      `SELECT * FROM leaderboard WHERE address = $1`, [addr]
    );

    const tradeHistory = await pool.query(
      `SELECT id, block_number, block_timestamp, market_id, taker, maker, side, price, size
       FROM trades WHERE taker = $1 ORDER BY block_timestamp DESC LIMIT 20`,
      [addr]
    );

    // trades.price / trades.size are plain integer chain units (no rescaling).
    const toNum = (raw) => { try { return Number(BigInt(String(raw))); } catch { return Number(raw) || 0; } };

    res.json({
      address: addr,
      stats: result.rows.reduce((acc, r) => { acc[r.period] = r; return acc; }, {}),
      recentTrades: tradeHistory.rows.map(r => ({
        id: r.id,
        block: r.block_number,
        time: r.block_timestamp,
        marketId: r.market_id,
        taker: r.taker,
        maker: r.maker,
        side: r.side,
        price: toNum(r.price),
        size: toNum(r.size),
      })),
    });
  } catch (e) {
    sendError(res, e, 'leaderboard');
  }
});

module.exports = router;
