// Settlement switch awareness. From `settlementHeight` one collateral unit is
// one MRSN and the CLOB enforces initial margin, so the bots must hold real
// MRSN collateral. The unit is era-dependent (1 wei before the switch, 1 MRSN
// after — `weiPerCollateralUnit` from getProtocol), so `ensureUnits` works in
// MRSN and converts: a deposit made before the switch in wei-units is the same
// number of MRSN after it (the migration divides balances by 1e18). That is
// why the bots pre-fund now instead of racing the liquidation keeper at the
// switch block.
let cache = { at: 0, active: false, height: 0, weiPerUnit: 1n };
const WEI = 10n ** 18n;

async function refreshProtocol(rpcCall) {
  if (Date.now() - cache.at < 30_000) return cache;
  try {
    const p = await rpcCall('mersennet_orders_getProtocol', []);
    let wpu = 1n; try { wpu = BigInt(p?.weiPerCollateralUnit ?? 1); } catch { wpu = 1n; }
    cache = { at: Date.now(), active: !!p?.settlementActive, height: Number(p?.switches?.settlementHeight || 0), weiPerUnit: wpu > 0n ? wpu : 1n };
  } catch { /* keep the last answer */ }
  return cache;
}

async function settlementActive(rpcCall) { return (await refreshProtocol(rpcCall)).active; }
function settlementHeight() { return cache.height; }
/** Collateral units per MRSN in the current era (1e18 before the switch, 1 after). */
function unitsPerMrsn() { return WEI / cache.weiPerUnit; }

/**
 * Deposit until `wallet` holds `targetMrsn` MRSN of collateral (in whatever
 * units the chain uses right now). Returns the MRSN deposited (0 when nothing
 * was needed or affordable). Call `settlementActive(rpcCall)` (or
 * `refreshProtocol`) first so the unit factor is fresh.
 */
async function ensureUnits(wallet, targetMrsn, label) {
  const per = unitsPerMrsn();
  const have = await wallet.getCollateral();
  const target = BigInt(targetMrsn) * per;
  if (have >= target) return 0n;
  const missingUnits = target - have;
  const missingMrsn = (missingUnits + per - 1n) / per;
  const bal = await wallet.balance();
  const gasReserve = WEI; // keep 1 MRSN for gas
  const affordable = bal > gasReserve ? (bal - gasReserve) / WEI : 0n;
  const amountMrsn = missingMrsn < affordable ? missingMrsn : affordable;
  if (amountMrsn <= 0n) {
    console.warn(`[${label}] needs ${missingMrsn} MRSN of collateral but holds only ${Number(bal) / 1e18} MRSN`);
    return 0n;
  }
  const tx = await wallet.depositCollateral(amountMrsn * per);
  console.log(`[${label}] deposited ${amountMrsn} MRSN collateral (had ${have} units, target ${target} units, ${per} units/MRSN) tx ${tx}`);
  return amountMrsn;
}

module.exports = { settlementActive, settlementHeight, unitsPerMrsn, refreshProtocol, ensureUnits };
