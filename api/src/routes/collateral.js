/**
 * Collateral routes for Mersennet Trade.
 *
 * On Mersennet, collateral is native MRSN held by the MersennetOrders
 * precompile. Deposits and withdrawals are user-signed transactions sent
 * directly to the precompile from the trader's wallet. The API returns
 * the calldata + target address; the frontend handles signing.
 */

const { Router } = require('express');
const chain = require('../services/chain');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Convert a human MRSN amount string (e.g. "100.5") to raw 18-decimal units.
// Throws on invalid input rather than silently coercing to 0.
function humanToRaw(value) {
  if (typeof value === 'string' && value.startsWith('0x')) return BigInt(value);
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${value}`);
  const [int, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(chain.USDC_DECIMALS)).slice(0, chain.USDC_DECIMALS);
  return BigInt(int + fracPadded);
}

router.get('/:address', async (req, res) => {
  try {
    if (!ETH_ADDR_RE.test(req.params.address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }
    // Returns human-readable MRSN values (e.g. 100.5), not raw 18-decimal units.
    const [collateral, free] = await Promise.all([
      chain.getCollateral(req.params.address),
      chain.getFreeCollateral(req.params.address),
    ]);
    const collateralRaw = await chain.getCollateralRaw(req.params.address);
    res.json({
      collateral,        // human (e.g. 100.5 MRSN)
      free,              // human
      collateralRaw,     // raw string for callers that need exact precision
      decimals: chain.USDC_DECIMALS,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/deposit', strictLimiter, async (req, res) => {
  try {
    const { owner, amount } = req.body;
    if (!owner || !amount) return res.status(400).json({ error: 'Missing fields: owner, amount' });
    if (!ETH_ADDR_RE.test(owner.toLowerCase())) return res.status(400).json({ error: 'Invalid owner address' });
    if (Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const value = humanToRaw(amount);
    res.json({
      // Frontend signs and sends this tx; the precompile credits the
      // caller's collateral from the calldata amount.
      tx: {
        to: chain.PRECOMPILE,
        data: chain.depositCalldata(value.toString()),
        value: '0x0',
      },
      // Native collateral — no ERC20 approval step. Frontend skips approve
      // when `token` is empty.
      approve: {
        token: '',
        spender: chain.PRECOMPILE,
        amount: value.toString(),
      },
      amountRaw: value.toString(),
      decimals: chain.USDC_DECIMALS,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Gasless deposit — credits collateral server-side via the unsigned RPC.
// The chain's transaction hashing is not standard-Ethereum compatible, so a
// MetaMask/ethers-signed deposit can't be tracked or confirmed by the wallet.
// Collateral is free on the faucet testnet, so we credit it directly here and
// skip the broken wallet round-trip.
const MAX_GASLESS_DEPOSIT = 1_000_000n; // sane per-call cap (raw collateral units)
router.post('/credit', strictLimiter, async (req, res) => {
  try {
    const { owner, amount } = req.body;
    if (!owner || !amount) return res.status(400).json({ error: 'Missing fields: owner, amount' });
    if (!ETH_ADDR_RE.test(owner.toLowerCase())) return res.status(400).json({ error: 'Invalid owner address' });
    if (Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    const value = humanToRaw(amount);
    if (value > MAX_GASLESS_DEPOSIT) {
      return res.status(400).json({ error: `Amount exceeds testnet cap of ${MAX_GASLESS_DEPOSIT}` });
    }
    await chain.depositCollateralGasless(owner, value);
    const free = await chain.getFreeCollateral(owner);
    res.json({
      ok: true,
      owner,
      credited: value.toString(),
      free,
      decimals: chain.USDC_DECIMALS,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/withdraw', strictLimiter, async (req, res) => {
  try {
    const { owner, amount } = req.body;
    if (!owner || !amount) return res.status(400).json({ error: 'Missing fields: owner, amount' });
    if (!ETH_ADDR_RE.test(owner.toLowerCase())) return res.status(400).json({ error: 'Invalid owner address' });
    if (Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const value = humanToRaw(amount);
    res.json({
      tx: {
        to: chain.PRECOMPILE,
        data: chain.withdrawCalldata(value.toString()),
        value: '0x0',
      },
      amountRaw: value.toString(),
      decimals: chain.USDC_DECIMALS,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
