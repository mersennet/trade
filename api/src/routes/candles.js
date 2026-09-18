const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');
const { sendError } = require('../middleware/httpError');

const router = Router();

const VALID_RESOLUTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

// Accepts the numeric market id or a symbol (MRSN/USD, MRSN-USD, mrsn).
function resolveMarketId(param) {
  if (/^\d+$/.test(param)) {
    const id = Number(param);
    return chain.MARKETS.some((m) => m.id === id) ? id : null;
  }
  const key = String(param).toUpperCase().replace('-', '/');
  const m = chain.MARKETS.find((x) => x.symbol === key || x.base === key || x.symbol === `${key}/USD`);
  return m ? m.id : null;
}

router.get('/:marketId', async (req, res) => {
  try {
    const marketId = resolveMarketId(req.params.marketId);
    if (marketId == null) {
      return res.status(404).json({ error: `Unknown market '${req.params.marketId}'. Use the numeric id or symbol from /api/v1/markets.` });
    }
    // `interval` is accepted as an alias for `resolution`.
    const resolution = req.query.resolution || req.query.interval || '1h';
    // from/to are Unix milliseconds (seconds are accepted and scaled).
    const parseTime = (v, fallback) => {
      if (v == null || v === '') return fallback;
      let n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (n < 1e12) n *= 1000;
      return new Date(n);
    };
    const from = parseTime(req.query.from, new Date(Date.now() - 24 * 3600 * 1000));
    const to = parseTime(req.query.to, new Date());
    if (!from || !to) {
      return res.status(400).json({ error: 'Invalid parameter', detail: 'from/to must be Unix timestamps (ms or s)' });
    }
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 500), 2000);

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
      marketId,
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
    sendError(res, e, 'candles');
  }
});

module.exports = router;
