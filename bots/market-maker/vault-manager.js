// Vault manager — keeps the MakerVault wired to the market maker.
//
// The maker bot key is the vault's manager (it deployed the contract). Every
// cycle this process:
//   1. grants the maker key as the vault's trading *agent* on the precompile
//      once agent delegation is active (setAgent(maker, +~30 days), renewed
//      when < 3 days remain) — from then on the maker's orders are booked to
//      the vault when the maker runs with MM_OWNER=<vault>;
//   2. pushes depositors' MRSN onto the precompile as collateral, keeping
//      RESERVE_BPS of NAV free in the contract for instant withdrawals;
//   3. mirrors each market's on-chain priceScale into the vault so its NAV
//      marks positions correctly.
// Manager-only calls are signed by the maker key directly (not through the
// precompile), so this runs alongside the maker without sharing its nonce.
const { ethers } = require('ethers');
const { refreshScales, scaleOf } = require('./scale');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const CHAIN_ID = Number(process.env.CHAIN_ID || 131071);
const VAULT = process.env.VAULT_ADDRESS;
if (!VAULT) { console.error('[vault] VAULT_ADDRESS missing'); process.exit(1); }
const RESERVE_BPS = Number(process.env.VAULT_RESERVE_BPS || 1000); // 10 % of NAV stays free
const MIN_PUSH = ethers.parseEther(process.env.VAULT_MIN_PUSH_MRSN || '100');
const GRANT_BLOCKS = 30 * 43_200;      // ~30 days at 2 s
const RENEW_BELOW = 3 * 43_200;        // renew when < 3 days remain
const CYCLE_MS = Number(process.env.VAULT_CYCLE_MS || 60_000);

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const key = process.env.MM_PRIVATE_KEY || ethers.keccak256(ethers.toUtf8Bytes(`${process.env.BOT_SEED || 'mersennet-bot-v1'}:maker`));
const manager = new ethers.Wallet(key, provider);
const vault = new ethers.Contract(VAULT, [
  'function manager() view returns (address)',
  'function agent() view returns (address)',
  'function nav() view returns (uint256)',
  'function freeBalance() view returns (uint256)',
  'function collateral() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function depositors() view returns (uint256)',
  'function marketList() view returns (uint64[])',
  'function priceScale(uint64) view returns (uint256)',
  'function setAgent(address agent, uint64 expiresAtBlock)',
  'function pushCollateral(uint256 amount)',
  'function setPriceScale(uint64 marketId, uint256 scale)',
], manager);
const orders = new ethers.Contract('0x0000000000000000000000000000000000000100', [
  'function agentOf(address agent) view returns (address owner, uint64 expiresAtBlock)',
], provider);

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

let lastAgentLog = 0;
async function ensureAgent(head) {
  const view = await rpc('mersennet_orders_getAgents', [VAULT]).catch(() => null);
  if (!view || !view.active) {
    if (Date.now() - lastAgentLog > 3_600_000) {
      console.log(`[vault] agent delegation not active yet (switch ${view?.agentDelegationHeight || '?'}, head ${head}) — maker quotes from its own account until then`);
      lastAgentLog = Date.now();
    }
    return false;
  }
  const mine = (view.agents || []).find((a) => a.agent.toLowerCase() === manager.address.toLowerCase());
  if (mine && !mine.expired && (mine.expiresAtBlock === 0 || mine.expiresAtBlock - head > RENEW_BELOW)) return true;
  const expires = head + GRANT_BLOCKS;
  const tx = await vault.setAgent(manager.address, expires, { gasLimit: 200_000 });
  await tx.wait(1);
  console.log(`[vault] granted maker ${manager.address} as agent until block ${expires} (tx ${tx.hash})`);
  return true;
}

async function pushDeposits() {
  const [nav, free] = await Promise.all([vault.nav(), vault.freeBalance()]);
  const reserve = nav * BigInt(RESERVE_BPS) / 10_000n;
  if (free <= reserve) return;
  const amount = free - reserve;
  if (amount < MIN_PUSH) return;
  const tx = await vault.pushCollateral(amount, { gasLimit: 250_000 });
  await tx.wait(1);
  console.log(`[vault] pushed ${ethers.formatEther(amount)} MRSN to collateral (nav ${ethers.formatEther(nav)}, reserve ${ethers.formatEther(reserve)}) tx ${tx.hash}`);
}

async function syncScales() {
  await refreshScales(rpc);
  const markets = await vault.marketList();
  for (const m of markets) {
    const want = BigInt(scaleOf(Number(m)));
    const have = await vault.priceScale(m);
    const haveEff = have === 0n ? 1n : have;
    if (haveEff !== want) {
      const tx = await vault.setPriceScale(m, want, { gasLimit: 100_000 });
      await tx.wait(1);
      console.log(`[vault] market ${m}: priceScale ${haveEff} -> ${want} (tx ${tx.hash})`);
    }
  }
}

async function cycle() {
  try {
    const head = Number(await provider.getBlockNumber());
    const mgr = await vault.manager();
    if (mgr.toLowerCase() !== manager.address.toLowerCase()) {
      console.error(`[vault] ${manager.address} is not the manager (${mgr}); idle`);
      return;
    }
    await ensureAgent(head);
    await pushDeposits();
    await syncScales();
  } catch (e) {
    console.error('[vault] cycle failed:', e.message);
  }
}

(async () => {
  console.log(`[vault] manager ${manager.address} for vault ${VAULT}; reserve ${RESERVE_BPS / 100}% of NAV; cycle ${CYCLE_MS / 1000}s`);
  const [nav, depositors] = await Promise.all([vault.nav(), vault.depositors()]);
  console.log(`[vault] nav ${ethers.formatEther(nav)} MRSN, ${depositors} depositors`);
  await cycle();
  setInterval(cycle, CYCLE_MS);
})();
