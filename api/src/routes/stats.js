const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');
const { FEE_TIERS } = require('../services/feeTiers');

const router = Router();

async function handleStats(req, res) {
  try {
    // trades.price and trades.size are plain integer chain units.
    const VOL_DIV = '1.0';
    const [vol24h, vol7d, totalTrades, uniqueTraders, blockNum] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(price * size) / ${VOL_DIV}, 0)::float8 as v FROM trades WHERE block_timestamp > NOW() - interval '24 hours'`),
      pool.query(`SELECT COALESCE(SUM(price * size) / ${VOL_DIV}, 0)::float8 as v FROM trades WHERE block_timestamp > NOW() - interval '7 days'`),
      pool.query('SELECT COUNT(*) as c FROM trades'),
      pool.query('SELECT COUNT(DISTINCT taker) as c FROM trades'),
      chain.getBlockNumber().catch(() => 0),
    ]);

    // Read real on-chain values; fall back to mocked DB tables if RPC fails.
    // The DB rows are placeholders for the not-yet-launched LP yield-vault.
    const [vaultStateDb, stakingStateDb, insuranceFund, vaultTvl] = await Promise.all([
      pool.query('SELECT total_tvl FROM vault_state WHERE id = 1').catch(() => ({ rows: [] })),
      pool.query('SELECT total_staked FROM staking_state WHERE id = 1').catch(() => ({ rows: [] })),
      chain.getInsuranceFundUsd().catch(() => 0),
      chain.getVaultTvlUsd().catch(() => 0),
    ]);

    let openInterest = 0;
    try {
      const oiResult = await pool.query(
        `SELECT COALESCE(SUM(ABS(t.size) * t.price) / ${VOL_DIV}, 0)::float8 as oi
         FROM (
           SELECT DISTINCT ON (market_id, taker) market_id, taker, size, price
           FROM trades ORDER BY market_id, taker, block_timestamp DESC
         ) t`
      );
      openInterest = Number(oiResult.rows[0]?.oi || 0);
    } catch (_) {}

    res.json({
      volume24h: Number(vol24h.rows[0].v),
      volume7d: Number(vol7d.rows[0].v),
      totalTrades: Number(totalTrades.rows[0].c),
      uniqueTraders: Number(uniqueTraders.rows[0].c),
      markets: chain.MARKETS.length,
      blockHeight: blockNum,
      // vaultTvl: real USDC held by collateral Vault contract (on-chain).
      vaultTvl,
      // totalStaked: from staking_state DB (mocked until staking launches).
      totalStaked: Number(stakingStateDb.rows[0]?.total_staked || 0),
      // insuranceFund: real on-chain Vault.insuranceFund() balance in USDC.
      insuranceFund,
      feeTiers: FEE_TIERS,
      openInterest,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

router.get('/', handleStats);
router.get('/stats', handleStats);

router.get('/balance/:address', async (req, res) => {
  try {
    const balance = await chain.getBalance(req.params.address);
    res.json({ balance, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/block', async (req, res) => {
  try {
    const block = await chain.getBlockNumber();
    res.json({ blockNumber: block, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const block = await chain.getBlockNumber();
    res.json({ status: 'healthy', db: 'connected', chainBlock: block, timestamp: Date.now() });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// /status — read-only mirror of the watchdog snapshot. Aggregates all critical
// signals (services, oracle, balances, disk, backups). Updated every minute by
// the systemd timer; falls back to live DB+chain probe if no snapshot present.
const fs = require('fs');
const STATUS_FILE = process.env.HEALTH_STATUS_FILE || '/var/log/mersennet-trade-health.json';
router.get('/status', async (req, res) => {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const raw = fs.readFileSync(STATUS_FILE, 'utf8');
      const snap = JSON.parse(raw);
      const ageSec = Math.floor((Date.now() - new Date(snap.timestamp).getTime()) / 1000);
      const stale = ageSec > 180;
      return res.status(snap.ok && !stale ? 200 : 503).json({
        ...snap,
        snapshot_age_s: ageSec,
        stale,
      });
    }
    await pool.query('SELECT 1');
    const block = await chain.getBlockNumber();
    res.json({ ok: true, fallback: true, db: 'connected', chainBlock: block, timestamp: Date.now() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

router.handleStats = handleStats;
module.exports = router;
