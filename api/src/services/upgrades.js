/**
 * Protocol upgrades — the height-activated consensus switches, as a record.
 *
 * Two jobs:
 *  1. While an upgrade is ahead, keep an hourly snapshot of the ETA we showed
 *     for it (`protocol_upgrade_estimates`), so the estimate is on record
 *     before the real time exists.
 *  2. Once the height has passed, read the block's timestamp (the actual
 *     activation time) and report it against the estimates: the one of
 *     record (announced, or the earliest live one at least six hours out)
 *     and the last one shown before activation.
 *
 * Read by GET /api/v1/protocol/upgrades (explorer /upgrades page, terminal
 * staking panel). `upcomingSwitches()` in chain.js stays the live schedule.
 */
const pool = require('../db/pool');
const chain = require('./chain');

const STANDBY = process.env.API_ROLE === 'standby';

/** Everything the RPC exposes as a switch, past or future, by key → height. */
const VSET_KEYS = ['activationHeight', 'benchHeight', 'jailEscalationHeight', 'rewardsToOperatorHeight'];
async function allSwitches() {
  const [p, vset] = await Promise.all([
    chain.getProtocol(),
    chain.rpcCall('mersennet_validatorSet', []).catch(() => null),
  ]);
  if (!p) return null;
  const all = { ...(p.switches || {}) };
  const vp = vset && vset.params;
  if (vp) for (const k of VSET_KEYS) if (typeof vp[k] === 'number' && vp[k] > 0) all[k] = vp[k];
  return { height: Number(p.height) || 0, all };
}

/** Label (one line) and what changed (one sentence) per switch key. */
const META = {
  activationHeight: ['Open validator set', 'Permissionless registration: any node with the minimum self-stake can register; the top validators by stake produce blocks, recomputed every epoch.'],
  rewardsToOperatorHeight: ['Block rewards to the operator wallet', 'Rewards are credited to the operator address instead of the node identity.'],
  benchHeight: ['Benching after 3 missed leader slots', 'A validator that misses three leader slots leaves the rotation until the epoch boundary.'],
  jailEscalationHeight: ['Escalating jail', 'Consecutive jails last 1, 2, 4, 8, 16 then 24 epochs.'],
  agentDelegationHeight: ['Agent keys for one-click trading', 'setAgent / revokeAgent on the order-book precompile: a delegated key trades for the owner until its expiry.'],
  priceScaleHeight: ['$0.01 ticks on MRSN, SOL and ARB', 'Those markets move to priceScale 100; on-chain prices are human × 100 and the order books are rescaled in place.'],
  frameCallerHeight: ['Contracts own their CLOB accounts', 'Precompiles authorise the calling frame (msg.sender), not the transaction origin — contracts such as the Maker Vault act as themselves.'],
  settlementHeight: ['Settlement, margin and liquidations', 'One collateral unit = one MRSN, realized PnL settles into collateral at every fill, 10% initial / 5% maintenance margin, keeper liquidations, self-trade prevention.'],
};
const labelOf = (k) => (META[k] ? META[k][0] : k);
const detailOf = (k) => (META[k] ? META[k][1] : '');

// ---- estimates -----------------------------------------------------------

