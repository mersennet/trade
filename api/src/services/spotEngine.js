const pool = require('../db/pool');
const chain = require('./chain');

async function initSpotTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spot_markets (
      id SERIAL PRIMARY KEY,
      symbol TEXT UNIQUE NOT NULL,
      base TEXT NOT NULL,
      quote TEXT NOT NULL,
      tick_size NUMERIC NOT NULL DEFAULT 0.01,
      lot_size NUMERIC NOT NULL DEFAULT 0.001,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spot_orders (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      market_id INTEGER REFERENCES spot_markets(id),
      side TEXT NOT NULL,
      price NUMERIC NOT NULL,
      size NUMERIC NOT NULL,
      filled NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spot_trades (
      id SERIAL PRIMARY KEY,
      market_id INTEGER REFERENCES spot_markets(id),
      buy_order_id INTEGER REFERENCES spot_orders(id),
      sell_order_id INTEGER REFERENCES spot_orders(id),
      price NUMERIC NOT NULL,
      size NUMERIC NOT NULL,
      buyer TEXT NOT NULL,
      seller TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spot_balances (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      asset TEXT NOT NULL,
      available NUMERIC DEFAULT 0,
      locked NUMERIC DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(owner, asset)
    )
  `);
}

async function seedSpotMarkets() {
  const markets = [
    { symbol: 'MRSN/USDC', base: 'MRSN', quote: 'USDC', tick_size: 0.001, lot_size: 1 },
    { symbol: 'BTC/USDC',  base: 'BTC',  quote: 'USDC', tick_size: 0.01,  lot_size: 0.0001 },
    { symbol: 'ETH/USDC',  base: 'ETH',  quote: 'USDC', tick_size: 0.01,  lot_size: 0.001 },
    { symbol: 'SOL/USDC',  base: 'SOL',  quote: 'USDC', tick_size: 0.01,  lot_size: 0.01 },
    { symbol: 'ARB/USDC',  base: 'ARB',  quote: 'USDC', tick_size: 0.0001, lot_size: 1 },
  ];
  for (const m of markets) {
    await pool.query(
      `INSERT INTO spot_markets (symbol, base, quote, tick_size, lot_size)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (symbol) DO NOTHING`,
      [m.symbol, m.base, m.quote, m.tick_size, m.lot_size]
    );
  }
}

async function executeMatch(buyOrder, sellOrder, price, size) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO spot_trades (market_id, buy_order_id, sell_order_id, price, size, buyer, seller)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [buyOrder.market_id, buyOrder.id, sellOrder.id, price, size, buyOrder.owner, sellOrder.owner]
    );

    const quoteAmount = price * size;

    await client.query(
      `UPDATE spot_orders SET filled = filled + $1, updated_at = NOW(),
       status = CASE WHEN filled + $1 >= size THEN 'filled' ELSE 'partial' END
       WHERE id = $2`,
      [size, buyOrder.id]
    );
    await client.query(
      `UPDATE spot_orders SET filled = filled + $1, updated_at = NOW(),
       status = CASE WHEN filled + $1 >= size THEN 'filled' ELSE 'partial' END
       WHERE id = $2`,
      [size, sellOrder.id]
    );

    const market = (await client.query('SELECT base, quote FROM spot_markets WHERE id = $1', [buyOrder.market_id])).rows[0];

    await client.query(
      `INSERT INTO spot_balances (owner, asset, available) VALUES ($1, $2, $3)
       ON CONFLICT (owner, asset) DO UPDATE SET available = spot_balances.available + $3, updated_at = NOW()`,
      [buyOrder.owner, market.base, size]
    );
    await client.query(
      `INSERT INTO spot_balances (owner, asset, available) VALUES ($1, $2, $3)
       ON CONFLICT (owner, asset) DO UPDATE SET available = spot_balances.available - $3, updated_at = NOW()`,
      [buyOrder.owner, market.quote, quoteAmount]
    );
    await client.query(
      `INSERT INTO spot_balances (owner, asset, available) VALUES ($1, $2, $3)
       ON CONFLICT (owner, asset) DO UPDATE SET available = spot_balances.available + $3, updated_at = NOW()`,
      [sellOrder.owner, market.quote, quoteAmount]
    );
    await client.query(
      `INSERT INTO spot_balances (owner, asset, available) VALUES ($1, $2, $3)
       ON CONFLICT (owner, asset) DO UPDATE SET available = spot_balances.available - $3, updated_at = NOW()`,
      [sellOrder.owner, market.base, size]
    );

    await client.query('COMMIT');
    return { price, size, buyer: buyOrder.owner, seller: sellOrder.owner };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[spotEngine] Match execution error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

async function matchOrders(pair) {
  const market = (await pool.query('SELECT id FROM spot_markets WHERE symbol = $1', [pair])).rows[0];
  if (!market) return [];

  const buys = (await pool.query(
    `SELECT * FROM spot_orders
     WHERE market_id = $1 AND side = 'buy' AND status IN ('open','partial')
     ORDER BY price DESC, created_at ASC`,
    [market.id]
  )).rows;

  const sells = (await pool.query(
    `SELECT * FROM spot_orders
     WHERE market_id = $1 AND side = 'sell' AND status IN ('open','partial')
     ORDER BY price ASC, created_at ASC`,
    [market.id]
  )).rows;

  const fills = [];
  let bi = 0, si = 0;

  while (bi < buys.length && si < sells.length) {
    const buy = buys[bi];
    const sell = sells[si];

    const buyRemaining = Number(buy.size) - Number(buy.filled);
    const sellRemaining = Number(sell.size) - Number(sell.filled);

    if (Number(buy.price) < Number(sell.price)) break;

    const fillPrice = Number(sell.price);
    const fillSize = Math.min(buyRemaining, sellRemaining);

    if (fillSize > 0) {
      const fill = await executeMatch(buy, sell, fillPrice, fillSize);
      fills.push(fill);

      buy.filled = Number(buy.filled) + fillSize;
      sell.filled = Number(sell.filled) + fillSize;
    }

    if (Number(buy.filled) >= Number(buy.size)) bi++;
    if (Number(sell.filled) >= Number(sell.size)) si++;
  }

  return fills;
}

module.exports = { matchOrders, initSpotTables, seedSpotMarkets };
