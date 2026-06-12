#!/usr/bin/env node
/**
 * Drain stale orders directly via chain RPC.
 * Run once: node drain-orders.js
 */

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const OWNER = process.env.MM_WALLET || '0x0000000000000000000000000000000000000001';
const BATCH_SIZE = 200;
const BATCH_PAUSE = 100;

let rpcId = 1;

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function main() {
  console.log(`Draining orders for ${OWNER} via ${RPC_URL}`);

  const orders = await rpc('mersennet_orders_getOpenOrders', [OWNER]);
  console.log(`Found ${orders.length} open orders`);

  if (orders.length === 0) {
    console.log('Nothing to drain');
    return;
  }

  const ids = orders.map(o => o.order_id || o.id).filter(Boolean);
  let cancelled = 0;
  let failed = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(id => rpc('mersennet_orders_cancelOrder', [id]))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') cancelled++;
      else failed++;
    }

    const pct = ((i + batch.length) / ids.length * 100).toFixed(1);
    process.stdout.write(`\r  Progress: ${cancelled} cancelled, ${failed} failed (${pct}%)`);

    if (i + BATCH_SIZE < ids.length) {
      await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
  }

  console.log(`\nDone. Cancelled: ${cancelled}, Failed: ${failed}`);

  const remaining = await rpc('mersennet_orders_getOpenOrders', [OWNER]);
  console.log(`Remaining orders: ${remaining.length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
