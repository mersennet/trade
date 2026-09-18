/**
 * Open interest and long/short account counts from CHAIN positions.
 *
 * The previous figure summed the indexer's trade history (net size per
 * account from every fill ever recorded), which drifts from the chain as soon
 * as a fill is missed or an account is liquidated — it showed $53M of BTC open
 * interest while every bot was flat. This reads `mersennet_orders_getAccount`
 * for every address that has ever traded (the indexer's `trades` table is the
 * address source, not the size source) and sums the positive sizes per
 * market. Refreshed in the background every 60 s; a few dozen RPC reads.
 */
const chain = require('./chain');
const pool = require('../db/pool');

const REFRESH_MS = 60_000;
let cache = { at: 0, byMarket: {}, accounts: 0 };
let inFlight = null;

function signed(hex) {
  if (hex == null) return 0n;
  const s = String(hex);
  let v;
  try { v = s.startsWith('0x') ? BigInt(s) : BigInt(s); } catch { return 0n; }
  if (v >= (1n << 255n)) v -= (1n << 256n);
  return v;
}

async function traders() {
  const { rows } = await pool.query(
    `SELECT DISTINCT a FROM (SELECT maker AS a FROM trades UNION SELECT taker AS a FROM trades) t WHERE a IS NOT NULL`,
  );
  return rows.map((r) => r.a).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
}

async function compute() {
  const addrs = await traders();
  const byMarket = {}; // marketId -> { longSize, shortSize, longs, shorts }
  const seen = new Set();
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let acct;
    try { acct = await chain.rpcCall('mersennet_orders_getAccount', [a]); } catch { continue; }
    for (const p of (acct && acct.positions) || []) {
      const size = signed(p.size);
      if (size === 0n) continue;
      const mid = Number(typeof p.marketId === 'string' && p.marketId.startsWith('0x') ? parseInt(p.marketId, 16) : p.marketId);
      const m = byMarket[mid] || (byMarket[mid] = { longSize: 0n, shortSize: 0n, longs: 0, shorts: 0 });
      if (size > 0n) { m.longSize += size; m.longs += 1; } else { m.shortSize -= size; m.shorts += 1; }
    }
  }
  cache = { at: Date.now(), byMarket, accounts: seen.size };
  return cache;
}

/** Refresh if stale (never throws; keeps the previous snapshot on failure). */
async function refresh(force = false) {
  if (!force && Date.now() - cache.at < REFRESH_MS) return cache;
  if (!inFlight) {
    inFlight = compute().catch((e) => {
      console.warn('[oi] refresh failed (keeping previous):', e.message);
      return cache;
    }).finally(() => { inFlight = null; });
  }
  return inFlight;
}

/**
 * Open interest for `marketId` in quote units (one side: sum of long sizes ×
 * mark). `markPrice` is the human mark. Returns null while no snapshot exists.
 */
function openInterest(marketId, markPrice) {
  if (!cache.at) return null;
  const m = cache.byMarket[Number(marketId)];
  if (!m) return { openInterest: 0, longAccounts: 0, shortAccounts: 0, asOf: cache.at };
  return {
    openInterest: Math.round(Number(m.longSize) * (Number(markPrice) || 0)),
    longAccounts: m.longs,
    shortAccounts: m.shorts,
    asOf: cache.at,
  };
}

function start() {
  refresh(true).catch(() => {});
  setInterval(() => refresh(true).catch(() => {}), REFRESH_MS);
}

module.exports = { start, refresh, openInterest };
