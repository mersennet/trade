const pool = require('../db/pool');

const SYNTHETIC_MARKETS = [
  { symbol: 'AAPL',   name: 'Apple Inc.',         basePrice: 230,  category: 'equity' },
  { symbol: 'TSLA',   name: 'Tesla Inc.',          basePrice: 280,  category: 'equity' },
  { symbol: 'GOLD',   name: 'Gold Spot',           basePrice: 2650, category: 'commodity' },
  { symbol: 'OIL',    name: 'Crude Oil WTI',       basePrice: 78,   category: 'commodity' },
  { symbol: 'SPX500', name: 'S&P 500 Index',       basePrice: 5900, category: 'index' },
];

function jitter(base, pct = 0.005) {
  const swing = base * pct;
  return +(base + (Math.random() * 2 - 1) * swing).toFixed(2);
}

function fetchEquityPrices() {
  const prices = {};
  for (const m of SYNTHETIC_MARKETS) {
    prices[m.symbol] = {
      symbol: m.symbol,
      name: m.name,
      price: jitter(m.basePrice),
      bid: jitter(m.basePrice, 0.003),
      ask: jitter(m.basePrice, 0.003),
      change24h: +((Math.random() * 4 - 2).toFixed(2)),
      volume24h: Math.round(Math.random() * 1_000_000 + 100_000),
      timestamp: Date.now(),
    };
  }
  return prices;
}

async function initSyntheticTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS synthetic_markets (
      id SERIAL PRIMARY KEY,
      symbol TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      base_price NUMERIC NOT NULL,
      current_price NUMERIC,
      funding_rate NUMERIC DEFAULT 0.01,
      max_leverage INTEGER DEFAULT 20,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS synthetic_positions (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      market_id INTEGER REFERENCES synthetic_markets(id),
      side TEXT NOT NULL,
      size NUMERIC NOT NULL,
      entry_price NUMERIC NOT NULL,
      leverage INTEGER DEFAULT 1,
      margin NUMERIC NOT NULL,
      liquidation_price NUMERIC,
      pnl NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function seedSyntheticMarkets() {
  for (const m of SYNTHETIC_MARKETS) {
    await pool.query(
      `INSERT INTO synthetic_markets (symbol, name, category, base_price, current_price)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (symbol) DO UPDATE SET
         current_price = EXCLUDED.current_price,
         updated_at = NOW()`,
      [m.symbol, m.name, m.category, m.basePrice, jitter(m.basePrice)]
    );
  }
}

module.exports = {
  SYNTHETIC_MARKETS,
  fetchEquityPrices,
  initSyntheticTables,
  seedSyntheticMarkets,
};
