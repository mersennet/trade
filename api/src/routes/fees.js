const { Router } = require('express');
const chain = require('../services/chain');
const { sendError } = require('../middleware/httpError');

const router = Router();

// Median gas of each action on chain 131071 (explorer index, 2,000 recent
// transactions of each kind, 27 Oct 2026).
const ACTIONS = [
  { key: 'transfer', label: 'Send MRSN', gas: 21_000 },
  { key: 'order', label: 'Place or cancel an order', gas: 72_000 },
  { key: 'delegate', label: 'Delegate stake', gas: 62_000 },
];
const TTL_MS = 30_000;
let cached = null;

async function fees() {
  const p = await chain.getProtocol();
  const f = p.fees || {};
  const baseFeeWei = BigInt(f.baseFeeWei || f.minBaseFeeWei || 0);
  const minBaseFeeWei = BigInt(f.minBaseFeeWei || 0);
  // MRSN has no outside market: the testnet's MRSN/USD market gives its price.
  let mrsnUsd = null;
  try { mrsnUsd = chain.toHumanPrice(1, await chain.getMarkPrice(1)) || null; } catch { /* no price */ }
  const gwei = (wei) => Number(wei) / 1e9;
  return {
    baseFeeGwei: gwei(baseFeeWei),
    minBaseFeeGwei: gwei(minBaseFeeWei),
    split: { treasuryPct: (f.treasuryBps || 0) / 100, proposerPct: (f.proposerBps || 0) / 100, burnPct: (f.burnBps || 0) / 100 },
    mrsnUsd,
    mrsnUsdSource: 'MRSN/USD market on the testnet',
    actions: ACTIONS.map((a) => {
      const mrsn = Number(baseFeeWei * BigInt(a.gas)) / 1e18;
      return { ...a, mrsn, usd: mrsnUsd ? mrsn * mrsnUsd : null };
    }),
    updatedAt: new Date().toISOString(),
  };
}

/** What a transaction costs now: the base fee, its split, and typical actions in MRSN and USD. */
router.get('/', async (req, res) => {
  try {
    if (!cached || Date.now() - cached.at > TTL_MS) cached = { at: Date.now(), body: await fees() };
    res.set('Cache-Control', 'public, max-age=30');
    res.json(cached.body);
  } catch (e) {
    sendError(res, e, 'stats/fees');
  }
});

module.exports = router;
