// Settlement switch awareness. From `settlementHeight` one collateral unit is
// one MRSN and the CLOB enforces initial margin, so the bots must hold real
// MRSN collateral: `ensureUnits` tops a wallet up to `targetUnits` (deposits
// only what is missing, never more than the wallet can pay).
let cache = { at: 0, active: false, height: 0 };

async function settlementActive(rpcCall) {
  if (Date.now() - cache.at < 30_000) return cache.active;
  try {
    const p = await rpcCall('mersennet_orders_getProtocol', []);
    cache = { at: Date.now(), active: !!p?.settlementActive, height: Number(p?.switches?.settlementHeight || 0) };
  } catch { /* keep the last answer */ }
  return cache.active;
}

function settlementHeight() { return cache.height; }

/**
 * Deposit until `wallet` holds `targetUnits` of collateral. Returns the units
 * deposited (0 when nothing was needed or affordable).
 */
async function ensureUnits(wallet, targetUnits, label) {
  const have = await wallet.getCollateral();
  const target = BigInt(targetUnits);
  if (have >= target) return 0n;
  const missing = target - have;
  const bal = await wallet.balance();
  const gasReserve = 10n ** 18n; // keep 1 MRSN for gas
  const affordable = bal > gasReserve ? (bal - gasReserve) / 10n ** 18n : 0n;
  const amount = missing < affordable ? missing : affordable;
  if (amount <= 0n) {
    console.warn(`[${label}] needs ${missing} MRSN of collateral but holds only ${Number(bal) / 1e18} MRSN`);
    return 0n;
  }
  const tx = await wallet.depositCollateral(amount);
  console.log(`[${label}] deposited ${amount} MRSN collateral (had ${have}, target ${target}) tx ${tx}`);
  return amount;
}

module.exports = { settlementActive, settlementHeight, ensureUnits };
