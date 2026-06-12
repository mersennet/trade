const pool = require('../db/pool');
const chain = require('./chain');

async function initConditionalOrdersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conditional_orders (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      market_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      size TEXT NOT NULL,
      order_type TEXT NOT NULL,
      trigger_price TEXT,
      limit_price TEXT,
      trailing_pct REAL,
      tp_price TEXT,
      sl_price TEXT,
      leverage INTEGER DEFAULT 1,
      reduce_only BOOLEAN DEFAULT false,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      triggered_at TIMESTAMP,
      error TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funding_rates (
      id SERIAL PRIMARY KEY,
      market_id INTEGER NOT NULL,
      rate REAL NOT NULL,
      timestamp TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('[conditional-orders] Tables initialized');
}

const trailingState = new Map();

async function evaluateConditionalOrder(order) {
  const { bestBid, bestAsk } = await chain.getBestBidAsk(order.market_id);
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;

  if (mid <= 0) return false;

  // Side is normalized lowercase on insert, but tolerate legacy 'Buy'/'Sell'
  // rows written before that normalization landed.
  const side = String(order.side || '').toLowerCase();

  if (order.order_type === 'stop') {
    const trigger = Number(order.trigger_price);
    if (side === 'buy' && mid >= trigger) return true;
    if (side === 'sell' && mid <= trigger) return true;
  }

  if (order.order_type === 'trailing') {
    const pct = order.trailing_pct / 100;
    const key = order.id;
    const prev = trailingState.get(key);

    if (side === 'sell') {
      const peak = prev ? Math.max(prev.peak, mid) : mid;
      trailingState.set(key, { peak });
      if (mid <= peak * (1 - pct)) return true;
    } else {
      const trough = prev ? Math.min(prev.trough, mid) : mid;
      trailingState.set(key, { trough });
      if (mid >= trough * (1 + pct)) return true;
    }
  }

  if (order.tp_price) {
    const tp = Number(order.tp_price);
    if (side === 'buy' && mid >= tp) return true;
    if (side === 'sell' && mid <= tp) return true;
  }

  if (order.sl_price) {
    const sl = Number(order.sl_price);
    if (side === 'buy' && mid <= sl) return true;
    if (side === 'sell' && mid >= sl) return true;
  }

  return false;
}

async function triggerOrder(order) {
  // Floor to integer chain units (CLOB is integer-only), never round up.
  const toHex = (n) => '0x' + BigInt(Math.max(0, Math.floor(Number(n) || 0))).toString(16);
  const result = await chain.submitOrder({
    owner: order.owner,
    market_id: order.market_id,
    side: String(order.side || '').toLowerCase(),
    price: toHex(order.limit_price || order.trigger_price || 0),
    size: toHex(order.size),
    tif: 'Ioc',
  });
  return result;
}

let monitorInterval = null;

function startPriceMonitor() {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM conditional_orders WHERE status = 'pending'`
      );

      for (const order of rows) {
        try {
          const shouldTrigger = await evaluateConditionalOrder(order);
          if (shouldTrigger) {
            await triggerOrder(order);
            await pool.query(
              `UPDATE conditional_orders SET status = 'triggered', triggered_at = NOW() WHERE id = $1`,
              [order.id]
            );
            trailingState.delete(order.id);
            console.log(`[conditional-orders] Triggered order #${order.id}`);
          }
        } catch (err) {
          await pool.query(
            `UPDATE conditional_orders SET status = 'failed', error = $1 WHERE id = $2`,
            [err.message, order.id]
          );
          trailingState.delete(order.id);
          console.error(`[conditional-orders] Order #${order.id} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('[conditional-orders] Monitor tick error:', err.message);
    }
  }, 2000);

  console.log('[conditional-orders] Price monitor running (2s interval)');
}

function stopPriceMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

module.exports = {
  initConditionalOrdersTable,
  startPriceMonitor,
  stopPriceMonitor,
};
