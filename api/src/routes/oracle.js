const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

router.get('/prices', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT symbol, price, sources, confidence, updated_at
       FROM oracle_prices
       ORDER BY symbol ASC`
    );
    res.json({
      prices: result.rows.map(r => ({
        symbol: r.symbol,
        price: Number(r.price),
        sources: Number(r.sources || 0),
        confidence: Number(r.confidence || 0),
        updatedAt: r.updated_at,
      })),
      timestamp: Date.now(),
    });
  } catch (e) {
    res.json({ prices: [], note: 'Oracle initializing' });
  }
});

router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const result = await pool.query(
      'SELECT * FROM oracle_prices WHERE symbol = $1',
      [symbol.toUpperCase()]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: `Price not found for ${symbol}` });
    }
    const row = result.rows[0];
    res.json({
      symbol: row.symbol,
      price: Number(row.price),
      sources: Number(row.sources || 0),
      confidence: Number(row.confidence || 0),
      updatedAt: row.updated_at,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/health', async (req, res) => {
  try {
    const stale = await pool.query(
      `SELECT COUNT(*) as stale_count FROM oracle_prices
       WHERE updated_at < NOW() - interval '5 minutes'`
    );
    const total = await pool.query('SELECT COUNT(*) as total FROM oracle_prices');
    const latest = await pool.query(
      'SELECT MAX(updated_at) as last_update FROM oracle_prices'
    );

    const staleCount = Number(stale.rows[0].stale_count);
    const totalCount = Number(total.rows[0].total);
    const freshCount = totalCount - staleCount;

    res.json({
      status: staleCount === 0 ? 'healthy' : (staleCount < totalCount ? 'degraded' : 'stale'),
      totalFeeds: totalCount,
      freshFeeds: freshCount,
      staleFeeds: staleCount,
      lastUpdate: latest.rows[0].last_update,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(503).json({
      status: 'unavailable',
      error: e.message,
      timestamp: Date.now(),
    });
  }
});

module.exports = router;
