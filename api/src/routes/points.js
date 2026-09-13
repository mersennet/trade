const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

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
      `SELECT address, total_points, trading_points, lp_points, referral_points, tier
       FROM points_balance WHERE season = $1
       ORDER BY total_points DESC LIMIT $2`,
      [season, limit]
    );

    res.json({
      season,
      leaderboard: result.rows.map((r, i) => ({
        rank: i + 1,
        address: r.address,
        totalPoints: Number(r.total_points),
        tier: r.tier,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
