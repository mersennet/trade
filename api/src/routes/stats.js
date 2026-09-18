const { Router } = require('express');
const pool = require('../db/pool');
const chain = require('../services/chain');
const { FEE_TIERS, FEES_CHARGED } = require('../services/feeTiers');
const { sendError } = require('../middleware/httpError');

const router = Router();

// The aggregates below scan the whole trades table (COUNT, COUNT DISTINCT,
// 24 h / 7 d sums, DISTINCT ON) and took 0.9–1.9 s per call while every open
// terminal tab polled twice every 5 s. Compute at most once per STATS_TTL_MS
// and share the in-flight promise; the block height is refreshed per request
// because it is cheap and the status chips want it fresh.
const STATS_TTL_MS = Number(process.env.STATS_TTL_MS || 10_000);
let statsCache = { at: 0, body: null, inflight: null };

async function computeStats() {
  // Notional = price × size ÷ the market's priceScale (chain prices are human × scale).
  const VOL_DIV = chain.priceScaleSql('market_id');
  const [vol24h, vol7d, totalTrades, uniqueTraders] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(price * size / ${VOL_DIV}), 0)::float8 as v FROM trades WHERE block_timestamp > NOW() - interval '24 hours'`),
    pool.query(`SELECT COALESCE(SUM(price * size / ${VOL_DIV}), 0)::float8 as v FROM trades WHERE block_timestamp > NOW() - interval '7 days'`),
    pool.query('SELECT COUNT(*) as c FROM trades'),
    pool.query('SELECT COUNT(DISTINCT taker) as c FROM trades'),
  ]);
  const [stakingStateDb, insuranceFund, vaultTvl] = await Promise.all([
    pool.query('SELECT total_staked FROM staking_state WHERE id = 1').catch(() => ({ rows: [] })),
    chain.getInsuranceFundUsd().catch(() => 0),
    chain.getVaultTvlUsd().catch(() => 0),
  ]);
  let openInterest = 0;
  try {
    const oiResult = await pool.query(
      `SELECT COALESCE(SUM(ABS(t.size) * t.price / ${chain.priceScaleSql('t.market_id')}), 0)::float8 as oi
       FROM (
         SELECT DISTINCT ON (market_id, taker) market_id, taker, size, price
         FROM trades ORDER BY market_id, taker, block_timestamp DESC
       ) t`
    );
    openInterest = Number(oiResult.rows[0]?.oi || 0);
  } catch (_) {}
  return {
    volume24h: Number(vol24h.rows[0].v),
    volume7d: Number(vol7d.rows[0].v),
    totalTrades: Number(totalTrades.rows[0].c),
    uniqueTraders: Number(uniqueTraders.rows[0].c),
    vaultTvl,
    totalStaked: Number(stakingStateDb.rows[0]?.total_staked || 0),
    insuranceFund,
    openInterest,
  };
}

async function cachedStats() {
  const now = Date.now();
  if (statsCache.body && now - statsCache.at < STATS_TTL_MS) return statsCache.body;
  if (!statsCache.inflight) {
    statsCache.inflight = computeStats()
      .then((body) => { statsCache = { at: Date.now(), body, inflight: null }; return body; })
      .catch((e) => { statsCache.inflight = null; throw e; });
  }
  // A stale body is better than a 1 s wait while the refresh runs.
  return statsCache.body || statsCache.inflight;
}

// Keep the cache warm so no request ever pays for the aggregate (first call
// after a restart included): refresh in the background every TTL.
setTimeout(() => cachedStats().catch(() => {}), 1500);
setInterval(() => { statsCache.at = 0; cachedStats().catch(() => {}); }, STATS_TTL_MS).unref?.();

async function handleStats(req, res) {
  try {
    const [agg, blockNum] = await Promise.all([cachedStats(), chain.getBlockNumber().catch(() => 0)]);
    res.set('Cache-Control', 'public, max-age=5');
    return res.json({
      volume24h: agg.volume24h,
      volume7d: agg.volume7d,
      totalTrades: agg.totalTrades,
      uniqueTraders: agg.uniqueTraders,
      markets: chain.MARKETS.length,
      blockHeight: blockNum,
      vaultTvl: agg.vaultTvl,
      totalStaked: agg.totalStaked,
      insuranceFund: agg.insuranceFund,
      feeTiers: FEE_TIERS,
      // false on the testnet: the engine charges no maker/taker fee; the tiers are the planned schedule.
      feesCharged: FEES_CHARGED,
      openInterest: agg.openInterest,
      statsAgeMs: Date.now() - statsCache.at,
      timestamp: Date.now(),
    });
  } catch (e) {
    return sendError(res, e, 'stats');
  }
}

router.get('/', handleStats);
router.get('/stats', handleStats);

router.get('/balance/:address', async (req, res) => {
  try {
    const balance = await chain.getBalance(req.params.address);
    res.json({ balance, timestamp: Date.now() });
  } catch (e) {
    sendError(res, e, 'stats');
  }
});

router.get('/block', async (req, res) => {
  try {
    const block = await chain.getBlockNumber();
    res.json({ blockNumber: block, timestamp: Date.now() });
  } catch (e) {
    sendError(res, e, 'stats');
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
