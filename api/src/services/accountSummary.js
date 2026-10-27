const { ethers } = require('ethers');
const pool = require('../db/pool');
const explorer = require('../db/explorerPool');
const chain = require('./chain');
const nodeRewards = require('./nodeRewards');

// One wallet's lifetime result on every product, in MRSN and dollars.
//   exchange: equity on the order book (native collateral + open PnL) minus
//             the MRSN it deposited net of withdrawals
//   vault:    value of its shares plus withdrawals minus deposits
//   staking:  delegation rewards not claimed yet (the chain does not report
//             what past claims paid)
//   node:     operator earnings since epoch accounting began (nodeRewards.js)
//   referrals: points only; referrals pay no MRSN
const CLOB = '0x0000000000000000000000000000000000000100';
const STAKING = '0x0000000000000000000000000000000000000400';
const CLOB_IFACE = new ethers.Interface([
  'function depositCollateral(uint256 amount)',
  'function withdrawCollateral(uint256 amount)',
]);
const VAULT = process.env.VAULT_ADDRESS || '0xe77F94c4Bf7D6d2E2371aFdE440a0b9b8a567725';
const VAULT_IFACE = new ethers.Interface([
  'function sharesOf(address) view returns (uint256)',
  'function nav() view returns (uint256)',
  'function totalShares() view returns (uint256)',
]);
const STAKING_IFACE = new ethers.Interface([
  'function claimRewards(address validator)',
  'function getDelegation(address delegator, address validator) view returns (uint256 amount, uint256 pending)',
]);
const SEL = {
  deposit: CLOB_IFACE.getFunction('depositCollateral').selector,
  withdraw: CLOB_IFACE.getFunction('withdrawCollateral').selector,
  claim: STAKING_IFACE.getFunction('claimRewards').selector,
};
// Collateral was counted in wei before the settlement switch, in MRSN after.
const SETTLEMENT_HEIGHT = 1_605_600;
const weiToMrsn = (wei) => Number(wei / 10n ** 12n) / 1e6;

const TTL_MS = 30_000;
const cache = new Map();

async function exchange(addr, protocol) {
  const settlement = Number(protocol?.switches?.settlementHeight) || SETTLEMENT_HEIGHT;
  const [{ rows }, collateral] = await Promise.all([
    explorer.query(
      `SELECT method_id, input, block_number FROM transactions
        WHERE from_addr = $1 AND to_addr = $2 AND status = 1 AND method_id = ANY($3)`,
      [addr, CLOB, [SEL.deposit, SEL.withdraw]],
    ),
    chain.getMarginCollateral(addr),
  ]);
  let deposited = 0;
  let withdrawn = 0;
  for (const r of rows) {
    const units = BigInt('0x' + (r.input.slice(10, 74) || '0'));
    const amount = Number(r.block_number) < settlement ? weiToMrsn(units) : Number(units);
    if (r.method_id === SEL.deposit) deposited += amount; else withdrawn += amount;
  }
  let unrealized = 0;
  for (const m of chain.MARKETS) {
    const pos = await chain.getPosition(m.id, addr);
    if (!pos.size || Math.abs(pos.size) < 1e-12) continue;
    const mark = (await chain.chainMarkOf(m.id).catch(() => null))?.usd || pos.entryPrice;
    unrealized += pos.size * (mark - pos.entryPrice);
  }
  const equity = collateral.native + unrealized;
  return { mrsn: equity - (deposited - withdrawn), equity, unrealized, deposited, withdrawn };
}

async function vaultValueOnChain(addr) {
  const call = (fn, args = []) => chain.rpcCall('eth_call', [{ to: VAULT, data: VAULT_IFACE.encodeFunctionData(fn, args) }, 'latest'])
    .then((out) => VAULT_IFACE.decodeFunctionResult(fn, out)[0]);
  const [shares, nav, total] = await Promise.all([call('sharesOf', [addr]), call('nav'), call('totalShares')]);
  return total > 0n ? weiToMrsn((shares * nav) / total) : 0;
}

async function vault(addr) {
  const [{ rows: flows }, { rows: state }] = await Promise.all([
    pool.query(
      `SELECT action, COALESCE(SUM(amount), 0)::float8 AS amount, COALESCE(SUM(shares), 0)::float8 AS shares
         FROM vault_deposits WHERE address = $1 GROUP BY action`,
      [addr],
    ),
    pool.query('SELECT total_shares, total_tvl FROM vault_state WHERE id = 1'),
  ]);
  const dep = flows.find((r) => r.action === 'deposit') || { amount: 0, shares: 0 };
  const wd = flows.find((r) => r.action === 'withdraw') || { amount: 0, shares: 0 };
  if (!dep.amount && !wd.amount) return { mrsn: 0, value: 0, deposited: 0, withdrawn: 0 };
  // The contract's own figure; the indexer's copy of the vault state trails it slightly.
  const value = await vaultValueOnChain(addr).catch(() => {
    const totalShares = Number(state[0]?.total_shares || 0);
    return totalShares > 0 ? ((dep.shares - wd.shares) / totalShares) * Number(state[0].total_tvl || 0) : 0;
  });
  return { mrsn: value + wd.amount - dep.amount, value, deposited: dep.amount, withdrawn: wd.amount };
}

