const pool = require('../db/pool');
const chain = require('./chain');

function toHex(n) { return '0x' + BigInt(Math.round(n)).toString(16); }

async function initTwapTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twap_orders (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      market_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      total_size NUMERIC NOT NULL,
      executed_size NUMERIC DEFAULT 0,
      price_limit NUMERIC,
      slices INTEGER NOT NULL,
      interval_ms INTEGER NOT NULL,
      order_type TEXT DEFAULT 'twap',
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twap_fills (
      id SERIAL PRIMARY KEY,
      twap_id INTEGER REFERENCES twap_orders(id),
      price NUMERIC,
      size NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function executeSlice(twap) {
  const remaining = twap.total_size - twap.executed_size;
  if (remaining <= 0) return null;

  const sliceSize = Math.min(remaining, twap.total_size / twap.slices);
  if (sliceSize <= 0) return null;

  try {
    const ba = await chain.getBestBidAsk(twap.market_id);
    const bestBid = Number(ba.bestBid);
    const bestAsk = Number(ba.bestAsk);
    // Side normalized lowercase on insert; tolerate legacy 'Buy'/'Sell' rows.
    const side = String(twap.side || '').toLowerCase();
    // Marketable slice: buy crosses the ask, sell crosses the bid.
    let price = side === 'buy' ? bestAsk : bestBid;
    if (!price || price <= 0) price = twap.price_limit || 1;

    if (twap.price_limit > 0) {
      if (side === 'buy' && price > twap.price_limit) return null;
      if (side === 'sell' && price < twap.price_limit) return null;
    }

    // TWAP slices used to place unsigned orders as `owner` — that path is
    // closed. Keep the schedule in the DB but do not execute until a signed
    // session/delegation flow exists.
    console.warn(
      `[twap] Skipping slice for #${twap.id} (${twap.owner}): signed session keys required`
    );
    return null;
  } catch (e) {
    console.error(`[twap] Slice error for #${twap.id}:`, e.message);
    return null;
  }
}

let running = false;
async function processTwapOrders() {
  if (running) return;
  running = true;
  try {
    const active = await pool.query(
      "SELECT * FROM twap_orders WHERE status = 'active' AND executed_size < total_size"
    );
    for (const twap of active.rows) {
      const elapsed = Date.now() - new Date(twap.updated_at).getTime();
      if (elapsed >= twap.interval_ms) {
        await executeSlice(twap);
        const updated = await pool.query('SELECT executed_size, total_size FROM twap_orders WHERE id = $1', [twap.id]);
        if (updated.rows[0] && Number(updated.rows[0].executed_size) >= Number(updated.rows[0].total_size)) {
          await pool.query("UPDATE twap_orders SET status = 'completed', updated_at = NOW() WHERE id = $1", [twap.id]);
        }
      }
    }
  } catch (e) {
    console.error('[twap] Process error:', e.message);
  } finally {
    running = false;
  }
}

function startTwapEngine() {
  setInterval(processTwapOrders, 2000);
  console.log('[twap] Engine started (2s interval)');
}

module.exports = { initTwapTables, startTwapEngine };
