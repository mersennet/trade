const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');

const router = Router();

const VALID_RESOLUTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

router.get('/:marketId', async (req, res) => {
  try {
    const { marketId } = req.params;
    const resolution = req.query.resolution || '1h';
    const from = req.query.from ? new Date(Number(req.query.from)) : new Date(Date.now() - 24 * 3600 * 1000);
    const to = req.query.to ? new Date(Number(req.query.to)) : new Date();
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    if (!VALID_RESOLUTIONS.includes(resolution)) {
      return res.status(400).json({ error: `Invalid resolution. Valid: ${VALID_RESOLUTIONS.join(', ')}` });
    }

    const result = await pool.query(
      `SELECT open_time, open, high, low, close, volume, trade_count
       FROM candles
       WHERE market_id = $1 AND resolution = $2 AND open_time >= $3 AND open_time <= $4
       ORDER BY open_time ASC
       LIMIT $5`,
      [marketId, resolution, from, to, limit]
    );

    // Candles are aggregated from trades: prices in chain units (human ×
    // the market's priceScale), volume in plain integer size units.
    const toUsd = (v) => chain.toHumanPrice(marketId, v);
    const toBase = (v) => { try { return Number(BigInt(String(v))); } catch { return Number(v) || 0; } };

    res.json({
      marketId: Number(marketId),
      resolution,
      candles: result.rows.map(r => ({
        time: Math.floor(new Date(r.open_time).getTime() / 1000),
        open:  toUsd(r.open),
        high:  toUsd(r.high),
        low:   toUsd(r.low),
        close: toUsd(r.close),
        volume: toBase(r.volume),
        trades: r.trade_count,
      })),
      count: result.rows.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
