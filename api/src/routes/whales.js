const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const minValue = Number(req.query.min_value) || 10000;

    const result = await pool.query(
      `SELECT t.id, t.market_id, t.taker, t.side, t.price, t.size, t.block_timestamp, m.symbol
       FROM trades t
       LEFT JOIN markets m ON t.market_id = m.id
       WHERE (t.price * ABS(t.size)) >= $1
       ORDER BY t.block_timestamp DESC
       LIMIT $2`,
      [minValue, limit]
    );

    // trades.price / trades.size are plain integer chain units (no rescaling).
    res.json({
      trades: result.rows.map(r => ({
        id: r.id,
        market_id: r.market_id,
        symbol: r.symbol,
        side: r.side,
        price: Number(r.price),
        size: Number(r.size),
        value: Math.abs(Number(r.price) * Number(r.size)),
        taker: r.taker,
        time: r.block_timestamp,
      })),
      threshold: minValue,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/wallets', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const period = req.query.period || '7d';

    const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
    const interval = intervalMap[period] || '7 days';

    // trades.price / trades.size are plain integer chain units (no rescaling).
    const result = await pool.query(
      `SELECT taker as address,
              COUNT(*) as trade_count,
              SUM(ABS(price * size))::float8 as total_volume,
              MAX(block_timestamp) as last_trade
       FROM trades
       WHERE block_timestamp > NOW() - $1::interval
       GROUP BY taker
       ORDER BY total_volume DESC
       LIMIT $2`,
      [interval, limit]
    );

    res.json({
      // No realized-PnL source exists per wallet yet, so pnl is null (not faked).
      wallets: result.rows.map(r => ({
        address: r.address,
        volume: Number(r.total_volume),
        trades: Number(r.trade_count),
        pnl: null,
        last_active: r.last_trade,
      })),
      period,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/alerts/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      'SELECT * FROM whale_alerts WHERE address = $1 ORDER BY created_at DESC',
      [addr]
    );
    res.json({ address: addr, alerts: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, alerts: [] });
  }
});

router.post('/alerts', strictLimiter, async (req, res) => {
  try {
    const { address, threshold, market_id } = req.body;
    if (!address || !threshold) {
      return res.status(400).json({ error: 'address and threshold are required' });
    }
    if (Number(threshold) < 1000) {
      return res.status(400).json({ error: 'Minimum threshold is $1,000' });
    }

    const result = await pool.query(
      `INSERT INTO whale_alerts (address, threshold, market_id, active, created_at)
       VALUES ($1, $2, $3, true, NOW()) RETURNING *`,
      [address.toLowerCase(), Number(threshold), market_id != null ? Number(market_id) : null]
    );
    res.json({ alert: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
