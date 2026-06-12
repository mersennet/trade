const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');
const { matchOrders } = require('../services/spotEngine');

const router = Router();

// Resolve a pair symbol (e.g. "MRSN/USDC") to its market row. Returns null if unknown.
async function resolveMarket(client, pair) {
  const r = await (client || pool).query(
    'SELECT id, symbol, base, quote FROM spot_markets WHERE symbol = $1',
    [pair]
  );
  return r.rows[0] || null;
}

router.get('/', async (req, res) => {
  try {
    // Expose `symbol` as `pair` so the web client (which keys everything by pair) works directly.
    const result = await pool.query(
      'SELECT id, symbol AS pair, base, quote, status FROM spot_markets ORDER BY symbol ASC'
    );
    res.json({ markets: result.rows });
  } catch (e) {
    res.json({ markets: [], note: 'Spot markets initializing' });
  }
});

router.get('/orderbook/:pair', async (req, res) => {
  try {
    const pair = decodeURIComponent(req.params.pair);
    const depth = Math.min(Number(req.query.depth) || 50, 200);

    const market = await resolveMarket(null, pair);
    if (!market) {
      return res.json({ orderbook: { bids: [], asks: [] }, pair, timestamp: Date.now() });
    }

    const [bids, asks] = await Promise.all([
      pool.query(
        `SELECT price, SUM(size - filled) AS size
         FROM spot_orders
         WHERE market_id = $1 AND side = 'buy' AND status IN ('open','partial')
         GROUP BY price ORDER BY price DESC LIMIT $2`,
        [market.id, depth]
      ),
      pool.query(
        `SELECT price, SUM(size - filled) AS size
         FROM spot_orders
         WHERE market_id = $1 AND side = 'sell' AND status IN ('open','partial')
         GROUP BY price ORDER BY price ASC LIMIT $2`,
        [market.id, depth]
      ),
    ]);

    res.json({
      pair,
      orderbook: {
        bids: bids.rows.map(r => [Number(r.price), Number(r.size)]),
        asks: asks.rows.map(r => [Number(r.price), Number(r.size)]),
      },
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/order', strictLimiter, async (req, res) => {
  try {
    const { owner, pair, side, price, size } = req.body;
    if (!owner || !pair || !side || !size) {
      return res.status(400).json({ error: 'owner, pair, side, and size are required' });
    }
    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: 'side must be buy or sell' });
    }
    const orderPrice = Number(price);
    if (!orderPrice || orderPrice <= 0) {
      return res.status(400).json({ error: 'Valid price required' });
    }
    if (Number(size) <= 0) {
      return res.status(400).json({ error: 'Valid size required' });
    }

    const market = await resolveMarket(null, pair);
    if (!market) {
      return res.status(404).json({ error: 'Unknown market' });
    }

    const order = await pool.query(
      `INSERT INTO spot_orders (owner, market_id, side, price, size, filled, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, 'open', NOW()) RETURNING *`,
      [owner.toLowerCase(), market.id, side, orderPrice, Number(size)]
    );

    // Run the matching engine across the book for this pair.
    const fills = await matchOrders(market.symbol);

    const updated = await pool.query('SELECT * FROM spot_orders WHERE id = $1', [order.rows[0].id]);
    const placed = updated.rows[0];

    res.json({
      order: { ...placed, pair, remaining_size: Number(placed.size) - Number(placed.filled) },
      fills,
      filled: Number(placed.filled),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/order/:id', strictLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.body;
    if (!owner) return res.status(400).json({ error: 'owner required' });

    const result = await pool.query(
      `UPDATE spot_orders SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND owner = $2 AND status IN ('open', 'partial') RETURNING *`,
      [id, owner.toLowerCase()]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Order not found or already filled/cancelled' });
    }
    res.json({ cancelled: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/trades/:pair', async (req, res) => {
  try {
    const pair = decodeURIComponent(req.params.pair);
    const limit = Math.min(Number(req.query.limit) || 50, 500);

    const market = await resolveMarket(null, pair);
    if (!market) {
      return res.json({ trades: [] });
    }

    const result = await pool.query(
      `SELECT id, $2::text AS pair, price, size, buyer, seller, created_at
       FROM spot_trades WHERE market_id = $1 ORDER BY created_at DESC LIMIT $3`,
      [market.id, pair, limit]
    );
    res.json({ trades: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/balances/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      'SELECT asset, available, locked FROM spot_balances WHERE owner = $1 ORDER BY asset ASC',
      [addr]
    );
    res.json({ address: addr, balances: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, balances: [] });
  }
});

module.exports = router;
