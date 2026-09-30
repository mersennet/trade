require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const http = require('http');

const { apiLimiter } = require('./src/middleware/rateLimit');
const { apiKeyAuth } = require('./src/middleware/apiKey');
const { metricsMiddleware, getMetrics, prometheusFormat } = require('./src/middleware/metrics');
const { setupWebSocket } = require('./src/ws');

const marketsRouter = require('./src/routes/markets');
const candlesRouter = require('./src/routes/candles');
const tradesRouter = require('./src/routes/trades');
const positionsRouter = require('./src/routes/positions');
const ordersRouter = require('./src/routes/orders');
const collateralRouter = require('./src/routes/collateral');
const leaderboardRouter = require('./src/routes/leaderboard');
const pointsRouter = require('./src/routes/points');
const vaultRouter = require('./src/routes/vault');
const stakingRouter = require('./src/routes/staking');
const competitionsRouter = require('./src/routes/competitions');
const builderCodesRouter = require('./src/routes/builderCodes');
const apiKeysRouter = require('./src/routes/apiKeys');
const statsRouter = require('./src/routes/stats');
const governanceRouter = require('./src/routes/governance');

const { initConditionalOrdersTable, startPriceMonitor } = require('./src/services/conditionalOrders');

const spotRouter = require('./src/routes/spot');
const optionsRouter = require('./src/routes/options');
const prelaunchRouter = require('./src/routes/prelaunch');
const whalesRouter = require('./src/routes/whales');
const agentsRouter = require('./src/routes/agents');
const otcRouter = require('./src/routes/otc');
const bridgeRouter = require('./src/routes/bridge');
const marketListingRouter = require('./src/routes/marketListing');
const oracleRouter = require('./src/routes/oracle');
const paperRouter = require('./src/routes/paper');
const fundingArbRouter = require('./src/routes/fundingArb');
const authRouter = require('./src/routes/auth');

const { initTwapTables, startTwapEngine } = require('./src/services/twapEngine');
const { initSpotTables, seedSpotMarkets } = require('./src/services/spotEngine');
const { initOptionsTables, seedOptionContracts } = require('./src/services/optionsEngine');
const { initAgentTables } = require('./src/services/agentEngine');
const { initBridgeTables } = require('./src/services/bridgeMonitor');
const { initOracleCache } = require('./src/services/oracle');
const { initSyntheticTables, seedSyntheticMarkets } = require('./src/services/externalFeeds');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4005;

// CORS is handled by the front-facing Caddy (strict origin allowlist).
// We only enable cors() here for direct dev use (when not behind Caddy).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://trade.mersennet.com,https://explorer.mersennet.com,http://localhost:3000,http://localhost:3004')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, false); // no Origin header → no CORS headers
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400,
}));

// Hide implementation details
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use(express.json({ limit: '256kb' }));
app.use(metricsMiddleware);
app.use(apiLimiter);
app.use(apiKeyAuth);

