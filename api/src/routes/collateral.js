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
const { sendError } = require('../middleware/httpError');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Convert a human MRSN amount string (e.g. "100.5") to raw collateral units
// for the current era (wei before the settlement switch, whole MRSN after).
// Throws on invalid input rather than silently coercing to 0.
async function humanToRaw(value) {
  if (typeof value === 'string' && value.startsWith('0x')) return BigInt(value);
  await chain.getProtocol();
  return chain.mrsnToUnits(value);
}

router.get('/:address', async (req, res) => {
  try {
    if (!ETH_ADDR_RE.test(req.params.address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }
    // Human-readable MRSN values (e.g. 100.5), not raw units. `collateral` is
    // what the chain counts as margin: native MRSN plus registered token
    // collateral at its weight (USDC at 90%); `native` is the MRSN part alone
    // (the only part a native withdrawal can move).
    const [margin, collateralRaw] = await Promise.all([
      chain.getMarginCollateral(req.params.address),
      chain.getCollateralRaw(req.params.address),
    ]);
    res.json({
      collateral: margin.collateral,   // human, total margin (native + weighted tokens)
      native: margin.native,           // human, native MRSN collateral
      tokenMarginValue: margin.tokenMarginValue,
      tokens: margin.tokens,           // [{ token, symbol, amount, marginValue, weightBps }]
      free: margin.native,             // legacy field: withdrawable native MRSN
      collateralRaw,                   // raw native units for callers that need exact precision
      decimals: chain.collateralDecimals(),
      timestamp: Date.now(),
    });
  } catch (e) {
    sendError(res, e, 'collateral');
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

    const value = await humanToRaw(amount);
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
      decimals: chain.collateralDecimals(),
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Gasless deposit is permanently disabled. The unsigned
// mersennet_orders_depositCollateral RPC let anyone credit (and drain via
// trading) any address. Deposits must be wallet-signed placeOrder/deposit
// txs to the CLOB precompile (0x…0100). Use POST /deposit for the calldata.
router.post('/credit', strictLimiter, async (_req, res) => {
  res.status(410).json({
    error: 'Gasless collateral credit is disabled. Sign a depositCollateral transaction to the CLOB precompile (0x…0100).',
    code: 'SIGNED_DEPOSIT_REQUIRED',
  });
});

router.post('/withdraw', strictLimiter, async (req, res) => {
  try {
    const { owner, amount } = req.body;
    if (!owner || !amount) return res.status(400).json({ error: 'Missing fields: owner, amount' });
    if (!ETH_ADDR_RE.test(owner.toLowerCase())) return res.status(400).json({ error: 'Invalid owner address' });
    if (Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const value = await humanToRaw(amount);
    res.json({
      tx: {
        to: chain.PRECOMPILE,
        data: chain.withdrawCalldata(value.toString()),
        value: '0x0',
      },
      amountRaw: value.toString(),
      decimals: chain.collateralDecimals(),
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
