/**
 * Cancel every resting order of the bot wallets derived from a given seed.
 * Used once to clean up the ~141k GTC leftovers the old taker version left on
 * the books (takers now place IOC), and as a general "drain a seed" tool.
 *
 *   BOT_SEED=<seed> RPC_URL=... NUM_TAKERS=20 node drain-stale-orders.js
 *
 * Runs all wallets in parallel; each BotWallet paces itself (BOT_MAX_INFLIGHT,
 * BOT_SEND_SPACING_MS), so total chain load is bounded per wallet.
 */
const { BotWallet } = require('./signer');

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const NUM_TAKERS = Number(process.env.NUM_TAKERS || 20);
// DRAIN_SKIP_MAKER=1 leaves the live maker's quotes alone (takers only).
const labels = [
  ...(process.env.DRAIN_SKIP_MAKER === '1' ? [] : ['maker']),
  ...Array.from({ length: NUM_TAKERS }, (_, i) => `taker-${i}`),
];

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain(label) {
  const w = new BotWallet(RPC_URL, label);
  let total = 0;
  let rounds = 0;
  for (;;) {
    const open = (await rpc('mersennet_orders_getOpenOrders', [w.address])) || [];
    if (open.length === 0) break;
    rounds++;
    let sent = 0;
    for (const o of open) {
      const h = await w.cancelOrder(o.id).catch(() => null);
      if (h) {
        sent++;
        total++;
      } else {
        await sleep(500); // backed off (in-flight cap): let the chain drain
      }
    }
    console.log(`[drain] ${label} ${w.address.slice(0, 10)}: round ${rounds}, ${open.length} open, ${sent} cancels sent, ${total} total`);
    await sleep(4000);
  }
  console.log(`[drain] ${label}: clean (${total} cancelled)`);
}

// Bounded parallelism: the live maker/taker share block space with this job,
// so keep the drain to a trickle (DRAIN_CONCURRENCY wallets at once).
const CONCURRENCY = Number(process.env.DRAIN_CONCURRENCY || 3);

(async () => {
  console.log(`[drain] rpc=${RPC_URL} wallets=${labels.length} concurrency=${CONCURRENCY}`);
  const queue = [...labels];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const l = queue.shift();
      await drain(l).catch((e) => console.error(`[drain] ${l} failed: ${e.message}`));
    }
  }));
  console.log('[drain] all wallets clean');
})();
