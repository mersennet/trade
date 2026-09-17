const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

/**
 * GET /api/v1/points/sprint — the weekly sprint: current standings (this
 * week's taker volume, Monday 00:00 UTC to now, real traders only), prizes,
 * time to the next award, and the last week's winners.
 */
router.get('/sprint', async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); // this week's Monday 00:00 UTC
    const end = new Date(start.getTime() + 7 * 86_400_000);
    const [standings, last] = await Promise.all([
      pool.query(
        `SELECT LOWER(taker) AS address, SUM(price * size)::float8 AS volume, COUNT(*)::int AS trades
           FROM trades
          WHERE taker IS NOT NULL AND block_timestamp >= $1
            AND LOWER(taker) NOT LIKE '0x00000000000000000000000000000000000000%'
            AND LOWER(taker) NOT IN (SELECT address FROM excluded_addresses)
          GROUP BY LOWER(taker) ORDER BY volume DESC LIMIT 10`,
        [start.toISOString()]
      ).catch(() => ({ rows: [] })),
      pool.query(`SELECT week_start, address, rank, volume::float8 AS volume, points::float8 AS points FROM weekly_sprint_awards WHERE address <> 'none' ORDER BY week_start DESC, rank ASC LIMIT 3`).catch(() => ({ rows: [] })),
    ]);
    res.json({
      weekStart: start.toISOString(),
      awardAt: end.toISOString(),
      prizes: [3000, 2000, 1000],
      standings: standings.rows.map((r, i) => ({ rank: i + 1, address: r.address, volume: Number(r.volume), trades: r.trades })),
      lastWinners: last.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    // Reject non-address params so sibling paths (e.g. /points/leaderboard) can't
    // be swallowed by this catch-all and return a bogus pseudo-account.
    if (!/^0x[0-9a-f]{40}$/.test(addr)) {
      return res.status(400).json({ error: 'Invalid address' });
    }
    const season = Number(req.query.season) || 1;

    const balance = await pool.query(
      'SELECT * FROM points_balance WHERE address = $1 AND season = $2',
      [addr, season]
    );

    const history = await pool.query(
      `SELECT point_type, amount, reason, created_at FROM points
       WHERE address = $1 AND season = $2
       ORDER BY created_at DESC LIMIT 50`,
      [addr, season]
    );

    const ranking = await pool.query(
      `SELECT COUNT(*) + 1 as rank FROM points_balance
       WHERE season = $1 AND total_points > COALESCE((
         SELECT total_points FROM points_balance WHERE address = $2 AND season = $1
       ), 0)`,
      [season, addr]
    );

    const bal = balance.rows[0] || { total_points: 0, trading_points: 0, lp_points: 0, referral_points: 0, tier: 'bronze' };
    res.json({
      address: addr,
      season,
      totalPoints: Number(bal.total_points),
      tradingPoints: Number(bal.trading_points),
      lpPoints: Number(bal.lp_points),
      referralPoints: Number(bal.referral_points),
      nodePoints: Number(bal.node_points || 0),
      bonusPoints: Number(bal.bonus_points || 0),
      tier: bal.tier,
      rank: Number(ranking.rows[0]?.rank || 0),
      history: history.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/leaderboard/season/:season', async (req, res) => {
  try {
    const season = Number(req.params.season) || 1;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const result = await pool.query(
      `SELECT address, total_points, trading_points, lp_points, referral_points, tier,
              COALESCE(node_points, 0) AS node_points, COALESCE(bonus_points, 0) AS bonus_points
       FROM points_balance WHERE season = $1 AND total_points > 0
       ORDER BY total_points DESC LIMIT $2`,
      [season, limit]
    );

    res.json({
      season,
      leaderboard: result.rows.map((r, i) => ({
        rank: i + 1,
        address: r.address,
        totalPoints: Number(r.total_points),
        tradingPoints: Number(r.trading_points),
        nodePoints: Number(r.node_points),
        referralPoints: Number(r.referral_points),
        bonusPoints: Number(r.bonus_points),
        tier: r.tier,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
