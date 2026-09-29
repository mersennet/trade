const pool = require('../db/pool');
const chain = require('./chain');

const strategies = {
  momentum(marketData, params) {
    const { prices } = marketData;
    const lookback = params.lookback || 10;
    if (prices.length < lookback + 1) return { action: 'hold', price: 0, size: 0 };

    const recent = prices.slice(-lookback);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    const change = (newest - oldest) / oldest;
    const threshold = params.threshold || 0.02;

    if (change > threshold) {
      return { action: 'buy', price: newest, size: params.size || 1 };
    }
    if (change < -threshold) {
      return { action: 'sell', price: newest, size: params.size || 1 };
    }
    return { action: 'hold', price: newest, size: 0 };
  },

  meanReversion(marketData, params) {
    const { prices } = marketData;
    const window = params.window || 20;
    if (prices.length < window) return { action: 'hold', price: 0, size: 0 };

    const slice = prices.slice(-window);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const current = prices[prices.length - 1];
    const deviation = (current - mean) / mean;
    const threshold = params.threshold || 0.03;

    if (deviation < -threshold) {
      return { action: 'buy', price: current, size: params.size || 1 };
    }
    if (deviation > threshold) {
      return { action: 'sell', price: current, size: params.size || 1 };
    }
    return { action: 'hold', price: current, size: 0 };
  },

  grid(marketData, params) {
    const { currentPrice } = marketData;
    const gridLow = params.gridLow || currentPrice * 0.95;
    const gridHigh = params.gridHigh || currentPrice * 1.05;
    const gridLevels = params.gridLevels || 10;
    const step = (gridHigh - gridLow) / gridLevels;

    const nearestLevel = gridLow + Math.round((currentPrice - gridLow) / step) * step;
    const diff = currentPrice - nearestLevel;

    if (diff < -step * 0.3) {
      return { action: 'buy', price: nearestLevel, size: params.size || 1 };
    }
    if (diff > step * 0.3) {
      return { action: 'sell', price: nearestLevel + step, size: params.size || 1 };
    }
    return { action: 'hold', price: currentPrice, size: 0 };
  },
};

function toHex(n) { return '0x' + BigInt(Math.round(n)).toString(16); }

async function fetchMarketData(marketId, lookback = 30) {
  const ba = await chain.getBestBidAsk(marketId);
  const bid = Number(ba.bestBid);
  const ask = Number(ba.bestAsk);
  const currentPrice = Number(await chain.getMarkPrice(marketId)) || 0;

  const { rows } = await pool.query(
    `SELECT price FROM agent_trades WHERE market_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [marketId, lookback]
  );
  const prices = rows.map(r => Number(r.price)).reverse();
  if (prices.length === 0 && currentPrice > 0) prices.push(currentPrice);

  return { currentPrice, prices, bestBid: bid, bestAsk: ask };
}

async function runAgent(agent) {
  const strategyFn = strategies[agent.strategy];
  if (!strategyFn) throw new Error(`Unknown strategy: ${agent.strategy}`);

  const params = typeof agent.params === 'string' ? JSON.parse(agent.params) : (agent.params || {});
  const marketData = await fetchMarketData(agent.market_id, params.lookback || 30);

  if (marketData.currentPrice <= 0) return { action: 'hold', reason: 'no market data' };

  const signal = strategyFn(marketData, params);

  if (signal.action === 'hold') return signal;

  try {
    const result = await chain.submitOrder({
      owner: agent.owner,
      market_id: agent.market_id,
      side: signal.action,
      price: toHex(signal.price),
      size: toHex(signal.size),
      tif: 'Gtc',
    });

    await pool.query(
      `INSERT INTO agent_trades (agent_id, market_id, side, price, size)
       VALUES ($1, $2, $3, $4, $5)`,
      [agent.id, agent.market_id, signal.action, signal.price, signal.size]
    );

    return { ...signal, orderId: result };
  } catch (e) {
    console.error(`[agentEngine] Order submission failed for agent #${agent.id}:`, e.message);
    return { ...signal, error: e.message };
  }
}

async function initAgentTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_agents (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      market_id INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      markets JSONB DEFAULT '[]',
      params JSONB DEFAULT '{}',
      risk_limits JSONB DEFAULT '{}',
      status TEXT DEFAULT 'stopped',
      started_at TIMESTAMP,
      stopped_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Tolerate pre-existing tables created before these columns were added.
  await pool.query(`ALTER TABLE trading_agents ADD COLUMN IF NOT EXISTS markets JSONB DEFAULT '[]'`).catch(() => {});
  await pool.query(`ALTER TABLE trading_agents ADD COLUMN IF NOT EXISTS risk_limits JSONB DEFAULT '{}'`).catch(() => {});
  await pool.query(`ALTER TABLE trading_agents ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE trading_agents ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMP`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_trades (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER REFERENCES trading_agents(id),
      market_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      price NUMERIC NOT NULL,
      size NUMERIC NOT NULL,
      pnl NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // The performance route aggregates SUM(pnl); tolerate tables created before this column.
  await pool.query(`ALTER TABLE agent_trades ADD COLUMN IF NOT EXISTS pnl NUMERIC DEFAULT 0`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_performance (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER REFERENCES trading_agents(id),
      total_trades INTEGER DEFAULT 0,
      total_pnl NUMERIC DEFAULT 0,
      win_rate NUMERIC DEFAULT 0,
      max_drawdown NUMERIC DEFAULT 0,
      sharpe_ratio NUMERIC DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

module.exports = { initAgentTables, runAgent, strategies };
