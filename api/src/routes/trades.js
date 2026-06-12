const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');

const router = Router();

router.get('/export/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      `SELECT t.block_timestamp, t.market_id, t.side, t.price, t.size
       FROM trades t
       WHERE t.taker = $1 OR t.maker = $1
       ORDER BY t.block_timestamp DESC`,
      [addr]
    );

    const marketMap = {};
    for (const m of chain.MARKETS) marketMap[m.id] = m.symbol;

    const lines = ['Date,Market,Side,Price,Size,Fee,PnL'];
    for (const r of result.rows) {
      const date = new Date(r.block_timestamp).toISOString();
      const market = marketMap[r.market_id] || `Market #${r.market_id}`;
      const price = (() => { try { return Number(BigInt(String(r.price))); } catch { return Number(r.price) || 0; } })();
      const size  = (() => { try { return Number(BigInt(String(r.size))); } catch { return Number(r.size) || 0; } })();
      const fee = (price * size * 0.0005).toFixed(6);
      lines.push(`${date},${market},${r.side},${price},${size},${fee},0`);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="trades-${addr}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:marketId', async (req, res) => {
  try {
    const { marketId } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT id, block_number, block_timestamp, market_id, taker, maker, side, price, size
       FROM trades WHERE market_id = $1
       ORDER BY block_timestamp DESC LIMIT $2 OFFSET $3`,
      [marketId, limit, offset]
    );

    const count = await pool.query(
      'SELECT COUNT(*) FROM trades WHERE market_id = $1', [marketId]
    );

    // Stored as plain integer chain units — no decimal rescaling.
    const toUsd = (raw) => {
      try { return Number(BigInt(String(raw))); } catch { return Number(raw) || 0; }
    };
    const toBase = toUsd;

    res.json({
      trades: result.rows.map(r => ({
        id: r.id,
        block: r.block_number,
        time: r.block_timestamp,
        marketId: r.market_id,
        taker: r.taker,
        maker: r.maker,
        side: r.side,
        price: toUsd(r.price),
        size: toBase(r.size),
      })),
      total: Number(count.rows[0].count),
      limit, offset,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/user/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT id, block_number, block_timestamp, market_id, taker, maker, side, price, size
       FROM trades WHERE taker = $1 OR maker = $1
       ORDER BY block_timestamp DESC LIMIT $2 OFFSET $3`,
      [addr, limit, offset]
    );

    const toUsd = (r) => { try { return Number(BigInt(String(r))); } catch { return Number(r) || 0; } };
    const toBase = toUsd;

    res.json({
      trades: result.rows.map(r => ({
        id: r.id, block: r.block_number, time: r.block_timestamp,
        marketId: r.market_id, taker: r.taker, maker: r.maker, side: r.side,
        price: toUsd(r.price), size: toBase(r.size),
      })),
      limit, offset,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
