/**
 * Exchange liveness for the status page and the ops alerts (`/api/v1/health/exchange`).
 *
 * The exchange was dead from the 20 Sep settlement switch to 25 Sep — every
 * market-maker order reverted (91% of the chain's transactions), zero fills,
 * depositors' MRSN idle in the vault — and nothing paged anyone: every probe
 * we had answered "up" because the API, the chain and the bots' processes
 * were all fine. This check looks at outcomes instead:
 *
 *   fills            trades printed in the last 15 minutes
 *   clobFailures     failed / total txs to the order-book precompile, 10 min
 *   chainFailures    failed / total txs chain-wide, 10 min (the explorer's tables)
 *   makerQuoting     the vault has orders resting on the book
 *   vaultIdle        free MRSN in the vault above the reserve, i.e. not pushed
 *                    to collateral (a stuck vault-manager)
 *   indexerLag       trade indexer behind the chain head
 *
 * 200 `{ ok: true }` when every check passes, 503 with `failing: [...]`
 * otherwise; Kuma keys on `"ok":true` and posts the JSON to the ops group.
 * Answers are cached 15 s so a polling status page costs one query set.
 */
const { Pool } = require('pg');
const pool = require('../db/pool');
const { rpcCall } = require('./chain');

const ORDERS_PRECOMPILE = '0x0000000000000000000000000000000000000100';
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || '0xe77F94c4Bf7D6d2E2371aFdE440a0b9b8a567725').toLowerCase();
const VAULT_RESERVE_BPS = Number(process.env.VAULT_RESERVE_BPS || 1000);
const VAULT_MIN_PUSH_MRSN = Number(process.env.VAULT_MIN_PUSH_MRSN || 100);
const SEL_NAV = '0xc1590cd7';          // nav()
const SEL_FREE = '0x25185d3e';         // freeBalance()

const THRESHOLDS = {
  fillsWindowMin: 15,
  failWindowSec: 600,
  clobMinTxs: 30,   clobMaxFailRatio: 0.3,
  chainMinTxs: 50,  chainMaxFailRatio: 0.3,
  indexerMaxLagBlocks: 150,
};

// The explorer indexer keeps every transaction (with status) in its own
// database on the same server; the trade DB only has the CLOB's view.
const explorerUrl = process.env.EXPLORER_DATABASE_URL
  || (process.env.DATABASE_URL || '').replace(/\/[^/?]+(\?|$)/, '/mersennet_explorer$1');
const explorer = explorerUrl ? new Pool({ connectionString: explorerUrl, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 }) : null;
if (explorer) explorer.on('error', (err) => console.error('[exchange-health] explorer pool error:', err.message));

