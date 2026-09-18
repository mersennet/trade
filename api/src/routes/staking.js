const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');
const { sendError } = require('../middleware/httpError');

const router = Router();
const UNBOND_DAYS = 7;
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function validateAddress(addr) {
  return typeof addr === 'string' && ETH_ADDR_RE.test(addr);
}

router.get('/state', async (req, res) => {
  try {
    const state = await pool.query('SELECT * FROM staking_state WHERE id = 1');
    const s = state.rows[0];
    if (!s) return res.json({ totalStaked: 0, totalRewardsDistributed: 0, rewardRate: 0, stakersCount: 0 });
    res.json({
      totalStaked: Number(s.total_staked),
      totalRewardsDistributed: Number(s.total_rewards_distributed),
      rewardRate: Number(s.reward_rate),
      stakersCount: s.stakers_count,
    });
  } catch (e) {
    console.error('[staking] GET /state error:', e.message);
    sendError(res, e, 'staking');
  }
});

router.get('/user/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });

    const bal = await pool.query('SELECT * FROM staking_balance WHERE address = $1', [addr]);
    const history = await pool.query(
      'SELECT action, amount, created_at FROM staking WHERE address = $1 ORDER BY created_at DESC LIMIT 50',
      [addr]
    );

    const b = bal.rows[0] || { staked: 0, rewards_pending: 0, unbonding: 0, unbond_available_at: null };
    res.json({
      address: addr,
      staked: Number(b.staked),
      rewardsPending: Number(b.rewards_pending),
      unbonding: Number(b.unbonding),
      unbondAvailableAt: b.unbond_available_at,
      history: history.rows,
    });
  } catch (e) {
    console.error('[staking] GET /user error:', e.message);
    sendError(res, e, 'staking');
  }
});

router.post('/stake', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { address, amount } = req.body;
    if (!address || !amount) return res.status(400).json({ error: 'Missing address or amount' });
    const addr = address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    await client.query('BEGIN');
    await client.query(
      "INSERT INTO staking (address, action, amount) VALUES ($1, 'stake', $2)",
      [addr, amt]
    );
    await client.query(
      `INSERT INTO staking_balance (address, staked) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET staked = staking_balance.staked + $2, updated_at = NOW()`,
      [addr, amt]
    );
    await client.query(
      `UPDATE staking_state SET total_staked = total_staked + $1,
       stakers_count = (SELECT COUNT(*) FROM staking_balance WHERE staked > 0), updated_at = NOW() WHERE id = 1`,
      [amt]
    );
    await client.query('COMMIT');

    res.json({ staked: amt, timestamp: Date.now() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[staking] POST /stake error:', e.message);
    sendError(res, e, 'staking');
  } finally {
    client.release();
  }
});

router.post('/unstake', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { address, amount } = req.body;
    if (!address || !amount) return res.status(400).json({ error: 'Missing address or amount' });
    const addr = address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    const bal = await client.query('SELECT staked FROM staking_balance WHERE address = $1', [addr]);
    if (!bal.rows[0] || Number(bal.rows[0].staked) < amt) {
      return res.status(400).json({ error: 'Insufficient staked balance' });
    }

    const unbondDate = new Date(Date.now() + UNBOND_DAYS * 86400 * 1000);

    await client.query('BEGIN');
    await client.query("INSERT INTO staking (address, action, amount) VALUES ($1, 'unstake', $2)", [addr, amt]);
    await client.query(
      `UPDATE staking_balance SET staked = staked - $2, unbonding = unbonding + $2,
       unbond_available_at = $3, updated_at = NOW() WHERE address = $1`,
      [addr, amt, unbondDate]
    );
    await client.query(
      'UPDATE staking_state SET total_staked = total_staked - $1, updated_at = NOW() WHERE id = 1',
      [amt]
    );
    await client.query('COMMIT');

    res.json({ unstaked: amt, availableAt: unbondDate, timestamp: Date.now() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[staking] POST /unstake error:', e.message);
    sendError(res, e, 'staking');
  } finally {
    client.release();
  }
});

router.post('/claim', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    const addr = address.toLowerCase();
    if (!validateAddress(addr)) return res.status(400).json({ error: 'Invalid address' });

    const bal = await client.query('SELECT rewards_pending FROM staking_balance WHERE address = $1', [addr]);
    const pending = Number(bal.rows[0]?.rewards_pending || 0);
    if (pending <= 0) return res.status(400).json({ error: 'No rewards to claim' });

    await client.query('BEGIN');
    await client.query("INSERT INTO staking (address, action, amount) VALUES ($1, 'claim', $2)", [addr, pending]);
    await client.query('UPDATE staking_balance SET rewards_pending = 0, updated_at = NOW() WHERE address = $1', [addr]);
    await client.query('COMMIT');

    res.json({ claimed: pending, timestamp: Date.now() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[staking] POST /claim error:', e.message);
    sendError(res, e, 'staking');
  } finally {
    client.release();
  }
});

module.exports = router;
