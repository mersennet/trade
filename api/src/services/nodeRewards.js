const pool = require('../db/pool');
const explorer = require('../db/explorerPool');
const chain = require('./chain');

// What each validator's operator and delegators earned, epoch by epoch.
//
// Every block mints 2^61-1 wei and splits it across the consensus set in
// proportion to stake; the chain then hands the delegators of each validator
// reward * D / (V + D) * (1 - commission), with V the validator's consensus
// stake at the epoch transition (self-stake + delegations) and D the pool's
// delegations, and credits the rest to the operator wallet. The proposer also
// keeps a share of the base fee of the blocks it proposed. None of this is in
// the blocks or receipts, so it is rebuilt here from a snapshot of the set
// taken at the start of each epoch: an estimate, close as long as stakes do
// not move within the epoch.
const REWARD_WEI = (1n << 61n) - 1n;
const POLL_MS = 60_000;
const WEI = 1e18;

let timer = null;

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS node_epoch_snapshots (
    epoch bigint PRIMARY KEY, height bigint NOT NULL, taken_at timestamptz DEFAULT now(), validators jsonb NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS node_epoch_rewards (
    epoch bigint NOT NULL, identity text NOT NULL, operator text NOT NULL,
    stake_share double precision, reward_mrsn double precision, fees_mrsn double precision,
    operator_mrsn double precision, delegators_mrsn double precision, settled_at timestamptz DEFAULT now(),
    PRIMARY KEY (epoch, identity))`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_node_epoch_rewards_operator ON node_epoch_rewards (operator)');
}

const big = (hex) => { try { return BigInt(hex || 0); } catch { return 0n; } };

async function snapshot(vs, epoch, epochBlocks) {
  const height = Number(vs.height);
  // Only a snapshot from the first minutes of an epoch tells how it was split.
  if (height - epoch * epochBlocks > epochBlocks / 20) return;
  const consensus = new Set((vs.consensusValidators || []).map((a) => a.toLowerCase()));
  const validators = (vs.validators || [])
    .filter((v) => consensus.has(String(v.identity).toLowerCase()))
    .map((v) => ({
      identity: String(v.identity).toLowerCase(),
      operator: (v.operator && !/^0x0{40}$/i.test(v.operator) ? v.operator : v.identity).toLowerCase(),
      votingStake: big(v.votingStake).toString(),
      delegated: big(v.delegated).toString(),
      commissionBps: Number(v.commissionBps) || 0,
    }));
  if (!validators.length) return;
  await pool.query(
    'INSERT INTO node_epoch_snapshots (epoch, height, validators) VALUES ($1, $2, $3) ON CONFLICT (epoch) DO NOTHING',
    [epoch, height, JSON.stringify(validators)],
  );
}

async function settle(epoch, validators, epochBlocks, currentEpoch) {
  const start = epoch * epochBlocks;
  const { rows } = await explorer.query(
    `SELECT lower(miner) AS miner, COUNT(*)::int AS blocks, COALESCE(SUM(gas_used), 0)::text AS gas
       FROM blocks WHERE number >= $1 AND number < $2 GROUP BY 1`,
    [start, start + epochBlocks],
  );
  const seen = rows.reduce((s, r) => s + r.blocks, 0);
  // Wait for the explorer to index the whole epoch; past a couple of epochs, settle what it has.
  if (seen < epochBlocks && epoch >= currentEpoch - 2) return;

  const protocol = await chain.getProtocol().catch(() => null);
  const baseFee = big(protocol?.fees?.minBaseFeeWei || 1_000_000_000n);
  const proposerBps = BigInt(protocol?.fees?.proposerBps ?? 2500);
  const total = validators.reduce((s, v) => s + big(v.votingStake), 0n);
  if (total === 0n) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of validators) {
      const V = big(v.votingStake);
      const D = big(v.delegated);
      const reward = (REWARD_WEI * BigInt(epochBlocks) * V) / total;
      const cut = V + D > 0n ? (reward * D / (V + D)) * BigInt(10_000 - v.commissionBps) / 10_000n : 0n;
      const mine = rows.find((r) => r.miner === v.identity);
      const fees = mine ? (BigInt(mine.gas) * baseFee * proposerBps) / 10_000n : 0n;
      await client.query(
        `INSERT INTO node_epoch_rewards
           (epoch, identity, operator, stake_share, reward_mrsn, fees_mrsn, operator_mrsn, delegators_mrsn)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (epoch, identity) DO NOTHING`,
        [epoch, v.identity, v.operator, Number(V) / Number(total), Number(reward) / WEI, Number(fees) / WEI,
          Number(reward - cut + fees) / WEI, Number(cut) / WEI],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function tick() {
  const vs = await chain.rpcCall('mersennet_validatorSet', []);
  const epochBlocks = Number(vs?.params?.epochBlocks) || 1800;
  const epoch = Number(vs.epoch);
  await snapshot(vs, epoch, epochBlocks);
  const { rows } = await pool.query(
    `SELECT s.epoch, s.validators FROM node_epoch_snapshots s
      WHERE s.epoch < $1 AND NOT EXISTS (SELECT 1 FROM node_epoch_rewards r WHERE r.epoch = s.epoch)
      ORDER BY s.epoch`,
    [epoch],
  );
  for (const r of rows) await settle(Number(r.epoch), r.validators, epochBlocks, epoch);
}

function start() {
  if (timer) return;
  init()
    .then(() => {
      const run = () => tick().catch((e) => console.log('[node-rewards]', e.message));
      run();
      timer = setInterval(run, POLL_MS);
    })
    .catch((e) => console.log('[node-rewards] init:', e.message));
}

/** Operator earnings recorded for a wallet: MRSN and the first epoch on record. */
async function operatorTotals(address) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(operator_mrsn), 0)::float8 AS mrsn, MIN(epoch) AS since_epoch, COUNT(DISTINCT epoch)::int AS epochs
       FROM node_epoch_rewards WHERE operator = $1`,
    [address],
  );
  return rows[0];
}

module.exports = { start, operatorTotals };