async function ensureSchema() {
  if (STANDBY) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS protocol_upgrade_estimates (
    id bigserial PRIMARY KEY,
    key text NOT NULL,
    height bigint NOT NULL,
    recorded_at timestamptz NOT NULL,
    eta_at timestamptz NOT NULL,
    blocks_left integer,
    block_time numeric,
    source text NOT NULL DEFAULT 'live',
    UNIQUE (key, height, recorded_at, source)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS protocol_upgrade_estimates_kh ON protocol_upgrade_estimates (key, height, recorded_at)');
}

/** One live snapshot per upcoming switch per hour (the first one immediately). */
async function snapshot() {
  const s = await chain.upcomingSwitches();
  if (!s || !s.switches.length) return 0;
  let n = 0;
  for (const sw of s.switches) {
    const { rows } = await pool.query(
      `SELECT max(recorded_at) AS last FROM protocol_upgrade_estimates WHERE key = $1 AND height = $2 AND source = 'live'`,
      [sw.key, sw.height],
    );
    const last = rows[0] && rows[0].last ? new Date(rows[0].last).getTime() : 0;
    if (Date.now() - last < 55 * 60_000) continue;
    await pool.query(
      `INSERT INTO protocol_upgrade_estimates (key, height, recorded_at, eta_at, blocks_left, block_time, source)
       VALUES ($1, $2, now(), $3, $4, $5, 'live') ON CONFLICT DO NOTHING`,
      [sw.key, sw.height, sw.etaAt, sw.blocksLeft, s.blockTimeSec],
    );
    n++;
  }
  return n;
}

async function estimatesFor(key, height) {
  const { rows } = await pool.query(
    `SELECT source, recorded_at, eta_at, blocks_left, block_time FROM protocol_upgrade_estimates
     WHERE key = $1 AND height = $2 ORDER BY recorded_at`,
    [key, height],
  );
  return rows.map((r) => ({
    source: r.source,
    recordedAt: new Date(r.recorded_at).toISOString(),
    etaAt: new Date(r.eta_at).toISOString(),
    blocksLeft: r.blocks_left == null ? null : Number(r.blocks_left),
    blockTimeSec: r.block_time == null ? null : Number(r.block_time),
  }));
}

// ---- actual activation time ------------------------------------------------

const blockTimeCache = new Map(); // height → ISO timestamp (finalized blocks never change)
async function activatedAt(height) {
  if (blockTimeCache.has(height)) return blockTimeCache.get(height);
  const b = await chain.rpcCall('eth_getBlockByNumber', ['0x' + height.toString(16), false]).catch(() => null);
  if (!b || !b.timestamp) return null;
  const iso = new Date(parseInt(b.timestamp, 16) * 1000).toISOString();
  blockTimeCache.set(height, iso);
  return iso;
}

/**
 * Estimate of record: the announced one if there is one; otherwise the
 * earliest live snapshot taken at least six hours before activation;
 * otherwise the earliest snapshot at all. `final` is the last one shown.
 */
function pick(estimates, actualMs) {
  if (!estimates.length) return { record: null, final: null };
  const announced = estimates.find((e) => e.source === 'announced');
  const live = estimates.filter((e) => e.source === 'live');
  const early = live.find((e) => actualMs - new Date(e.recordedAt).getTime() >= 6 * 3600_000);
  const record = announced || early || estimates[0];
  const before = live.filter((e) => new Date(e.recordedAt).getTime() <= actualMs);
  const final = before.length ? before[before.length - 1] : null;
  return { record, final: final && final !== record ? final : null };
}

const deltaSec = (actualIso, etaIso) => Math.round((new Date(actualIso).getTime() - new Date(etaIso).getTime()) / 1000);

// ---- the report --------------------------------------------------------------

let reportCache = { at: 0, value: null };
async function report() {
  if (reportCache.value && Date.now() - reportCache.at < 20_000) return reportCache.value;
  const [sw, live] = await Promise.all([allSwitches(), chain.upcomingSwitches()]);
  if (!sw) return { blockTimeSec: live.blockTimeSec, height: null, upcoming: [], completed: [] };

  const upcoming = live.switches.map((s) => ({ ...s, label: labelOf(s.key), detail: detailOf(s.key) }));
  // Announced estimate (if any) next to the live one, so the UI can show drift while it is still ahead.
  for (const u of upcoming) {
    const est = await estimatesFor(u.key, u.height);
    const announced = est.find((e) => e.source === 'announced');
    const first = est.find((e) => e.source === 'live');
    u.announcedAt = announced ? announced.etaAt : null;
    u.firstEstimateAt = first ? first.etaAt : null;
    u.firstEstimateRecordedAt = first ? first.recordedAt : null;
  }

  const completed = [];
  for (const [key, height] of Object.entries(sw.all)) {
    if (height > sw.height) continue;
    const actual = await activatedAt(height);
    const estimates = await estimatesFor(key, height);
    const { record, final } = pick(estimates, actual ? new Date(actual).getTime() : Date.now());
    completed.push({
      key, label: labelOf(key), detail: detailOf(key), height,
      activatedAt: actual,
      estimate: record ? { ...record, deltaSec: actual ? deltaSec(actual, record.etaAt) : null } : null,
      finalEstimate: final ? { ...final, deltaSec: actual ? deltaSec(actual, final.etaAt) : null } : null,
      estimates,
    });
  }
  completed.sort((a, b) => b.height - a.height || a.key.localeCompare(b.key));
  const value = { blockTimeSec: live.blockTimeSec, height: sw.height, upcoming, completed };
  reportCache = { at: Date.now(), value };
  return value;
}

function start() {
  if (STANDBY) return;
  ensureSchema()
    .then(() => snapshot())
    .then((n) => console.log(`[upgrades] estimates on record; ${n} new snapshot(s)`))
    .catch((e) => console.log('[upgrades] init:', e.message));
  setInterval(() => snapshot().catch((e) => console.log('[upgrades] snapshot:', e.message)), 5 * 60_000).unref();
}

module.exports = { start, report, snapshot, labelOf, detailOf, META };
