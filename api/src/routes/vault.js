const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function validateAddress(addr) {
  return typeof addr === 'string' && ETH_ADDR_RE.test(addr);
}

// The vault is an on-chain contract now (MakerVault). Deposits and
// withdrawals are wallet-signed transactions to it; the indexer tails its
// events into vault_deposits / vault_state. These endpoints tell old clients.
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0x2ccc6FB9a1853Ad4C217047CC74Bd0D032325284';
const gone = (_req, res) => res.status(410).json({
  error: 'The strategy vault is on-chain: send deposit()/withdraw(shares) to the MakerVault contract from your wallet.',
  vault: VAULT_ADDRESS,
});
router.post('/deposit', strictLimiter, gone);
router.post('/withdraw', strictLimiter, gone);

router.get('/info', (_req, res) => res.json({
  address: VAULT_ADDRESS,
  symbol: 'mvMRSN',
  asset: 'MRSN',
  minDepositMrsn: 1,
  reserveBps: Number(process.env.VAULT_RESERVE_BPS || 1000),
  lpPointsPerMrsnDay: Number(process.env.LP_POINTS_PER_MRSN_DAY || 0.1),
}));

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
      `SELECT action, amount, shares, vault_tvl_after, created_at, tx_hash
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
      lpPoints: await pool.query('SELECT COALESCE(SUM(lp_points), 0)::float8 AS p FROM points_balance WHERE address = $1', [addr]).then((r) => Number(r.rows[0].p)).catch(() => 0),
      history: deposits.rows,
    });
  } catch (e) {
    console.error('[vault] GET /user error:', e.message);
    res.status(500).json({ error: e.message });
  }
});



module.exports = router;
