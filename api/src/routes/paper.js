const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');
const { strictLimiter } = require('../middleware/rateLimit');
const { sendError } = require('../middleware/httpError');

const router = Router();

const INITIAL_BALANCE = 100000;

// Latest traded price for a market_id in human units (chain price ÷ the
// market's priceScale). Used as the paper execution/mark price.
async function latestPrice(client, marketId) {
  const r = await client.query(
    `SELECT price FROM trades WHERE market_id = $1 ORDER BY block_timestamp DESC LIMIT 1`,
    [marketId]
  );
  return chain.toHumanPrice(marketId, r.rows[0]?.price || 0);
}

// Sign convention: paper UI uses 'buy'/'sell' (long/short). Accept either.
function normalizeSide(side) {
  if (side === 'long' || side === 'buy') return 'buy';
  if (side === 'short' || side === 'sell') return 'sell';
  return null;
}

router.post('/init/:address', strictLimiter, async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();

    const existing = await pool.query(
      'SELECT * FROM paper_balances WHERE address = $1', [addr]
    );
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'Paper account already exists', balance: existing.rows[0] });
    }

    const result = await pool.query(
      `INSERT INTO paper_balances (address, balance, equity, initial_balance, created_at)
       VALUES ($1, $2, $2, $2, NOW()) RETURNING *`,
      [addr, INITIAL_BALANCE]
    );
    res.json({ account: result.rows[0], balance: Number(result.rows[0].balance) });
  } catch (e) {
    sendError(res, e, 'paper');
  }
});

router.get('/balance/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      'SELECT * FROM paper_balances WHERE address = $1', [addr]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Paper account not found. POST /init/:address first' });
    }

    const positions = await pool.query(
      `SELECT COALESCE(SUM(unrealized_pnl), 0) as unrealized
       FROM paper_positions WHERE owner = $1 AND status = 'open'`,
      [addr]
    );

    const bal = result.rows[0];
    const unrealized = Number(positions.rows[0].unrealized);
    const balance = Number(bal.balance);
    const initialBalance = Number(bal.initial_balance);
    res.json({
      address: addr,
      balance,
      equity: balance + unrealized,
      initialBalance,
      unrealizedPnl: unrealized,
      totalPnl: balance - initialBalance + unrealized,
    });
  } catch (e) {
    sendError(res, e, 'paper');
  }
});

router.post('/order', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    // Web client submits { owner, market_id, side: 'buy'|'sell', price, size, leverage }.
    const owner = req.body.owner || req.body.address;
    const marketId = Number(req.body.market_id);
    const side = normalizeSide(req.body.side);
    const size = Number(req.body.size);
    const { leverage } = req.body;

    if (!owner || !marketId || !req.body.side || !size) {
      return res.status(400).json({ error: 'owner, market_id, side, and size are required' });
    }
    if (!side) {
      return res.status(400).json({ error: 'side must be buy/long or sell/short' });
    }

    const addr = owner.toLowerCase();
    await client.query('BEGIN');

    const account = await client.query(
      'SELECT * FROM paper_balances WHERE address = $1', [addr]
    );
    if (!account.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Paper account not found' });
    }

    const execPrice = await latestPrice(client, marketId);
    if (execPrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No market price available' });
    }

    const lev = Math.min(Math.max(Number(leverage) || 1, 1), 50);
    const notional = size * execPrice;
    const margin = notional / lev;
    const balance = Number(account.rows[0].balance);

    if (margin > balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient paper balance', required: margin, available: balance });
    }

    await client.query(
      'UPDATE paper_balances SET balance = balance - $1 WHERE address = $2',
      [margin, addr]
    );

    const position = await client.query(
      `INSERT INTO paper_positions
       (owner, market_id, side, size, entry_price, leverage, margin, unrealized_pnl, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'open', NOW()) RETURNING *`,
      [addr, marketId, side, size, execPrice, lev, margin]
    );

    const trade = await client.query(
      `INSERT INTO paper_trades
       (owner, market_id, side, size, price, leverage, pnl, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, NOW()) RETURNING *`,
      [addr, marketId, side, size, execPrice, lev]
    );

    await client.query('COMMIT');
    res.json({ position: position.rows[0], trade: trade.rows[0], executionPrice: execPrice });
  } catch (e) {
    await client.query('ROLLBACK');
    sendError(res, e, 'paper');
  } finally {
    client.release();
  }
});

router.get('/positions/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const status = req.query.status || 'open';
    const result = await pool.query(
      'SELECT * FROM paper_positions WHERE owner = $1 AND status = $2 ORDER BY created_at DESC',
      [addr, status]
    );

    // Enrich each open position with the current mark price and live unrealized PnL
    // so the UI's mark_price / pnl columns render real numbers.
    const positions = [];
    for (const p of result.rows) {
      const mark = await latestPrice(pool, p.market_id);
      const entry = Number(p.entry_price);
      const sz = Number(p.size);
      const dir = p.side === 'buy' ? 1 : -1;
      const pnl = mark > 0 ? (mark - entry) * sz * dir : Number(p.unrealized_pnl || 0);
      positions.push({
        id: p.id,
        market_id: p.market_id,
        side: p.side,
        size: sz,
        entry_price: entry,
        mark_price: mark,
        pnl,
        leverage: Number(p.leverage),
        margin: Number(p.margin),
        status: p.status,
        created_at: p.created_at,
      });
    }
    res.json({ address: addr, positions });
  } catch (e) {
    res.json({ address: req.params.address, positions: [] });
  }
});

router.get('/trades/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const result = await pool.query(
      'SELECT * FROM paper_trades WHERE owner = $1 ORDER BY created_at DESC LIMIT $2',
      [addr, limit]
    );
    res.json({
      address: addr,
      trades: result.rows.map(t => ({
        id: t.id,
        market_id: t.market_id,
        side: t.side,
        price: Number(t.price),
        size: Number(t.size),
        leverage: Number(t.leverage),
        pnl: Number(t.pnl || 0),
        created_at: t.created_at,
      })),
    });
  } catch (e) {
    res.json({ address: req.params.address, trades: [] });
  }
});

module.exports = router;
