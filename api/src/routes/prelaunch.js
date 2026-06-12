const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM prelaunch_markets ORDER BY launch_date ASC`
    );
    res.json({ markets: result.rows });
  } catch (e) {
    res.json({ markets: [], note: 'Pre-launch markets initializing' });
  }
});

router.post('/order', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { address, market_id, side, size, price } = req.body;
    if (!address || !market_id || !side || !size || !price) {
      return res.status(400).json({ error: 'address, market_id, side, size, and price are required' });
    }
    if (!['long', 'short'].includes(side)) {
      return res.status(400).json({ error: 'side must be long or short' });
    }

    const market = await client.query(
      'SELECT * FROM prelaunch_markets WHERE id = $1', [market_id]
    );
    if (!market.rows[0]) {
      return res.status(404).json({ error: 'Market not found' });
    }
    if (market.rows[0].status === 'settled') {
      return res.status(400).json({ error: 'Market already settled' });
    }

    await client.query('BEGIN');

    const order = await client.query(
      `INSERT INTO prelaunch_orders (address, market_id, side, size, price, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', NOW()) RETURNING *`,
      [address.toLowerCase(), market_id, side, Number(size), Number(price)]
    );

    const placed = order.rows[0];
    const oppSide = side === 'long' ? 'short' : 'long';
    const priceOp = side === 'long' ? '<=' : '>=';
    const priceSort = side === 'long' ? 'ASC' : 'DESC';

    const matches = await client.query(
      `SELECT * FROM prelaunch_orders
       WHERE market_id = $1 AND side = $2 AND status = 'open' AND price ${priceOp} $3
       ORDER BY price ${priceSort}, created_at ASC`,
      [market_id, oppSide, Number(price)]
    );

    let remaining = Number(size);
    const fills = [];

    for (const match of matches.rows) {
      if (remaining <= 0) break;
      const matchRemaining = Number(match.remaining_size || match.size);
      const fillSize = Math.min(remaining, matchRemaining);
      const fillPrice = Number(match.price);

      await client.query(
        `INSERT INTO prelaunch_trades (market_id, price, size, long_address, short_address, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          market_id, fillPrice, fillSize,
          side === 'long' ? address.toLowerCase() : match.address,
          side === 'short' ? address.toLowerCase() : match.address,
        ]
      );

      const newRemaining = matchRemaining - fillSize;
      await client.query(
        `UPDATE prelaunch_orders SET remaining_size = $1, status = $2 WHERE id = $3`,
        [newRemaining, newRemaining <= 0 ? 'filled' : 'open', match.id]
      );

      await upsertPosition(client, side === 'long' ? address.toLowerCase() : match.address, market_id, 'long', fillSize, fillPrice);
      await upsertPosition(client, side === 'short' ? address.toLowerCase() : match.address, market_id, 'short', fillSize, fillPrice);

      fills.push({ price: fillPrice, size: fillSize });
      remaining -= fillSize;
    }

    const filled = Number(size) - remaining;
    const finalStatus = remaining <= 0 ? 'filled' : (filled > 0 ? 'partial' : 'open');
    await client.query(
      'UPDATE prelaunch_orders SET remaining_size = $1, status = $2 WHERE id = $3',
      [remaining, finalStatus, placed.id]
    );

    await client.query('COMMIT');
    res.json({ order: { ...placed, remaining_size: remaining, status: finalStatus }, fills });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

async function upsertPosition(client, address, marketId, side, size, price) {
  const existing = await client.query(
    'SELECT * FROM prelaunch_positions WHERE address = $1 AND market_id = $2 AND side = $3',
    [address, marketId, side]
  );
  if (existing.rows[0]) {
    const old = existing.rows[0];
    const newSize = Number(old.size) + size;
    const avgPrice = (Number(old.avg_price) * Number(old.size) + price * size) / newSize;
    await client.query(
      'UPDATE prelaunch_positions SET size = $1, avg_price = $2 WHERE id = $3',
      [newSize, avgPrice, old.id]
    );
  } else {
    await client.query(
      `INSERT INTO prelaunch_positions (address, market_id, side, size, avg_price, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', NOW())`,
      [address, marketId, side, size, price]
    );
  }
}

router.get('/positions/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      `SELECT pp.*, pm.symbol, pm.launch_date, pm.status as market_status
       FROM prelaunch_positions pp
       JOIN prelaunch_markets pm ON pp.market_id = pm.id
       WHERE pp.address = $1
       ORDER BY pp.created_at DESC`,
      [addr]
    );
    res.json({ address: addr, positions: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, positions: [] });
  }
});

router.post('/settle/:marketId', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { marketId } = req.params;
    const { launch_price, admin_key } = req.body;
    if (!launch_price) return res.status(400).json({ error: 'launch_price required' });
    if (admin_key !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await client.query('BEGIN');

    const market = await client.query(
      'SELECT * FROM prelaunch_markets WHERE id = $1', [marketId]
    );
    if (!market.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Market not found' });
    }
    if (market.rows[0].status === 'settled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already settled' });
    }

    const positions = await client.query(
      'SELECT * FROM prelaunch_positions WHERE market_id = $1 AND status = $2',
      [marketId, 'open']
    );

    const lp = Number(launch_price);
    const settlements = [];

    for (const pos of positions.rows) {
      const pnl = pos.side === 'long'
        ? (lp - Number(pos.avg_price)) * Number(pos.size)
        : (Number(pos.avg_price) - lp) * Number(pos.size);

      await client.query(
        "UPDATE prelaunch_positions SET status = 'settled', pnl = $1 WHERE id = $2",
        [pnl, pos.id]
      );
      settlements.push({ address: pos.address, side: pos.side, pnl });
    }

    await client.query(
      "UPDATE prelaunch_markets SET status = 'settled', launch_price = $1 WHERE id = $2",
      [lp, marketId]
    );

    await client.query(
      "UPDATE prelaunch_orders SET status = 'cancelled' WHERE market_id = $1 AND status = 'open'",
      [marketId]
    );

    await client.query('COMMIT');
    res.json({ settled: true, launchPrice: lp, settlements });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
