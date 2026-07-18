const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

// The bridge is NOT LIVE. There is no relayer and no protocol-owned deposit
// address, so this API must never present an address as a deposit target —
// anything sent to a third-party address is unrecoverable. A previous version
// listed well-known mainnet contract addresses (routers, token contracts) as
// "active" deposit addresses; those were removed because funds sent there are
// lost. When a real bridge ships, drive this from server-side config, never
// from a hardcoded list.
router.get('/chains', async (req, res) => {
  res.json({ chains: [], status: 'disabled', message: 'Cross-chain bridge is not live yet. Do not send funds to any address claiming to be a Mersennet bridge deposit address.' });
});

router.post('/deposit', strictLimiter, async (req, res) => {
  res.status(503).json({ error: 'Bridge deposits are disabled: the bridge is not live. Do not send funds to any address claiming to be a Mersennet bridge deposit address.' });
});

router.get('/deposits/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const result = await pool.query(
      'SELECT * FROM bridge_deposits WHERE address = $1 ORDER BY created_at DESC LIMIT $2',
      [addr, limit]
    );
    res.json({ address: addr, deposits: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, deposits: [] });
  }
});

router.get('/status/:txHash', async (req, res) => {
  try {
    const { txHash } = req.params;
    const result = await pool.query(
      'SELECT * FROM bridge_deposits WHERE tx_hash = $1',
      [txHash]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Deposit not found' });
    }
    const deposit = result.rows[0];
    res.json({
      txHash,
      status: deposit.status,
      confirmations: deposit.confirmations,
      requiredConfirmations: deposit.required_confirmations,
      amount: Number(deposit.amount),
      asset: deposit.asset,
      sourceChain: deposit.source_chain,
      createdAt: deposit.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