app.get('/metrics', (req, res) => {
  const authKey = req.headers['x-metrics-key'];
  if (process.env.METRICS_KEY && authKey !== process.env.METRICS_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.set('Content-Type', 'text/plain');
  res.send(prometheusFormat());
});
app.get('/api/v1/metrics', (req, res) => {
  const authKey = req.headers['x-metrics-key'];
  if (process.env.METRICS_KEY && authKey !== process.env.METRICS_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(getMetrics());
});

app.get('/api/v1/stats', require('./src/routes/stats').handleStats);

// ── Write gates (registered before the routers so they win) ─────────────────
// Retired unsigned writers: nothing live calls them and each accepted an
// arbitrary owner/address. Reads on the same routers keep working.
const { retired, previewWrites } = require('./src/middleware/writeGates');
const ON_CHAIN = 'Retired: staking is on-chain — call the staking precompile (0x…0400) from your wallet or use trade.mersennet.com/staking.';
app.post('/api/v1/staking/stake', retired(ON_CHAIN));
app.post('/api/v1/staking/unstake', retired(ON_CHAIN));
app.post('/api/v1/staking/claim', retired(ON_CHAIN));
const CLIENT_SIDE = 'Retired: stop, trailing and TWAP orders are armed and executed in the terminal (browser-side, with your one-click key); the API no longer stores them. Limit and market orders are wallet-signed placeOrder transactions to the CLOB precompile (0x…0100).';
app.post('/api/v1/orders', retired(CLIENT_SIDE));
app.post('/api/v1/orders/twap', retired(CLIENT_SIDE));
app.delete('/api/v1/orders/twap/:id', retired(CLIENT_SIDE));
app.post('/api/v1/orders/:orderId/cancel-conditional', retired(CLIENT_SIDE));
app.post('/api/v1/orders/cancel-all/:address', retired(CLIENT_SIDE));
app.delete('/api/v1/orders/:orderId', retired(CLIENT_SIDE));
const NO_KEYS = 'Retired: no API key is needed — every read is public (600 req/min per IP) and every write is a wallet-signed transaction to the chain.';
app.post('/api/v1/api-keys', retired(NO_KEYS));
app.delete('/api/v1/api-keys/:id', retired(NO_KEYS));
// Roadmap previews: reads stay, unsigned writes answer 410 unless PREVIEW_WRITES=1.
for (const p of ['governance', 'market-listing', 'competitions', 'whales', 'otc', 'options', 'spot', 'prelaunch', 'bridge', 'agents', 'paper']) {
  app.use(`/api/v1/${p}`, previewWrites);
}

app.use('/api/v1/markets', marketsRouter);
app.use('/api/v1/candles', candlesRouter);
app.use('/api/v1/trades', tradesRouter);
app.use('/api/v1/positions', positionsRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/v1/collateral', collateralRouter);
app.use('/api/v1/leaderboard', leaderboardRouter);
app.use('/api/v1/points', pointsRouter);
app.use('/api/v1/vault', vaultRouter);
app.use('/api/v1/staking', stakingRouter);
app.use('/api/v1/competitions', competitionsRouter);
app.use('/api/v1/builder-codes', builderCodesRouter);
app.use('/api/v1/referrals', require('./src/routes/referrals'));
app.use('/api/v1/api-keys', apiKeysRouter);
app.use('/api/v1/governance', governanceRouter);
app.use('/api/v1/stats/launch', require('./src/routes/launch'));
app.use('/api/v1/stats/adoption', require('./src/routes/adoption'));
// Live CLOB protocol parameters (switch heights, margin bps, wei per unit) —
// the terminal and bots read this instead of hard-coding heights.
app.get('/api/v1/protocol', async (_req, res) => {
  try {
    const p = await require('./src/services/chain').getProtocol();
    if (!p) return res.status(503).json({ error: 'node unavailable' });
    res.set('Cache-Control', 'public, max-age=15');
    res.json(p);
  } catch (e) { res.status(503).json({ error: e.message }); }
});
// Upcoming protocol switches with ETAs from the observed block time (the
// terminal's staking panel, the explorer and the reminder bot read this).
app.get('/api/v1/protocol/switches', async (_req, res) => {
  try {
    const out = await require('./src/services/chain').upcomingSwitches();
    res.set('Cache-Control', 'public, max-age=30');
    res.json(out);
  } catch (e) { res.status(503).json({ error: e.message }); }
});
// Protocol upgrades as a record: upcoming (live ETA + the announced one) and
// completed (actual activation time from the block, against the estimates
// that were shown). Explorer /upgrades page and the terminal's staking panel.
app.get('/api/v1/protocol/upgrades', async (_req, res) => {
  try {
    const out = await require('./src/services/upgrades').report();
    res.set('Cache-Control', 'public, max-age=20');
    res.json(out);
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.use('/api/v1/stats', statsRouter);
app.use('/api/v1', statsRouter);
app.use('/api/v1/spot', spotRouter);
app.use('/api/v1/options', optionsRouter);
app.use('/api/v1/prelaunch', prelaunchRouter);
app.use('/api/v1/whales', whalesRouter);
app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/otc', otcRouter);
app.use('/api/v1/bridge', bridgeRouter);
app.use('/api/v1/market-listing', marketListingRouter);
app.use('/api/v1/oracle', oracleRouter);
app.use('/api/v1/paper', paperRouter);
app.use('/api/v1/funding-arb', fundingArbRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/feedback', require('./src/routes/feedback'));
app.use('/api/v1/client-errors', require('./src/routes/clientErrors'));
app.use('/api/v1/nodes', require('./src/routes/nodes'));
app.use('/api/v1/alerts', require('./src/routes/alerts'));

app.get('/api/v1/health', async (req, res) => {
  const pool = require('./src/db/pool');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', version: '2.0.0', timestamp: Date.now() });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
  }
});

// Block production health: average block interval over the last ~150
// blocks and head freshness. A dead or unreachable leader costs a failover
// round per slot (8 s from block 1,440,000, 19 s before), so a flapping
// validator shows up here as a slow chain long before anything else fails.
// Kuma keys on `"ok":true`.
// Every open terminal tab polls this every 5 s, so the answer is computed at
// most once per 2 s (one in-flight probe shared by all callers) — a thousand
// tabs cost the RPC node the same as one.
const CHAIN_HEALTH_TTL_MS = 2000;
let chainHealthCache = { at: 0, body: null, status: 200, inflight: null };
async function probeChainHealth() {
  const { rpcCall } = require('./src/services/chain');
  const head = await rpcCall('eth_getBlockByNumber', ['latest', false]);
  const headNum = parseInt(head.number, 16);
  const span = 150;
  const older = await rpcCall('eth_getBlockByNumber', ['0x' + Math.max(0, headNum - span).toString(16), false]);
  const headTs = parseInt(head.timestamp, 16);
  const olderTs = older ? parseInt(older.timestamp, 16) : headTs;
  const blocks = headNum - (older ? parseInt(older.number, 16) : headNum);
  const avgBlockMs = blocks > 0 ? Math.round(((headTs - olderTs) * 1000) / blocks) : null;
  const headAgeSec = Math.max(0, Math.floor(Date.now() / 1000) - headTs);
  const ok = avgBlockMs !== null && avgBlockMs <= 3000 && headAgeSec <= 30;
  return { status: ok ? 200 : 503, body: { ok, head: headNum, headAgeSec, avgBlockMs, window: blocks, timestamp: Date.now() } };
}
app.get('/api/v1/health/chain', async (req, res) => {
  const now = Date.now();
  if (chainHealthCache.body && now - chainHealthCache.at < CHAIN_HEALTH_TTL_MS) {
    return res.status(chainHealthCache.status).json(chainHealthCache.body);
  }
  if (!chainHealthCache.inflight) {
    chainHealthCache.inflight = probeChainHealth()
      .then((r) => { chainHealthCache = { at: Date.now(), body: r.body, status: r.status, inflight: null }; return r; })
      .catch((e) => { chainHealthCache.inflight = null; throw e; });
  }
  try {
    const r = await chainHealthCache.inflight;
    res.status(r.status).json(r.body);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'chain RPC unreachable' });
  }
});

// Open validator set liveness for the status page: the engine's epoch must
// equal floor(height / epochBlocks) once the set is active — a lagging epoch
// means transitions stopped firing (or the fleet disagrees on the set). Kuma
// keys on `"ok":true`.
app.get('/api/v1/health/validator-set', async (req, res) => {
  const { rpcCall } = require('./src/services/chain');
  try {
    const v = await rpcCall('mersennet_validatorSet', []);
    const epochBlocks = Number(v?.params?.epochBlocks || 0);
    const height = Number(v?.height || 0);
    const expectedEpoch = epochBlocks ? Math.floor(height / epochBlocks) : null;
    const active = v?.active === true;
    const activeSet = Array.isArray(v?.activeSet) ? v.activeSet : [];
    const consensus = Array.isArray(v?.consensusValidators) ? v.consensusValidators : [];
    const setsAgree = active
      ? activeSet.length === consensus.length && activeSet.every((a) => consensus.includes(a))
      : true;
    const ok = active && Number(v?.epoch) === expectedEpoch && activeSet.length >= 3 && setsAgree;
    res.status(ok ? 200 : 503).json({
      ok,
      active,
      height,
      epoch: v?.epoch ?? null,
      expectedEpoch,
      nextEpochAt: v?.nextEpochAt ?? null,
      activationHeight: v?.params?.activationHeight ?? null,
      activeSet: activeSet.length,
      consensusValidators: consensus.length,
      setsAgree,
      registered: Array.isArray(v?.validators) ? v.validators.length : 0,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Exchange liveness — fills, order-book revert ratio, maker quoting, vault
// collateral pushed, indexer lag (src/services/exchangeHealth.js). The
// 20–25 Sep outage (every maker order reverting, zero fills for five days)
// passed every other probe here. Kuma keys on `"ok":true`.
app.get('/api/v1/health/exchange', async (req, res) => {
  try {
    const r = await require('./src/services/exchangeHealth').exchangeHealth();
    res.status(r.status).json(r.body);
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/**
 * Are the ACTIVE validators on the current node release? Red (503) only when
 * it matters: an active validator is on an older build and a consensus switch
 * height is less than SWITCH_WARN_HOURS away (or already passed). Kuma posts
 * this to the ops group; the staking page tells the operator the same thing.
 */
app.get('/api/v1/health/validators-current', async (req, res) => {
  const { rpcCall } = require('./src/services/chain');
  const nodes = require('./src/routes/nodes');
  const SWITCH_WARN_HOURS = Number(process.env.SWITCH_WARN_HOURS || 48);
  try {
    const [v, latest, agents, proto] = await Promise.all([
      rpcCall('mersennet_validatorSet', []),
      nodes.latestReleaseSha(),
      rpcCall('mersennet_orders_getAgents', ['0x0000000000000000000000000000000000000000']).catch(() => null),
      rpcCall('mersennet_orders_getProtocol', []).catch(() => null),
    ]);
    const height = Number(v?.height || 0);
    const p = v?.params || {};
    // Every consensus switch the node exposes: validator-set params, the
    // agent/frame-caller heights, and everything getProtocol lists under
    // `switches` (settlement, revert reasons, fee floor, …) — a switch missing
    // here is a switch this monitor stays green through.
    const switches = [
      p.rewardsToOperatorHeight, p.jailEscalationHeight, p.benchHeight,
      agents?.agentDelegationHeight, agents?.frameCallerHeight,
      ...Object.values(proto?.switches || {}),
    ].map(Number).filter((h) => h > height);
    const nextSwitch = switches.length ? Math.min(...switches) : null;
    const hoursToSwitch = nextSwitch ? ((nextSwitch - height) * 2.1) / 3600 : null;
    const activeIds = (v?.validators || []).filter((x) => x.status === 'active').map((x) => ({ identity: String(x.identity).toLowerCase(), operator: x.operator }));
    const r = await require('./src/db/pool').query('SELECT identity, version FROM verified_nodes');
    const byId = new Map(r.rows.map((n) => [String(n.identity).toLowerCase(), n.version]));
    const report = activeIds.map((a) => {
      // Verified community nodes first, then anything that answered whoami
      // (fleet validators have no operator and live only in the build registry).
      const version = byId.get(a.identity) || nodes.knownBuildOf(a.identity)?.version || null;
      const build = nodes.buildShaOf(version);
      return { identity: a.identity, operator: a.operator, version, build, outdated: !!latest && !!build && build !== latest, unknown: !version };
    });
    const outdated = report.filter((x) => x.outdated);
    const urgent = outdated.length > 0 && hoursToSwitch !== null && hoursToSwitch <= SWITCH_WARN_HOURS;
    const ok = !urgent;
    res.status(ok ? 200 : 503).json({
      ok, latest, height, nextSwitch, hoursToSwitch: hoursToSwitch === null ? null : Math.round(hoursToSwitch * 10) / 10,
      active: report.length, outdated: outdated.length, unknown: report.filter((x) => x.unknown).length,
      validators: report, timestamp: Date.now(),
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

setupWebSocket(server);

const pool = require('./src/db/pool');

async function initGovernanceTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS governance_proposals (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      proposer TEXT,
      for_votes BIGINT DEFAULT 0,
      against_votes BIGINT DEFAULT 0,
      status TEXT DEFAULT 'active',
      end_time TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE governance_proposals ADD COLUMN IF NOT EXISTS proposer TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS governance_votes (
      id SERIAL PRIMARY KEY,
      proposal_id INTEGER REFERENCES governance_proposals(id),
      voter TEXT NOT NULL,
      direction TEXT NOT NULL,
      voting_power BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(proposal_id, voter)
    )
  `);
}

async function seedCompetitions() {
  const count = await pool.query('SELECT COUNT(*) as c FROM competitions');
  if (Number(count.rows[0]?.c || 0) > 0) return;
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 86400000);
  await pool.query(
    `INSERT INTO competitions (name, description, comp_type, start_at, end_at, prize_pool, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['Weekly PnL Challenge', 'Compete for the highest PnL over 7 days. Top 3 win prizes from the pool.', 'pnl', now.toISOString(), weekEnd.toISOString(), 10000, 'active']
  );
  const monthEnd = new Date(now.getTime() + 30 * 86400000);
  await pool.query(
    `INSERT INTO competitions (name, description, comp_type, start_at, end_at, prize_pool, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['Volume Marathon', 'Trade the most volume across all markets. Top 10 share the prize pool.', 'volume', now.toISOString(), monthEnd.toISOString(), 25000, 'active']
  );
  const futureStart = new Date(now.getTime() + 7 * 86400000);
  const futureEnd = new Date(now.getTime() + 14 * 86400000);
  await pool.query(
    `INSERT INTO competitions (name, description, comp_type, start_at, end_at, prize_pool, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['ROI Sprint', 'Maximize your return on investment. Starts next week — deposit required to enter.', 'pnl', futureStart.toISOString(), futureEnd.toISOString(), 50000, 'upcoming']
  );
  console.log('[api] Seeded 3 competitions');
}

// The markets table is read by whales/funding-arb/otc joins but was seeded by
// hand on the host — sync it from chain.MARKETS at boot so symbol renames land.
async function syncMarketsTable() {
  const { MARKETS } = require('./src/services/chain');
  await pool.query(`CREATE TABLE IF NOT EXISTS markets (id INT PRIMARY KEY, symbol TEXT NOT NULL, base TEXT, quote TEXT, max_leverage INT)`);
  await pool.query(`ALTER TABLE markets ADD COLUMN IF NOT EXISTS base TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE markets ADD COLUMN IF NOT EXISTS quote TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE markets ADD COLUMN IF NOT EXISTS max_leverage INT`).catch(() => {});
  for (const m of MARKETS) {
    const r = await pool.query(
      `UPDATE markets SET symbol = $2, base = $3, quote = $4, max_leverage = $5 WHERE id = $1`,
      [m.id, m.symbol, m.base, m.quote, m.maxLeverage]
    );
    if (r.rowCount === 0) {
      await pool.query(
        `INSERT INTO markets (id, symbol, base, quote, max_leverage) VALUES ($1, $2, $3, $4, $5)`,
        [m.id, m.symbol, m.base, m.quote, m.maxLeverage]
      );
    }
  }
}

async function initAllTables() {
  // Open interest from chain positions (every minute; the ticker reads the snapshot).
  try { require('./src/services/openInterest').start(); console.log('[api] Open-interest snapshot started'); } catch (e) { console.log('[api] OI start:', e.message); }
  await Promise.all([
    syncMarketsTable().then(() => console.log('[api] Markets table synced from chain.MARKETS')).catch(e => console.log('[api] Markets sync:', e.message)),
    initConditionalOrdersTable().then(() => { startPriceMonitor(); console.log('[api] Conditional orders monitor started'); }),
    initGovernanceTables().then(() => console.log('[api] Governance tables initialized')),
    seedCompetitions().catch((e) => console.log('[api] Competition seed:', e.message)),
    initTwapTables().then(() => { startTwapEngine(); console.log('[api] TWAP engine started'); }).catch(e => console.log('[api] TWAP init:', e.message)),
    initSpotTables().then(() => seedSpotMarkets()).then(() => console.log('[api] Spot tables initialized')).catch(e => console.log('[api] Spot init:', e.message)),
    initOptionsTables().then(() => seedOptionContracts()).then(() => console.log('[api] Options tables initialized')).catch(e => console.log('[api] Options init:', e.message)),
    initAgentTables().then(() => console.log('[api] Agent tables initialized')).catch(e => console.log('[api] Agent init:', e.message)),
    initBridgeTables().then(() => console.log('[api] Bridge tables initialized')).catch(e => console.log('[api] Bridge init:', e.message)),
    initSyntheticTables().then(() => seedSyntheticMarkets()).then(() => console.log('[api] Synthetic tables initialized')).catch(e => console.log('[api] Synthetic init:', e.message)),
    initOracleCache().then(() => console.log('[api] Oracle cache initialized')).catch(e => console.log('[api] Oracle init:', e.message)),
    pool.query(`CREATE TABLE IF NOT EXISTS prelaunch_markets (id SERIAL PRIMARY KEY, symbol TEXT NOT NULL, token_name TEXT, launch_date TIMESTAMP, settlement_price NUMERIC, status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS prelaunch_orders (id SERIAL PRIMARY KEY, owner TEXT NOT NULL, market_id INT, side TEXT, price NUMERIC, size NUMERIC, filled NUMERIC DEFAULT 0, status TEXT DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS prelaunch_positions (id SERIAL PRIMARY KEY, owner TEXT NOT NULL, market_id INT, side TEXT, size NUMERIC, entry_price NUMERIC, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS whale_alerts (id SERIAL PRIMARY KEY, address TEXT NOT NULL, market_id INT, threshold NUMERIC DEFAULT 10000, active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS rfq_requests (id SERIAL PRIMARY KEY, requester TEXT NOT NULL, market_id INT, side TEXT, size NUMERIC, status TEXT DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS rfq_quotes (id SERIAL PRIMARY KEY, rfq_id INT, quoter TEXT, price NUMERIC, size NUMERIC, status TEXT DEFAULT 'open', expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS otc_quotes (id SERIAL PRIMARY KEY, address TEXT NOT NULL, quoter TEXT, market TEXT, side TEXT, size NUMERIC, quote_price NUMERIC, reference_price NUMERIC, status TEXT DEFAULT 'active', expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS otc_trades (id SERIAL PRIMARY KEY, quote_id INT, address TEXT NOT NULL, quoter TEXT, market TEXT, side TEXT, size NUMERIC, price NUMERIC, status TEXT DEFAULT 'filled', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS market_proposals (id SERIAL PRIMARY KEY, proposer TEXT, symbol TEXT, base_asset TEXT, quote_asset TEXT, max_leverage INT DEFAULT 50, stake_amount NUMERIC DEFAULT 1000, votes_for INT DEFAULT 0, votes_against INT DEFAULT 0, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS market_proposal_votes (id SERIAL PRIMARY KEY, proposal_id INTEGER REFERENCES market_proposals(id), voter TEXT NOT NULL, direction TEXT NOT NULL, voting_power NUMERIC DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(proposal_id, voter))`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS paper_balances (id SERIAL PRIMARY KEY, address TEXT UNIQUE, balance NUMERIC DEFAULT 100000, equity NUMERIC DEFAULT 100000, initial_balance NUMERIC DEFAULT 100000, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS paper_orders (id SERIAL PRIMARY KEY, owner TEXT, market_id INT, side TEXT, price NUMERIC, size NUMERIC, leverage INT DEFAULT 1, status TEXT DEFAULT 'filled', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS paper_positions (id SERIAL PRIMARY KEY, owner TEXT, market_id INT, side TEXT, size NUMERIC, entry_price NUMERIC, leverage INT DEFAULT 1, margin NUMERIC DEFAULT 0, unrealized_pnl NUMERIC DEFAULT 0, status TEXT DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS paper_trades (id SERIAL PRIMARY KEY, owner TEXT, market_id INT, side TEXT, price NUMERIC, size NUMERIC, leverage INT DEFAULT 1, pnl NUMERIC DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (id SERIAL PRIMARY KEY, email TEXT, token TEXT UNIQUE, session_token TEXT, address TEXT, verified BOOLEAN DEFAULT false, expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {}),
    pool.query(`INSERT INTO prelaunch_markets (symbol, token_name, launch_date, status) VALUES ('HYPE/USDC', 'HyperToken', NOW() + INTERVAL '30 days', 'active'), ('MONAD/USDC', 'Monad', NOW() + INTERVAL '45 days', 'active'), ('MEGA/USDC', 'MegaETH', NOW() + INTERVAL '60 days', 'active') ON CONFLICT DO NOTHING`).catch(() => {}),
  ]);
  // Backfill paper-engine columns on pre-existing deployments (CREATE TABLE IF NOT
  // EXISTS won't add them to a table that already exists).
  await pool.query(`ALTER TABLE paper_balances ADD COLUMN IF NOT EXISTS initial_balance NUMERIC DEFAULT 100000`).catch(() => {});
  await pool.query(`ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS margin NUMERIC DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS unrealized_pnl NUMERIC DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open'`).catch(() => {});
  await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS leverage INT DEFAULT 1`).catch(() => {});
  console.log('[api] All tables initialized');
}
// API_ROLE=standby: this instance runs on the warm standby against a
// read-only streaming replica. It serves every GET and the WebSocket feed
// from replicated data; DDL, seeds and the background writers (TWAP,
// conditional monitor, node probes) stay on the primary. Writes that reach it
// are forwarded to the primary by Caddy while the primary is up.
const STANDBY = process.env.API_ROLE === 'standby';
if (STANDBY) {
  console.log('[api] standby role: read-only replica, background writers off');
  try { require('./src/services/openInterest').start(); } catch (e) { console.log('[api] OI start:', e.message); }
} else {
  initAllTables().catch(err => console.error('[api] Init error:', err.message));
  // Telegram alerts: bot poller + rule engine — one instance only (the primary).
  try { require('./src/services/alerts').start(); } catch (e) { console.log('[api] alerts start:', e.message); }
  // Protocol upgrade estimates on record (hourly snapshots) — primary only.
  try { require('./src/services/upgrades').start(); } catch (e) { console.log('[api] upgrades start:', e.message); }
}

// Unknown /api/v1 route → JSON 404 (not the HTML default); anything thrown
// outside a route's own try/catch → sendError (400 for bad input, 500 sans
// driver text). Registered last so every router above is covered.
const { errorMiddleware } = require('./src/middleware/httpError');
app.use('/api/v1', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorMiddleware);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] Mersennet Trade API running on port ${PORT}`);
  console.log(`[api] REST: http://0.0.0.0:${PORT}/api/v1/`);
  console.log(`[api] WebSocket: ws://0.0.0.0:${PORT}/ws`);
});

// As PID 1 in its container Node has no default SIGTERM action, so `docker stop`
// used to wait out its 10 s grace period and then kill mid-request. Stop taking
// connections, let in-flight requests finish; WebSockets never end on their
// own, so exit after 5 s regardless (clients reconnect, via the other app host).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    console.log(`[api] ${sig}: closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
