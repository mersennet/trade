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

async function tick() {
  if (!(await settlementActive(rpcCall))) {
    if (Date.now() - lastIdleLog > 3_600_000) { console.log('[liq] settlement not active yet — idle'); lastIdleLog = Date.now(); }
    return;
  }
  const r = await rpcCall('mersennet_orders_getLiquidatable', []);
  const accounts = (r?.accounts || []).map((a) => a.toLowerCase());
  for (const [a, t] of inflight) if (Date.now() - t > 30_000 || !accounts.includes(a)) inflight.delete(a);
  for (const account of accounts) {
    if (inflight.has(account)) continue;
    if (account === keeper.address.toLowerCase()) continue;
    try {
      const tx = await keeper.liquidate(account);
      if (tx) { inflight.set(account, Date.now()); console.log(`[liq] liquidating ${account} tx ${tx}`); }
    } catch (e) {
      console.warn(`[liq] ${account}: ${e.message}`);
    }
  }
}

(async () => {
  console.log(`[liq] keeper ${keeper.address} · poll ${POLL_MS / 1000}s · rpc ${RPC_URL}`);
  const bal = await keeper.balance().catch(() => 0n);
  console.log(`[liq] balance ${Number(bal) / 1e18} MRSN (gas; the maker tops it up), collateral ${await keeper.getCollateral().catch(() => 0n)} units`);
  setInterval(() => tick().catch((e) => console.warn('[liq] tick:', e.message)), POLL_MS);
})();
