/**
 * Verified node runners.
 *
 * An operator proves they run a reachable Mersennet node:
 *   1. their node's config has p2p.operator_address = their wallet;
 *   2. they sign a short message with that wallet in the terminal;
 *   3. we ask the node (host:30303, `whoami`) for its signed attestation and
 *      check that the node names that same wallet as operator.
 * Node identity, operator and host are stored; every 6 hours each node is
 * probed again (active = answered within the last 24 h), and once a day each
 * operator with an active node earns NODE_POINTS_PER_DAY (one node counts).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createHash } = require('node:crypto');
const { ethers } = require('ethers');
const pool = require('../db/pool');
const { whoami } = require('../services/nodeProbe');

const router = express.Router();
const SEASON = 1;
const NODE_POINTS_PER_DAY = Number(process.env.NODE_POINTS_PER_DAY || 500);
const RECHECK_MS = 6 * 60 * 60 * 1000;
const ACTIVE_WINDOW = "interval '24 hours'";

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verified_nodes (
      identity            TEXT PRIMARY KEY,
      operator            TEXT NOT NULL,
      host                TEXT NOT NULL,
      version             TEXT,
      height              BIGINT,
      first_verified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consecutive_failures INT NOT NULL DEFAULT 0,
      points_awarded_on   DATE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_verified_nodes_operator ON verified_nodes (operator)`);
  await pool.query(`ALTER TABLE points_balance ADD COLUMN IF NOT EXISTS node_points NUMERIC(20, 4) NOT NULL DEFAULT 0`).catch(() => {});
}
const ready = ensureTables().catch((e) => console.error('[nodes] table setup failed:', e.message));

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
  validate: false,
  message: { error: 'Too many verification attempts; try again in 15 minutes' },
});

function verificationMessage(host, wallet) {
  return `Mersennet node runner verification\nnode: ${host}\nwallet: ${wallet.toLowerCase()}`;
}

/** Same anonymous id the explorer shows next to community nodes (sha256(ip)[:3]). */
function nodeIdFor(host) {
  return createHash('sha256').update(host).digest('hex').slice(0, 6);
}

function maskHost(host) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  return m ? `${m[1]}.${m[2]}.x.x` : host.replace(/^([^.]+)\..*$/, '$1.…');
}

function validHost(h) {
  return typeof h === 'string' && h.length <= 253 && /^[a-zA-Z0-9.-]+$/.test(h) && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|localhost$)/.test(h);
}

/** POST /api/v1/nodes/verify  { host, wallet, signature } */
router.post('/verify', verifyLimiter, async (req, res) => {
  await ready;
  const { host, wallet, signature } = req.body || {};
  if (!validHost(host)) return res.status(400).json({ error: 'host must be a public IP or hostname' });
  if (!ethers.isAddress(wallet || '')) return res.status(400).json({ error: 'wallet must be a 0x address' });
  const walletLc = wallet.toLowerCase();
  try {
    if (ethers.verifyMessage(verificationMessage(host, walletLc), signature).toLowerCase() !== walletLc) {
      return res.status(400).json({ error: 'wallet signature does not match' });
    }
  } catch {
    return res.status(400).json({ error: 'invalid wallet signature' });
  }

  let att;
  try {
    att = await whoami(host);
  } catch (e) {
    return res.status(400).json({ error: e.message, hint: 'Your node must be on a build that answers whoami (install.sh upgrades it) and 30303/tcp must be open.' });
  }
  if (!att.operator) {
    return res.status(400).json({ error: 'node has no operator configured', hint: `Add "operator_address": "${walletLc}" to the p2p section of /etc/mersennet/config.json and restart the node (sudo systemctl restart mersennet).` });
  }
  if (att.operator !== walletLc) {
    return res.status(400).json({ error: 'node names a different operator', hint: `The node's p2p.operator_address is ${att.operator}; connect with that wallet or update the config and restart.` });
  }
  try {
    await pool.query(
      `INSERT INTO verified_nodes (identity, operator, host, version, height, last_verified_at, last_seen_at, consecutive_failures)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 0)
       ON CONFLICT (identity) DO UPDATE SET operator = EXCLUDED.operator, host = EXCLUDED.host, version = EXCLUDED.version,
         height = EXCLUDED.height, last_verified_at = NOW(), last_seen_at = NOW(), consecutive_failures = 0`,
      [att.identity, walletLc, host, att.version, att.height]
    );
  } catch (e) {
    console.error('[nodes] store failed:', e.message);
    return res.status(500).json({ error: 'could not store verification' });
  }
  res.json({ ok: true, identity: att.identity, height: att.height, version: att.version, pointsPerDay: NODE_POINTS_PER_DAY });
});