async function staking(addr, validators) {
  const reads = await Promise.allSettled(validators.map((v) => chain.rpcCall('eth_call', [
    { to: STAKING, data: STAKING_IFACE.encodeFunctionData('getDelegation', [addr, v.identity]) }, 'latest',
  ])));
  let delegated = 0n;
  let unclaimed = 0n;
  const delegations = [];
  reads.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const [amount, pending] = STAKING_IFACE.decodeFunctionResult('getDelegation', r.value);
    if (amount === 0n && pending === 0n) return;
    delegated += amount;
    unclaimed += pending;
    delegations.push({ validator: validators[i].identity, amount: weiToMrsn(amount), unclaimed: weiToMrsn(pending) });
  });
  const { rows } = await explorer.query(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE from_addr = $1 AND to_addr = $2 AND method_id = $3 AND status = 1`,
    [addr, STAKING, SEL.claim],
  );
  return { mrsn: weiToMrsn(unclaimed), delegated: weiToMrsn(delegated), unclaimed: weiToMrsn(unclaimed), claims: rows[0].n, delegations };
}

async function node(addr, validators, epochBlocks) {
  const mine = validators.filter((v) => String(v.operator || '').toLowerCase() === addr);
  const [totals, { rows }] = await Promise.all([
    nodeRewards.operatorTotals(addr),
    pool.query('SELECT COALESCE(SUM(node_points), 0)::float8 AS p FROM points_balance WHERE address = $1', [addr]),
  ]);
  return {
    mrsn: Number(totals.mrsn) || 0,
    sinceBlock: totals.since_epoch != null ? Number(totals.since_epoch) * epochBlocks : null,
    nodePoints: Number(rows[0].p) || 0,
    validators: mine.map((v) => ({ identity: v.identity, status: v.status, blocksProposed: Number(v.totalProposed) || 0 })),
  };
}

async function referrals(addr) {
  const [{ rows: refs }, { rows: pts }] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM referrals WHERE lower(referrer) = $1', [addr]),
    pool.query('SELECT COALESCE(SUM(referral_points), 0)::float8 AS p FROM points_balance WHERE address = $1', [addr]),
  ]);
  return { mrsn: 0, referees: refs[0].n, referralPoints: Number(pts[0].p) || 0 };
}

async function build(addr) {
  const [protocol, vs, price] = await Promise.all([
    chain.getProtocol().catch(() => null),
    chain.rpcCall('mersennet_validatorSet', []),
    chain.getMarkPrice(1).then((p) => chain.toHumanPrice(1, p) || null).catch(() => null),
  ]);
  const validators = vs?.validators || [];
  const epochBlocks = Number(vs?.params?.epochBlocks) || 1800;
  const settle = (key, p) => p.then((value) => ({ value })).catch((e) => {
    console.log(`[account] ${key} ${addr}: ${e.message}`);
    return { error: e.message };
  });
  const [ex, va, st, no, re] = await Promise.all([
    settle('exchange', exchange(addr, protocol)), settle('vault', vault(addr)), settle('staking', staking(addr, validators)),
    settle('node', node(addr, validators, epochBlocks)), settle('referrals', referrals(addr)),
  ]);
  const product = (key, label, href, r) => ({
    key, label, href,
    mrsn: r.value ? r.value.mrsn : null,
    usd: r.value && price ? r.value.mrsn * price : null,
    detail: r.value || null,
    error: r.error ? 'unavailable right now' : null,
  });
  const products = [
    product('exchange', 'Exchange', '/portfolio', ex),
    product('vault', 'Maker Vault', '/vault', va),
    product('staking', 'Staking', '/staking', st),
    product('node', 'Node', '/staking', no),
    product('referrals', 'Referrals', '/referrals', re),
  ];
  const mrsn = products.reduce((s, p) => s + (p.mrsn || 0), 0);
  return {
    address: addr,
    mrsnUsd: price,
    mrsnUsdSource: 'MRSN/USD market on the testnet',
    products,
    total: { mrsn, usd: price ? mrsn * price : null },
    complete: products.every((p) => !p.error),
    updatedAt: new Date().toISOString(),
  };
}

async function summary(address) {
  const addr = address.toLowerCase();
  const hit = cache.get(addr);
  if (hit && Date.now() - hit.at < (hit.body.complete ? TTL_MS : 5_000)) return hit.body;
  const body = await build(addr);
  if (cache.size > 500) cache.clear();
  cache.set(addr, { at: Date.now(), body });
  return body;
}

module.exports = { summary };
