const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');
const { sendError } = require('../middleware/httpError');

const router = Router();

// Identity of the Mersennet OTC desk that quotes against incoming RFQs.
const OTC_DESK = '0x0000000000000000000000000000000000000DE5';

router.post('/rfq', strictLimiter, async (req, res) => {
  try {
    const { address, market, side, size } = req.body;
    if (!address || !market || !side || !size) {
      return res.status(400).json({ error: 'address, market, side, and size are required' });
    }
    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: 'side must be buy or sell' });
    }
    if (Number(size) <= 0) {
      return res.status(400).json({ error: 'size must be positive' });
    }

    const marketPrice = await pool.query(
      `SELECT price FROM trades WHERE market_id = (SELECT id FROM markets WHERE symbol = $1 LIMIT 1)
       ORDER BY block_timestamp DESC LIMIT 1`,
      [market]
    );
    const refPrice = Number(marketPrice.rows[0]?.price || 0);
    const spread = 0.002;
    const quotePrice = side === 'buy'
      ? refPrice * (1 + spread)
      : refPrice * (1 - spread);

    const expiresAt = new Date(Date.now() + 30000).toISOString();

    const result = await pool.query(
      `INSERT INTO otc_quotes (address, quoter, market, side, size, quote_price, reference_price, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, NOW()) RETURNING *`,
      [address.toLowerCase(), OTC_DESK, market, side, Number(size), quotePrice, refPrice, expiresAt]
    );

    res.json({ quote: result.rows[0] });
  } catch (e) {
    sendError(res, e, 'otc');
  }
});

router.get('/quotes/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    await pool.query(
      "UPDATE otc_quotes SET status = 'expired' WHERE address = $1 AND status = 'active' AND expires_at < NOW()",
      [addr]
    );
    const result = await pool.query(
      "SELECT * FROM otc_quotes WHERE address = $1 AND status = 'active' ORDER BY created_at DESC",
      [addr]
    );
    res.json({ address: addr, quotes: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, quotes: [] });
  }
});

router.post('/accept/:id', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });

    await client.query('BEGIN');

    const quote = await client.query(
      "SELECT * FROM otc_quotes WHERE id = $1 AND address = $2 AND status = 'active'",
      [id, address.toLowerCase()]
    );
    if (!quote.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active quote not found' });
    }

    const q = quote.rows[0];
    if (new Date(q.expires_at) < new Date()) {
      await client.query(
        "UPDATE otc_quotes SET status = 'expired' WHERE id = $1",
        [id]
      );
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Quote has expired' });
    }

    await client.query(
      "UPDATE otc_quotes SET status = 'filled' WHERE id = $1",
      [id]
    );

    const trade = await client.query(
      `INSERT INTO otc_trades (quote_id, address, quoter, market, side, size, price, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'filled', NOW()) RETURNING *`,
      [id, address.toLowerCase(), q.quoter || OTC_DESK, q.market, q.side, q.size, q.quote_price]
    );

    await client.query('COMMIT');
    res.json({ accepted: true, trade: trade.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    sendError(res, e, 'otc');
  } finally {
    client.release();
  }
});

router.get('/history/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const result = await pool.query(
      'SELECT * FROM otc_trades WHERE address = $1 ORDER BY created_at DESC LIMIT $2',
      [addr, limit]
    );
    res.json({ address: addr, history: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, history: [] });
  }
});

module.exports = router;
