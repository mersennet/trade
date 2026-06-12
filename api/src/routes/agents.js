const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

// Must stay in sync with the strategy implementations in services/agentEngine.js
// (the keys of its exported `strategies` object). The web UI also uses these values.
const VALID_STRATEGIES = ['momentum', 'meanReversion', 'grid'];

// Normalize a stored agent row (markets/risk_limits may be JSON text or JSONB)
// and attach the pnl/trades aggregates the web client renders.
async function shapeAgent(row) {
  const markets = typeof row.markets === 'string' ? JSON.parse(row.markets || '[]') : (row.markets || []);
  const params = typeof row.params === 'string' ? JSON.parse(row.params || '{}') : (row.params || {});
  const risk_limits = typeof row.risk_limits === 'string' ? JSON.parse(row.risk_limits || '{}') : (row.risk_limits || {});
  const agg = await pool.query(
    `SELECT COUNT(*) AS trades, COALESCE(SUM(pnl), 0) AS pnl FROM agent_trades WHERE agent_id = $1`,
    [row.id]
  ).catch(() => ({ rows: [{ trades: 0, pnl: 0 }] }));
  return {
    ...row,
    markets,
    params,
    risk_limits,
    pnl: Number(agg.rows[0]?.pnl || 0),
    trades: Number(agg.rows[0]?.trades || 0),
  };
}

router.get('/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      'SELECT * FROM trading_agents WHERE owner = $1 ORDER BY created_at DESC',
      [addr]
    );
    const agents = await Promise.all(result.rows.map(shapeAgent));
    res.json({ address: addr, agents });
  } catch (e) {
    res.json({ address: req.params.address, agents: [] });
  }
});

router.post('/', strictLimiter, async (req, res) => {
  try {
    const { owner, name, strategy, markets, params, risk_limits } = req.body;
    if (!owner || !name || !strategy) {
      return res.status(400).json({ error: 'owner, name, and strategy are required' });
    }
    if (!Array.isArray(markets) || markets.length === 0) {
      return res.status(400).json({ error: 'at least one market is required' });
    }

    if (!VALID_STRATEGIES.includes(strategy)) {
      return res.status(400).json({
        error: `Invalid strategy. Must be one of: ${VALID_STRATEGIES.join(', ')}`,
      });
    }

    // The engine runs one market_id per agent; the full selection is kept in `markets`.
    const primaryMarket = Number(markets[0]);

    const result = await pool.query(
      `INSERT INTO trading_agents
       (owner, name, market_id, strategy, markets, params, risk_limits, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'stopped', NOW()) RETURNING *`,
      [
        owner.toLowerCase(), name, primaryMarket, strategy,
        JSON.stringify(markets),
        JSON.stringify(params || {}),
        JSON.stringify(risk_limits || { max_position: 10000, max_loss: 1000, max_drawdown: 0.1 }),
      ]
    );
    res.json({ agent: await shapeAgent(result.rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', strictLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { owner, name, markets, params, risk_limits } = req.body;
    if (!owner) return res.status(400).json({ error: 'owner required' });

    const existing = await pool.query(
      'SELECT * FROM trading_agents WHERE id = $1 AND owner = $2',
      [id, owner.toLowerCase()]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    if (existing.rows[0].status === 'running') {
      return res.status(400).json({ error: 'Stop agent before updating' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (name) { updates.push(`name = $${idx++}`); values.push(name); }
    if (Array.isArray(markets) && markets.length > 0) {
      updates.push(`markets = $${idx++}`); values.push(JSON.stringify(markets));
      updates.push(`market_id = $${idx++}`); values.push(Number(markets[0]));
    }
    if (params) { updates.push(`params = $${idx++}`); values.push(JSON.stringify(params)); }
    if (risk_limits) { updates.push(`risk_limits = $${idx++}`); values.push(JSON.stringify(risk_limits)); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE trading_agents SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json({ agent: await shapeAgent(result.rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/start', strictLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.body;
    if (!owner) return res.status(400).json({ error: 'owner required' });

    const agent = await pool.query(
      'SELECT * FROM trading_agents WHERE id = $1 AND owner = $2',
      [id, owner.toLowerCase()]
    );
    if (!agent.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    if (agent.rows[0].status === 'running') {
      return res.status(400).json({ error: 'Agent is already running' });
    }

    const result = await pool.query(
      "UPDATE trading_agents SET status = 'running', started_at = NOW() WHERE id = $1 RETURNING *",
      [id]
    );
    res.json({ agent: await shapeAgent(result.rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/stop', strictLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.body;
    if (!owner) return res.status(400).json({ error: 'owner required' });

    const agent = await pool.query(
      'SELECT * FROM trading_agents WHERE id = $1 AND owner = $2',
      [id, owner.toLowerCase()]
    );
    if (!agent.rows[0]) return res.status(404).json({ error: 'Agent not found' });
    if (agent.rows[0].status !== 'running') {
      return res.status(400).json({ error: 'Agent is not running' });
    }

    const result = await pool.query(
      "UPDATE trading_agents SET status = 'stopped', stopped_at = NOW() WHERE id = $1 RETURNING *",
      [id]
    );
    res.json({ agent: await shapeAgent(result.rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/performance', async (req, res) => {
  try {
    const { id } = req.params;

    const agent = await pool.query('SELECT * FROM trading_agents WHERE id = $1', [id]);
    if (!agent.rows[0]) return res.status(404).json({ error: 'Agent not found' });

    const trades = await pool.query(
      `SELECT COUNT(*) as total_trades,
              SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
              SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
              COALESCE(SUM(pnl), 0) as total_pnl,
              COALESCE(SUM(ABS(size * price)), 0) as total_volume
       FROM agent_trades WHERE agent_id = $1`,
      [id]
    );

    const recent = await pool.query(
      `SELECT created_at AS time, pnl, market_id, side
       FROM agent_trades WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );

    const stats = trades.rows[0];
    const totalTrades = Number(stats.total_trades);
    const totalPnl = Number(stats.total_pnl);
    // winRate as a percentage (0-100) to match the web client (perf.winRate.toFixed(1) + '%').
    const winRate = totalTrades > 0 ? (Number(stats.winning_trades) / totalTrades) * 100 : 0;
    const avgTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;

    // Equity-curve derived metrics (no realized PnL feed yet → 0 until agents trade).
    const pnls = recent.rows.map((r) => Number(r.pnl)).reverse();
    let peak = 0;
    let equity = 0;
    let maxDrawdown = 0;
    for (const p of pnls) {
      equity += p;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    let sharpe = 0;
    if (pnls.length > 1) {
      const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? mean / std : 0;
    }

    res.json({
      agentId: id,
      status: agent.rows[0].status,
      strategy: agent.rows[0].strategy,
      totalTrades,
      totalPnl,
      winRate,
      avgTrade,
      maxDrawdown,
      sharpe,
      trades: recent.rows.map((r) => ({
        time: r.time,
        pnl: Number(r.pnl),
        market_id: Number(r.market_id),
        side: r.side,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
