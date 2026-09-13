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
app.use('/api/v1/api-keys', apiKeysRouter);
app.use('/api/v1/governance', governanceRouter);
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
app.use('/api/v1/nodes', require('./src/routes/nodes'));

app.get('/api/v1/health', async (req, res) => {
  const pool = require('./src/db/pool');
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', version: '2.0.0', timestamp: Date.now() });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: e.message });
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
initAllTables().catch(err => console.error('[api] Init error:', err.message));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] Mersennet Trade API running on port ${PORT}`);
  console.log(`[api] REST: http://0.0.0.0:${PORT}/api/v1/`);
  console.log(`[api] WebSocket: ws://0.0.0.0:${PORT}/ws`);
});
