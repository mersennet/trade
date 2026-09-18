#!/usr/bin/env node
/**
 * unwind.js — flatten bot inventory by trading bot accounts against each other.
 *
 * Every bot generation we have run (the public default seed `mersennet-bot-v1`
 * and the current BOT_SEED, plus MM_PRIVATE_KEY) is loaded; per market, the
 * accounts that are short rest GTC buys at the mid (strictly inside the
 * spread, so nothing else on the book is touched) and the accounts that are
 * long sell into them with IOC at the same price. Prints land at the mid, no
 * wick, and positions net to ~0 on both sides. Slices so no single print is
 * the whole inventory.
 *
 * Why: at the settlement switch (block 1,605,600) every collateral balance is
 * divided by 1e18 and 10%/5% margin turns on. Bot accounts carried ~$860M of
 * notional against dust collateral, which would have made all of them
 * liquidatable in the same block — a liquidation storm on the flagship chart.
 *
 *   RPC_URL=... BOT_SEED=<current> MM_PRIVATE_KEY=0x... node unwind.js [--dry] [--slices 8] [--markets 1,2,3,4,5]
 *
 * Run with the maker/taker containers STOPPED (this signs for the same keys).
 */
const { ethers } = require('ethers');
const { BotWallet } = require('./signer');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const DRY = process.argv.includes('--dry');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SLICES = Math.max(1, Number(arg('--slices', 8)));
const MARKET_IDS = String(arg('--markets', '1,2,3,4,5')).split(',').map(Number);
const NUM_TAKERS = Number(process.env.NUM_TAKERS || 20);
const SEEDS = [...new Set(['mersennet-bot-v1', process.env.BOT_SEED].filter(Boolean))];
const ORDERS_PRECOMPILE = '0x0000000000000000000000000000000000000100';
const GET_POSITION_SELECTOR = '0x0f85fc5a'; // keccak("getPosition(uint64)")[:4]