/** GET /api/v1/nodes/verified — public list (hosts masked) */
router.get('/verified', async (_req, res) => {
  await ready;
  try {
    const r = await pool.query(
      `SELECT identity, operator, host, version, height, first_verified_at, last_seen_at,
              (last_seen_at > NOW() - ${ACTIVE_WINDOW}) AS active
       FROM verified_nodes ORDER BY first_verified_at ASC LIMIT 500`
    );
    res.json({
      nodes: r.rows.map((n) => ({ ...n, id: nodeIdFor(n.host), host: maskHost(n.host), height: Number(n.height) })),
      total: r.rowCount,
      active: r.rows.filter((n) => n.active).length,
      pointsPerDay: NODE_POINTS_PER_DAY,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/v1/nodes/mine/:wallet — the caller's nodes (hosts unmasked; they configured them) */
router.get('/mine/:wallet', async (req, res) => {
  await ready;
  if (!ethers.isAddress(req.params.wallet)) return res.status(400).json({ error: 'invalid address' });
  try {
    const r = await pool.query(
      `SELECT identity, host, version, height, first_verified_at, last_seen_at, points_awarded_on,
              (last_seen_at > NOW() - ${ACTIVE_WINDOW}) AS active
       FROM verified_nodes WHERE operator = $1 ORDER BY first_verified_at ASC`,
      [req.params.wallet.toLowerCase()]
    );
    res.json({ nodes: r.rows.map((n) => ({ ...n, height: Number(n.height) })), pointsPerDay: NODE_POINTS_PER_DAY, message: verificationMessage('<host>', req.params.wallet) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Auto-discovery: any node the public RPC node currently hears from is
 * probed; if it names an operator, it is verified without anyone clicking
 * anything. Safe because the node itself signs the operator address (the
 * worst an attacker can do is gift points to a wallet), and one operator
 * earns for one node regardless of how many they run.
 */
const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const FLEET_IPS = new Set((process.env.FLEET_IPS || '46.225.183.192,49.13.54.79,167.233.105.60,167.233.118.149,46.225.30.187').split(',').map((s) => s.trim()));

async function discoverFromPeers() {
  await ready;
  let peers;
  try {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mersennet_peers', params: [] }), signal: AbortSignal.timeout(8000) });
    peers = (await res.json()).result || [];
  } catch (e) {
    console.warn('[nodes] discovery: peers unavailable:', e.message);
    return;
  }
  const hosts = [...new Set(peers.filter((p) => p.heard).map((p) => String(p.addr).replace(/:\d+$/, '')).filter((h) => !FLEET_IPS.has(h) && validHost(h)))];
  let known = new Set();
  try { known = new Set((await pool.query(`SELECT host FROM verified_nodes WHERE last_seen_at > NOW() - interval '6 hours'`)).rows.map((r) => r.host)); } catch { /* fall through: probe all */ }
  let added = 0;
  for (const host of hosts) {
    if (known.has(host)) continue;
    try {
      const att = await whoami(host);
      if (!att.operator) continue;   // node runs, but nobody claimed it
      await pool.query(
        `INSERT INTO verified_nodes (identity, operator, host, version, height, last_verified_at, last_seen_at, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 0)
         ON CONFLICT (identity) DO UPDATE SET operator = EXCLUDED.operator, host = EXCLUDED.host, version = EXCLUDED.version,
           height = EXCLUDED.height, last_seen_at = NOW(), consecutive_failures = 0`,
        [att.identity, att.operator, host, att.version, att.height]
      );
      added++;
      console.log(`[nodes] auto-verified ${host} (${att.identity.slice(0, 10)}…) for operator ${att.operator}`);
    } catch { /* unreachable or old build: skip quietly */ }
  }
  if (added) console.log(`[nodes] discovery: ${added} node(s) auto-verified from ${hosts.length} community peer(s)`);
}

/** Re-probe every verified node; award daily points to operators with an active node. */
async function recheckAll() {
  await ready;
  let rows;
  try { rows = (await pool.query(`SELECT identity, operator, host FROM verified_nodes`)).rows; } catch { return; }
  for (const n of rows) {
    try {
      const att = await whoami(n.host);
      const ok = att.identity === n.identity && att.operator === n.operator;
      if (ok) {
        await pool.query(`UPDATE verified_nodes SET last_seen_at = NOW(), height = $2, version = $3, consecutive_failures = 0 WHERE identity = $1`, [n.identity, att.height, att.version]);
      } else {
        await pool.query(`UPDATE verified_nodes SET consecutive_failures = consecutive_failures + 1 WHERE identity = $1`, [n.identity]);
      }
    } catch {
      await pool.query(`UPDATE verified_nodes SET consecutive_failures = consecutive_failures + 1 WHERE identity = $1`, [n.identity]).catch(() => {});
    }
  }
  await awardDailyPoints();
}

async function awardDailyPoints() {
  try {
    // One award per operator per UTC day, only if at least one node is active.
    const ops = await pool.query(
      `SELECT operator, MIN(identity) AS identity FROM verified_nodes
       WHERE last_seen_at > NOW() - ${ACTIVE_WINDOW}
         AND (points_awarded_on IS NULL OR points_awarded_on < (NOW() AT TIME ZONE 'utc')::date)
       GROUP BY operator`
    );
    for (const row of ops.rows) {
      const address = row.operator;
      await pool.query(
        `INSERT INTO points_balance (address, season, total_points, trading_points, lp_points, referral_points, node_points, tier, updated_at)
         VALUES ($1, $2, $3, 0, 0, 0, $3, 'bronze', NOW())
         ON CONFLICT (address, season) DO UPDATE SET
           node_points = points_balance.node_points + $3,
           total_points = points_balance.total_points + $3,
           updated_at = NOW()`,
        [address, SEASON, NODE_POINTS_PER_DAY]
      );
      await pool.query(
        `INSERT INTO points (address, season, point_type, amount, reason) VALUES ($1, $2, 'node', $3, 'Verified node online')`,
        [address, SEASON, NODE_POINTS_PER_DAY]
      ).catch(() => {});
      await pool.query(`UPDATE verified_nodes SET points_awarded_on = (NOW() AT TIME ZONE 'utc')::date WHERE operator = $1`, [address]);
    }
    if (ops.rowCount > 0) console.log(`[nodes] awarded node points to ${ops.rowCount} operator(s)`);
  } catch (e) {
    console.error('[nodes] award failed:', e.message);
  }
}

setTimeout(() => recheckAll().catch(() => {}), 60 * 1000);
setInterval(() => recheckAll().catch(() => {}), RECHECK_MS);
const DISCOVER_MS = Number(process.env.NODE_DISCOVERY_MS || 10 * 60 * 1000);
setTimeout(() => discoverFromPeers().catch(() => {}), 90 * 1000);
setInterval(() => discoverFromPeers().catch(() => {}), DISCOVER_MS);

module.exports = router;
