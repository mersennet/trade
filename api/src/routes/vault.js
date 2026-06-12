const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function validateAddress(addr) {
  return typeof addr === 'string' && ETH_ADDR_RE.test(addr);
}

router.get('/state', async (req, res) => {
  try {
    const state = await pool.query('SELECT * FROM vault_state WHERE id = 1');
    const s = state.rows[0];
    if (!s) return res.json({ totalShares: 0, totalTvl: 0, totalPnl: 0, apy7d: 0, apy30d: 0, depositors: 0, updatedAt: null });
    res.json({
      totalShares: Number(s.total_shares),
      totalTvl: Number(s.total_tvl),
      totalPnl: Number(s.total_pnl),
      apy7d: Number(s.apy_7d),
      apy30d: Number(s.apy_30d),
      depositors: s.depositors,
      updatedAt: s.updated_at,
    });
  } catch (e) {
    console.error('[vault] GET /state error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/user/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });

    const deposits = await pool.query(
      `SELECT action, amount, shares, vault_tvl_after, created_at
       FROM vault_deposits WHERE address = $1 ORDER BY created_at DESC LIMIT 50`,
      [addr]
    );

    const netShares = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN action = 'deposit' THEN shares ELSE -shares END), 0) as net_shares
       FROM vault_deposits WHERE address = $1`,
      [addr]
    );

    const state = await pool.query('SELECT total_shares, total_tvl FROM vault_state WHERE id = 1');
    const totalShares = Number(state.rows[0]?.total_shares || 1);
    const totalTvl = Number(state.rows[0]?.total_tvl || 0);
    const userShares = Number(netShares.rows[0]?.net_shares || 0);
    const userValue = totalShares > 0 ? (userShares / totalShares) * totalTvl : 0;

    res.json({
      address: addr,
      shares: userShares,
      value: userValue,
      shareOfVault: totalShares > 0 ? ((userShares / totalShares) * 100).toFixed(4) : '0',
      history: deposits.rows,
    });
  } catch (e) {
    console.error('[vault] GET /user error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/deposit', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { address, amount } = req.body;
    if (!address || !amount) return res.status(400).json({ error: 'Missing address or amount' });
    const addr = address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    const state = await client.query('SELECT total_shares, total_tvl FROM vault_state WHERE id = 1');
    if (!state.rows[0]) return res.status(500).json({ error: 'Vault not initialized' });
    const totalShares = Number(state.rows[0].total_shares);
    const totalTvl = Number(state.rows[0].total_tvl);
    const shares = totalShares === 0 ? amt : (amt / totalTvl) * totalShares;

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO vault_deposits (address, action, amount, shares, vault_tvl_after)
       VALUES ($1, 'deposit', $2, $3, $4)`,
      [addr, amt, shares, totalTvl + amt]
    );
    await client.query(
      `UPDATE vault_state SET total_shares = total_shares + $1, total_tvl = total_tvl + $2,
       depositors = (SELECT COUNT(DISTINCT address) FROM vault_deposits), updated_at = NOW() WHERE id = 1`,
      [shares, amt]
    );
    await client.query('COMMIT');

    res.json({ shares, newTvl: totalTvl + amt, timestamp: Date.now() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[vault] POST /deposit error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/withdraw', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { address, shares } = req.body;
    if (!address || !shares) return res.status(400).json({ error: 'Missing address or shares' });
    const addr = address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });
    const sharesToBurn = Number(shares);
    if (!Number.isFinite(sharesToBurn) || sharesToBurn <= 0) return res.status(400).json({ error: 'Shares must be positive' });

    const userShares = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN action='deposit' THEN shares ELSE -shares END), 0) as net
       FROM vault_deposits WHERE address = $1`,
      [addr]
    );
    if (Number(userShares.rows[0]?.net || 0) < sharesToBurn) {
      return res.status(400).json({ error: 'Insufficient shares' });
    }

    const state = await client.query('SELECT total_shares, total_tvl FROM vault_state WHERE id = 1');
    if (!state.rows[0]) return res.status(500).json({ error: 'Vault not initialized' });
    const totalShares = Number(state.rows[0].total_shares);
    const totalTvl = Number(state.rows[0].total_tvl);
    if (totalShares <= 0) return res.status(400).json({ error: 'No shares in vault' });
    const amount = (sharesToBurn / totalShares) * totalTvl;

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO vault_deposits (address, action, amount, shares, vault_tvl_after)
       VALUES ($1, 'withdraw', $2, $3, $4)`,
      [addr, amount, sharesToBurn, totalTvl - amount]
    );
    await client.query(
      `UPDATE vault_state SET total_shares = total_shares - $1, total_tvl = total_tvl - $2, updated_at = NOW() WHERE id = 1`,
      [sharesToBurn, amount]
    );
    await client.query('COMMIT');

    res.json({ amount, remainingTvl: totalTvl - amount, timestamp: Date.now() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[vault] POST /withdraw error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
