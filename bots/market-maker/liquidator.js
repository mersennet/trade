// Liquidation keeper. Polls `mersennet_orders_getLiquidatable` (accounts below
// maintenance margin at the head) and calls `liquidate(address)` on the CLOB
// precompile for each. The precompile closes the account's positions on the
// book and pays the keeper half of the 1% liquidation fee into this wallet's
// collateral. Anyone can run one; this is the network's default keeper so
// under-water accounts never linger. Idle until the settlement switch.
const { BotWallet } = require('./signer');
const { settlementActive } = require('./settlement');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const POLL_MS = Number(process.env.LIQ_POLL_MS || 4_000);
const keeper = new BotWallet(RPC_URL, 'liquidator', process.env.LIQ_PRIVATE_KEY);
let rpcId = 1;

async function rpcCall(method, params = []) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal: AbortSignal.timeout(10_000) });
  const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

const inflight = new Map(); // account -> sentAt
let lastIdleLog = 0;

// A liquidation that cannot trade (every resting order on the other side
// belongs to an account that cannot margin the fill) still succeeds and
// leaves the account liquidatable; retrying it every 30 s filled blocks for
// nothing. Each attempt doubles the wait (1 min up to 1 h) until the account
// stops being liquidatable.
const backoff = new Map(); // account -> { attempts, nextAt }
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 3_600_000;

// The precompile marks positions at each market's last trade. When that is
// outside 0.3x-3x of the maker's seed (index.js MARKETS) the book was swept
// or polluted, and liquidating on it closes accounts at a price nobody can
// trade: on 6 Oct MRSN/USD sat at 143x and this keeper sent 53,107
// liquidations to 46 accounts in 11 hours. Accounts holding a position in
// such a market wait; everyone else is liquidated as usual.
const SEEDS = { 1: 115, 2: 77000, 3: 2500, 4: 100, 5: 100 };
const held = new Map(); // account -> { markets: Set, at }
let lastSkipLog = 0;

async function dislocatedMarkets() {
  const r = await rpcCall('mersennet_orders_getMarkets', []);
  const out = new Set();
  for (const m of (Array.isArray(r) ? r : r?.markets) || []) {
    const id = Number(m.id);
    const ref = SEEDS[id] * (m.priceScale || 1);
    const last = Number(BigInt(m.lastPrice || '0x0'));
    if (SEEDS[id] && last > 0 && (last > ref * 3 || last < ref * 0.3)) out.add(id);
  }
  return out;
}

// A liquidation closes the account's positions with an IOC at any price, so
// whatever the book does not cover near the mid fills at the furthest order
// resting on that side, possibly one placed there to catch it. Hold an account
// until the side its sweep takes from (asks for a short, bids for a long)
// holds the whole position within SWEEP_BAND of the mid.
const SWEEP_BAND = Number(process.env.LIQ_SWEEP_BAND || 0.02);
const thinLog = new Map(); // account -> last log
async function uncovered(account) {
  const acct = await rpcCall('mersennet_orders_getAccount', [account]);
  for (const p of acct?.positions || []) {
    const size = BigInt(p.size);
    if (size === 0n) continue;
    const need = Number(size < 0n ? -size : size);
    const ob = await rpcCall('mersennet_orders_getOrderBook', [Number(p.marketId)]);
    const levels = (side) => (ob?.[side] || []).map((l) => [Number(BigInt(l.price)), Number(BigInt(l.size))]);
    const bids = levels('bids'), asks = levels('asks');
    if (!bids.length || !asks.length) return { market: Number(p.marketId), need, near: 0 };
    const mid = (Math.max(...bids.map(([q]) => q)) + Math.min(...asks.map(([q]) => q))) / 2;
    const near = (size < 0n ? asks.filter(([q]) => q <= mid * (1 + SWEEP_BAND)) : bids.filter(([q]) => q >= mid * (1 - SWEEP_BAND)))
      .reduce((s, [, n]) => s + n, 0);
    if (near < need) return { market: Number(p.marketId), need, near };
  }
  return null;
}

async function marketsHeld(account) {
  const cached = held.get(account);
  if (cached && Date.now() - cached.at < 60_000) return cached.markets;
  const acct = await rpcCall('mersennet_orders_getAccount', [account]);
  const markets = new Set((acct?.positions || []).filter((p) => BigInt(p.size) !== 0n).map((p) => Number(p.marketId)));
  held.set(account, { markets, at: Date.now() });
  return markets;
}

async function tick() {
  if (!(await settlementActive(rpcCall))) {
    if (Date.now() - lastIdleLog > 3_600_000) { console.log('[liq] settlement not active yet — idle'); lastIdleLog = Date.now(); }
    return;
  }
  const r = await rpcCall('mersennet_orders_getLiquidatable', []);
  const accounts = (r?.accounts || []).map((a) => a.toLowerCase());
  for (const [a, t] of inflight) if (Date.now() - t > 30_000 || !accounts.includes(a)) inflight.delete(a);
  for (const a of backoff.keys()) if (!accounts.includes(a)) backoff.delete(a);
  const dislocated = await dislocatedMarkets();
  let skipped = 0;
  for (const account of accounts) {
    if (inflight.has(account)) continue;
    if (account === keeper.address.toLowerCase()) continue;
    const b = backoff.get(account);
    if (b && Date.now() < b.nextAt) continue;
    try {
      if (dislocated.size && [...(await marketsHeld(account))].some((m) => dislocated.has(m))) {
        skipped += 1;
        continue;
      }
      const gap = await uncovered(account);
      if (gap) {
        if (Date.now() - (thinLog.get(account) || 0) > 300_000) {
          thinLog.set(account, Date.now());
          console.log(`[liq] holding ${account}: market ${gap.market} has ${gap.near} within ${SWEEP_BAND * 100}% of the mid, the position is ${gap.need}`);
        }
        continue;
      }
      const tx = await keeper.liquidate(account);
      if (tx) {
        inflight.set(account, Date.now());
        const attempts = (b?.attempts || 0) + 1;
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempts - 1));
        backoff.set(account, { attempts, nextAt: Date.now() + wait });
        console.log(`[liq] liquidating ${account} tx ${tx} (attempt ${attempts}; next try in ${Math.round(wait / 60_000)} min if still liquidatable)`);
      }
    } catch (e) {
      console.warn(`[liq] ${account}: ${e.message}`);
    }
  }
  if (skipped && Date.now() - lastSkipLog > 600_000) {
    console.log(`[liq] markets ${[...dislocated].join(',')} trade far from their seed: holding ${skipped} liquidatable accounts with positions there`);
    lastSkipLog = Date.now();
  }
}

(async () => {
  console.log(`[liq] keeper ${keeper.address} · poll ${POLL_MS / 1000}s · rpc ${RPC_URL}`);
  const bal = await keeper.balance().catch(() => 0n);
  console.log(`[liq] balance ${Number(bal) / 1e18} MRSN (gas; the maker tops it up), collateral ${await keeper.getCollateral().catch(() => 0n)} units`);
  setInterval(() => tick().catch((e) => console.warn('[liq] tick:', e.message)), POLL_MS);
})();