async function failRatio(where, params) {
  if (!explorer) return null;
  const r = await explorer.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 0)::int AS failed
       FROM transactions WHERE "timestamp" >= $1 ${where}`,
    params,
  );
  const { total, failed } = r.rows[0];
  return { total, failed, ratio: total ? failed / total : 0 };
}

async function probe() {
  const since = Math.floor(Date.now() / 1000) - THRESHOLDS.failWindowSec;
  const settled = await Promise.allSettled([
    pool.query(`SELECT count(*)::int AS c FROM trades WHERE block_timestamp > NOW() - make_interval(mins => $1)`, [THRESHOLDS.fillsWindowMin]),
    failRatio('AND to_addr = $2', [since, ORDERS_PRECOMPILE]),
    failRatio('', [since]),
    rpcCall('mersennet_orders_getAccount', [VAULT_ADDRESS]),
    rpcCall('eth_call', [{ to: VAULT_ADDRESS, data: SEL_NAV }, 'latest']),
    rpcCall('eth_call', [{ to: VAULT_ADDRESS, data: SEL_FREE }, 'latest']),
    rpcCall('eth_blockNumber', []),
    pool.query('SELECT last_block FROM indexer_state WHERE id = 1'),
  ]);
  const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
  const err = (i) => (settled[i].status === 'rejected' ? String(settled[i].reason?.message || settled[i].reason) : null);

  const checks = {};
  const failing = [];
  const fail = (name, detail) => { failing.push(name); checks[name] = { ok: false, ...detail }; };
  const pass = (name, detail) => { checks[name] = { ok: true, ...detail }; };

  const fills = val(0)?.rows?.[0]?.c;
  if (fills == null) fail('fills', { error: err(0) || 'no answer' });
  else if (fills === 0) fail('fills', { last15m: 0, message: `no fills in ${THRESHOLDS.fillsWindowMin} min` });
  else pass('fills', { last15m: fills });

  const clob = val(1);
  if (clob == null) checks.clobFailures = { ok: true, skipped: err(1) || 'explorer db not configured' };
  else if (clob.total >= THRESHOLDS.clobMinTxs && clob.ratio > THRESHOLDS.clobMaxFailRatio) fail('clobFailures', { ...clob, message: `${Math.round(clob.ratio * 100)}% of order-book txs reverted in 10 min` });
  else pass('clobFailures', clob);

  const chain = val(2);
  if (chain == null) checks.chainFailures = { ok: true, skipped: err(2) || 'explorer db not configured' };
  else if (chain.total >= THRESHOLDS.chainMinTxs && chain.ratio > THRESHOLDS.chainMaxFailRatio) fail('chainFailures', { ...chain, message: `${Math.round(chain.ratio * 100)}% of all txs reverted in 10 min` });
  else pass('chainFailures', chain);

  const acct = val(3);
  if (!acct) fail('makerQuoting', { error: err(3) || 'no answer' });
  else if (!acct.openOrders) fail('makerQuoting', { openOrders: 0, collateral: parseInt(acct.collateral, 16), message: 'the vault has no orders on the book' });
  else pass('makerQuoting', { openOrders: acct.openOrders, collateral: parseInt(acct.collateral, 16) });

  const nav = val(4); const free = val(5);
  if (!nav || !free) fail('vaultIdle', { error: err(4) || err(5) || 'no answer' });
  else {
    const navMrsn = Number(BigInt(nav)) / 1e18;
    const freeMrsn = Number(BigInt(free)) / 1e18;
    const idle = freeMrsn - (navMrsn * VAULT_RESERVE_BPS) / 10_000;
    const detail = { navMrsn: Math.round(navMrsn), freeMrsn: Math.round(freeMrsn), idleMrsn: Math.round(idle) };
    if (idle >= VAULT_MIN_PUSH_MRSN) fail('vaultIdle', { ...detail, message: `${Math.round(idle)} MRSN of deposits not pushed to collateral` });
    else pass('vaultIdle', detail);
  }

  const head = val(6) ? parseInt(val(6), 16) : null;
  const indexed = val(7)?.rows?.[0]?.last_block != null ? Number(val(7).rows[0].last_block) : null;
  if (head == null || indexed == null) fail('indexerLag', { error: err(6) || err(7) || 'no answer' });
  else if (head - indexed > THRESHOLDS.indexerMaxLagBlocks) fail('indexerLag', { head, indexed, lag: head - indexed, message: `trade indexer ${head - indexed} blocks behind` });
  else pass('indexerLag', { head, indexed, lag: head - indexed });

  const ok = failing.length === 0;
  return { status: ok ? 200 : 503, body: { ok, failing, checks, timestamp: Date.now() } };
}

const TTL_MS = 15_000;
let cache = { at: 0, body: null, status: 503, inflight: null };
async function exchangeHealth() {
  const now = Date.now();
  if (cache.body && now - cache.at < TTL_MS) return { status: cache.status, body: cache.body };
  if (!cache.inflight) {
    cache.inflight = probe()
      .then((r) => { cache = { at: Date.now(), body: r.body, status: r.status, inflight: null }; return r; })
      .catch((e) => { cache.inflight = null; throw e; });
  }
  return cache.inflight;
}

module.exports = { exchangeHealth, THRESHOLDS };