let rpcId = 1;
async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
const hexToNum = (h) => (h ? Number(BigInt(h)) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wallets() {
  const out = [];
  for (const seed of SEEDS) {
    for (const label of ['maker', ...Array.from({ length: NUM_TAKERS }, (_, i) => `taker-${i}`)]) {
      const key = ethers.keccak256(ethers.toUtf8Bytes(`${seed}:${label}`));
      out.push(new BotWallet(RPC_URL, `${seed.slice(0, 8)}:${label}`, key));
    }
  }
  if (process.env.MM_PRIVATE_KEY) out.push(new BotWallet(RPC_URL, 'mm-key', process.env.MM_PRIVATE_KEY));
  // de-duplicate by address (MM_PRIVATE_KEY may equal a derived maker)
  const seen = new Set();
  return out.filter((w) => { const a = w.address.toLowerCase(); if (seen.has(a)) return false; seen.add(a); return true; });
}

async function position(addr, marketId) {
  const data = GET_POSITION_SELECTOR + BigInt(marketId).toString(16).padStart(64, '0');
  const out = await rpc('eth_call', [{ from: addr, to: ORDERS_PRECOMPILE, data, gas: '0x30000' }, 'latest']);
  if (!out || out === '0x' || out.length < 66) return 0n;
  let size = BigInt('0x' + out.slice(2, 66));
  if (size >= (1n << 255n)) size -= (1n << 256n);
  return size;
}

/** Mid strictly inside the spread (integer chain price), or null. */
async function interiorMid(marketId) {
  const ob = await rpc('mersennet_orders_getOrderBook', [marketId]);
  const bids = (ob?.bids || []).map((l) => hexToNum(l.price)).filter((p) => p > 0);
  const asks = (ob?.asks || []).map((l) => hexToNum(l.price)).filter((p) => p > 0);
  if (!bids.length || !asks.length) return null;
  const bb = Math.max(...bids), ba = Math.min(...asks);
  if (ba - bb < 2) return null; // no integer strictly inside
  // stale-book guard: the two sides must be within 5% of each other
  if ((ba - bb) / bb > 0.05) return null;
  return { mid: Math.floor((bb + ba) / 2), bb, ba };
}

async function waitMined(hashes, timeoutMs = 60_000) {
  const start = Date.now();
  const pending = new Set(hashes.filter(Boolean));
  while (pending.size && Date.now() - start < timeoutMs) {
    for (const h of [...pending]) {
      const r = await rpc('eth_getTransactionReceipt', [h]).catch(() => null);
      if (r) pending.delete(h);
    }
    if (pending.size) await sleep(1500);
  }
  return pending.size === 0;
}

async function cancelResting(w, marketId, price) {
  const open = await rpc('mersennet_orders_getOpenOrders', [w.address]).catch(() => []);
  const mine = (open || []).filter((o) => hexToNum(o.market_id ?? o.marketId) === marketId && hexToNum(o.price) === price);
  const hashes = [];
  for (const o of mine) hashes.push(await w.cancelOrder(o.id).catch(() => null));
  if (hashes.length) await waitMined(hashes);
  return mine.length;
}

async function unwindMarket(marketId, ws) {
  console.log(`\n=== market ${marketId} ===`);
  for (let round = 1; round <= SLICES + 2; round++) {
    const pos = new Map();
    for (const w of ws) { const p = await position(w.address, marketId); if (p !== 0n) pos.set(w, p); }
    const longs = [...pos].filter(([, p]) => p > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const shorts = [...pos].filter(([, p]) => p < 0n).sort((a, b) => (a[1] > b[1] ? 1 : -1));
    const L = longs.reduce((s, [, p]) => s + p, 0n), S = shorts.reduce((s, [, p]) => s - p, 0n);
    console.log(`round ${round}: ${longs.length} long (${L}) vs ${shorts.length} short (${S})`);
    if (!longs.length || !shorts.length) { console.log('nothing left to pair'); return; }
    const spread = await interiorMid(marketId);
    if (!spread) { console.log('no interior mid (empty/one-sided/stale book) — skipping this round'); await sleep(5000); continue; }
    const { mid, bb, ba } = spread;
    // This round trades a slice of the smaller side, split pro rata.
    const remainingRounds = Math.max(1, SLICES - round + 1);
    const target = round > SLICES ? (L < S ? L : S) : ((L < S ? L : S) + BigInt(remainingRounds) - 1n) / BigInt(remainingRounds);
    if (target <= 0n) return;
    const alloc = (side, total) => {
      const out = [];
      let left = target;
      for (const [w, p] of side) {
        const abs = p < 0n ? -p : p;
        let q = (abs * target) / total; if (q < 1n && left > 0n && abs > 0n) q = 1n; if (q > abs) q = abs; if (q > left) q = left;
        left -= q; if (q > 0n) out.push([w, q]);
      }
      return out;
    };
    const buys = alloc(shorts, S), sells = alloc(longs, L);
    const buyQty = buys.reduce((s, [, q]) => s + q, 0n), sellQty = sells.reduce((s, [, q]) => s + q, 0n);
    const qty = buyQty < sellQty ? buyQty : sellQty; // both sides trade the same total
    console.log(`  mid ${mid} (book ${bb}/${ba}) · ${buys.length} buyers rest ${buyQty} · ${sells.length} sellers IOC ${sellQty} · matched ${qty}`);
    if (DRY) continue;
    // 1) shorts rest GTC buys at mid
    const restHashes = [];
    for (const [w, q] of buys) restHashes.push(await w.placeOrder(marketId, 'buy', mid, Number(q), 'gtc').catch((e) => { console.warn(`  rest ${w.label}: ${e.message}`); return null; }));
    if (!(await waitMined(restHashes))) console.warn('  some resting orders not mined in time');
    // 2) longs sell IOC at mid (only matches orders >= mid: ours; the book's bids are below)
    const iocHashes = [];
    for (const [w, q] of sells) iocHashes.push(await w.placeOrder(marketId, 'sell', mid, Number(q), 'ioc').catch((e) => { console.warn(`  ioc ${w.label}: ${e.message}`); return null; }));
    if (!(await waitMined(iocHashes))) console.warn('  some IOC orders not mined in time');
    // 3) retire whatever is still resting at mid (partial fills / mismatch)
    let cancelled = 0;
    for (const [w] of buys) cancelled += await cancelResting(w, marketId, mid);
    if (cancelled) console.log(`  cancelled ${cancelled} leftover resting order(s)`);
    await sleep(2000);
  }
}

(async () => {
  const ws = wallets();
  console.log(`${ws.length} bot wallets across ${SEEDS.length} seed(s)${process.env.MM_PRIVATE_KEY ? ' + MM_PRIVATE_KEY' : ''}; rpc ${RPC_URL}; ${DRY ? 'DRY RUN' : 'LIVE'}; ${SLICES} slices`);
  const head = hexToNum(await rpc('eth_blockNumber'));
  console.log(`head ${head}`);
  for (const id of MARKET_IDS) await unwindMarket(id, ws);
  console.log('\n=== residual positions ===');
  for (const id of MARKET_IDS) {
    let net = 0n, gross = 0n;
    for (const w of ws) { const p = await position(w.address, id); net += p; gross += p < 0n ? -p : p; }
    console.log(`market ${id}: gross ${gross} net ${net}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
