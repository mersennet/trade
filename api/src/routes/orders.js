const { Router } = require('express');
const chain = require('../services/chain');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Convert a human amount to integer chain units (the CLOB is integer-only,
// decimals=0). Floors — never rounds up — so a user can't be filled for more
// than they asked. Returns null for amounts that don't survive conversion
// (callers must reject the order rather than submit 0x0).
function toChainHex(value) {
  if (typeof value === 'string' && value.startsWith('0x')) return value;
  const f = parseFloat(value);
  if (!Number.isFinite(f) || f <= 0) return null;
  const n = BigInt(Math.floor(f));
  if (n <= 0n) return null;
  return '0x' + n.toString(16);
}

function parseChainOrder(o) {
  try {
    return {
      id: typeof o.id === 'string' && o.id.startsWith('0x') ? Number(BigInt(o.id)) : o.id,
      order_id: typeof o.id === 'string' && o.id.startsWith('0x') ? Number(BigInt(o.id)) : o.id,
      owner: o.owner,
      market_id: typeof o.market_id === 'string' && o.market_id.startsWith('0x') ? Number(BigInt(o.market_id)) : o.market_id,
      side: o.side?.charAt(0).toUpperCase() + o.side?.slice(1).toLowerCase(),
      price: typeof o.price === 'string' && o.price.startsWith('0x') ? Number(BigInt(o.price)) : Number(o.price),
      size: typeof o.size === 'string' && o.size.startsWith('0x') ? Number(BigInt(o.size)) : Number(o.size),
      tif: o.tif,
    };
  } catch { return o; }
}

router.get('/:address', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const offset = Number(req.query.offset) || 0;
    const marketId = req.query.market_id ? Number(req.query.market_id) : null;

    const raw = await chain.getOpenOrders(req.params.address);
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.orders) ? raw.orders : [];
    let orders = list.map(parseChainOrder);

    if (marketId) {
      orders = orders.filter(o => o.market_id === marketId);
    }

    const total = orders.length;
    orders = orders.slice(offset, offset + limit);

    res.json({ orders, total, limit, offset, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:address/history', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT * FROM orders_history WHERE owner = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [addr, limit, offset]
    );

    res.json({ orders: result.rows, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', strictLimiter, async (req, res) => {
  try {
    const {
      // New canonical shape: signed EIP-712 order from the frontend.
      order, signature,
      // Conditional / metadata params (still accepted alongside `order`).
      owner: legacyOwner, market_id: legacyMarketId, side: legacySide,
      price: legacyPrice, size: legacySize,
      tif, builder_code, leverage,
      tp_price, sl_price, trigger_price, trailing_pct,
      order_type, reduce_only,
    } = req.body;

    // Resolve effective fields from either the signed order or legacy params.
    // Side and owner are normalized to lowercase at this boundary: the
    // conditional-order monitor, TWAP engine, and cancel-all queries all
    // compare lowercase, and the UI sends 'Buy'/'Sell'.
    const rawOwner = order?.trader || legacyOwner;
    const market_id = order?.marketId ?? legacyMarketId;
    const rawSide = order ? (order.isBuy ? 'buy' : 'sell') : legacySide;
    const size = order?.size || legacySize;
    const price = order?.price || legacyPrice;

    if (!rawOwner || !market_id || !rawSide) {
      return res.status(400).json({ error: 'Missing required fields: order or {owner, market_id, side}' });
    }
    const owner = String(rawOwner).toLowerCase();
    if (!ETH_ADDR_RE.test(owner)) {
      return res.status(400).json({ error: 'Invalid owner address' });
    }
    const side = String(rawSide).toLowerCase();
    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: 'Side must be Buy or Sell' });
    }

    const effectiveType = order_type || 'limit';

    if (effectiveType === 'stop' || effectiveType === 'trailing') {
      const result = await pool.query(
        `INSERT INTO conditional_orders
          (owner, market_id, side, size, order_type, trigger_price, limit_price, trailing_pct, tp_price, sl_price, leverage, reduce_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          owner, market_id, side, size, effectiveType,
          trigger_price || null,
          price || null,
          trailing_pct ? Number(trailing_pct) : null,
          tp_price || null,
          sl_price || null,
          leverage || 1,
          reduce_only || false,
        ]
      );

      return res.json({ conditionalOrder: result.rows[0], timestamp: Date.now() });
    }

    if (!size) {
      return res.status(400).json({ error: 'Missing required field: size' });
    }
    if (!price) {
      return res.status(400).json({ error: 'Missing required field: price (for limit/market orders)' });
    }

    // limit / market: submit straight to the on-chain CLOB. Matching is
    // atomic inside the chain engine — no off-chain sequencer.
    const chainPrice = toChainHex(price);
    const chainSize = toChainHex(size);
    if (!chainPrice) {
      return res.status(400).json({ error: `Price must be a positive integer in chain units (got ${price})` });
    }
    if (!chainSize) {
      return res.status(400).json({ error: `Size must be at least 1 integer chain unit (got ${size})` });
    }
    const result = await chain.submitOrder({
      owner, market_id, side, price: chainPrice, size: chainSize, tif: tif || 'Gtc',
    });

    if (tp_price || sl_price) {
      const conditionalInserts = [];
      if (tp_price) {
        conditionalInserts.push(pool.query(
          `INSERT INTO conditional_orders
            (owner, market_id, side, size, order_type, trigger_price, tp_price, leverage, reduce_only)
           VALUES ($1, $2, $3, $4, 'stop', $5, $6, $7, true)`,
          [owner, market_id, side === 'buy' ? 'sell' : 'buy', size, tp_price, tp_price, leverage || 1]
        ));
      }
      if (sl_price) {
        conditionalInserts.push(pool.query(
          `INSERT INTO conditional_orders
            (owner, market_id, side, size, order_type, trigger_price, sl_price, leverage, reduce_only)
           VALUES ($1, $2, $3, $4, 'stop', $5, $6, $7, true)`,
          [owner, market_id, side === 'buy' ? 'sell' : 'buy', size, sl_price, sl_price, leverage || 1]
        ));
      }
      await Promise.all(conditionalInserts);
    }

    if (builder_code) {
      try {
        await pool.query(
          `UPDATE builder_codes SET total_orders = total_orders + 1, total_volume = total_volume + $1 WHERE code = $2 AND active = true`,
          [Number(price) * Number(size), builder_code]
        );
      } catch (_) {}
    }

    res.json({ result, timestamp: Date.now() });
  } catch (e) {
    const status = e.statusCode || 500;
    res.status(status).json({ error: e.message });
  }
});

router.post('/:orderId/cancel-conditional', strictLimiter, async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await pool.query(
      `UPDATE conditional_orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING *`,
      [orderId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Conditional order not found or not pending' });
    }
    res.json({ cancelled: result.rows[0], timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/cancel-all/:address', strictLimiter, async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const maxCancel = Math.min(Number(req.query.max) || 200, 1000);

    const conditionalResult = await pool.query(
      `UPDATE conditional_orders SET status = 'cancelled' WHERE owner = $1 AND status = 'pending' RETURNING id`,
      [addr]
    );

    let onChainCancelled = 0;
    try {
      const openOrders = await chain.getOpenOrders(addr);
      const toCancel = (openOrders || []).slice(0, maxCancel);
      if (toCancel.length) {
        const BATCH_SIZE = 30;
        for (let i = 0; i < toCancel.length; i += BATCH_SIZE) {
          const batch = toCancel.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(
            batch.map(order =>
              chain.cancelOrder(order.id || order.orderId).then(() => { onChainCancelled++; })
            )
          );
        }
      }
    } catch (e) {
      console.error('[cancel-all] Chain cancel error:', e.message);
    }

    res.json({
      conditionalCancelled: conditionalResult.rowCount,
      onChainCancelled,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:orderId', strictLimiter, async (req, res) => {
  try {
    // The sequencer issues IDs that are either numeric (legacy) or composite
    // strings of the form `<trader>_<marketId>_<nonce>_<salt>`. Accept both,
    // restricted to a safe character set so we never forward raw URL junk.
    const raw = String(req.params.orderId || '').trim();
    if (!raw || raw.length > 200 || !/^[0-9a-zA-Z_x]+$/.test(raw)) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }
    const orderId = /^[0-9]+$/.test(raw) ? Number(raw) : raw;
    const result = await chain.cancelOrder(orderId);
    res.json({ result, timestamp: Date.now() });
  } catch (e) {
    const status = e.statusCode || 500;
    res.status(status).json({ error: e.message });
  }
});

router.post('/twap', strictLimiter, async (req, res) => {
  try {
    const { owner, market_id, side, total_size, price_limit, slices, duration_ms, order_type } = req.body;
    if (!owner || !market_id || !side || !total_size || !slices) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    // Normalize like POST /: the TWAP engine compares lowercase side.
    const normOwner = String(owner).toLowerCase();
    const normSide = String(side).toLowerCase();
    if (!['buy', 'sell'].includes(normSide)) {
      return res.status(400).json({ error: 'Side must be Buy or Sell' });
    }
    const intervalMs = Math.max(1000, Math.floor((duration_ms || 60000) / slices));
    const result = await pool.query(
      `INSERT INTO twap_orders (owner, market_id, side, total_size, price_limit, slices, interval_ms, order_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [normOwner, market_id, normSide, total_size, price_limit || 0, slices, intervalMs, order_type || 'twap']
    );
    res.json({ order: result.rows[0], timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/twap/:address', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM twap_orders WHERE owner = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.address]
    );
    res.json({ orders: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/twap/:id', strictLimiter, async (req, res) => {
  try {
    await pool.query("UPDATE twap_orders SET status = 'cancelled' WHERE id = $1", [req.params.id]);
    res.json({ cancelled: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
