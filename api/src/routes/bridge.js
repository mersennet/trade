const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

const SUPPORTED_CHAINS = [
  { id: 'ethereum', name: 'Ethereum', chain_id: 1, deposit_address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', confirmations: 12, estimatedTime: '~15 min', status: 'active' },
  { id: 'arbitrum', name: 'Arbitrum One', chain_id: 42161, deposit_address: '0xB27308f9F90D607463bb33eA1BeBb41C27CE5AB6', confirmations: 1, estimatedTime: '~1 min', status: 'active' },
  { id: 'optimism', name: 'Optimism', chain_id: 10, deposit_address: '0x4200000000000000000000000000000000000010', confirmations: 1, estimatedTime: '~2 min', status: 'active' },
  { id: 'polygon', name: 'Polygon', chain_id: 137, deposit_address: '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', confirmations: 32, estimatedTime: '~5 min', status: 'active' },
  { id: 'bsc', name: 'BNB Chain', chain_id: 56, deposit_address: '0x10ED43C718714eb63d5aA57B78B54704E256024E', confirmations: 15, estimatedTime: '~3 min', status: 'active' },
  { id: 'avalanche', name: 'Avalanche', chain_id: 43114, deposit_address: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4', confirmations: 1, estimatedTime: '~2 min', status: 'active' },
  { id: 'base', name: 'Base', chain_id: 8453, deposit_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', confirmations: 1, estimatedTime: '~1 min', status: 'active' },
  { id: 'solana', name: 'Solana', chain_id: null, deposit_address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', confirmations: 32, estimatedTime: '~30 sec', status: 'active' },
];

router.get('/chains', async (req, res) => {
  try {
    const chains = await pool.query('SELECT * FROM bridge_chains WHERE active = true');
    if (chains.rows.length > 0) {
      return res.json({ chains: chains.rows });
    }
    res.json({ chains: SUPPORTED_CHAINS });
  } catch (e) {
    res.json({ chains: SUPPORTED_CHAINS });
  }
});

router.post('/deposit', strictLimiter, async (req, res) => {
  try {
    const { address, source_chain, tx_hash, amount, asset } = req.body;
    if (!address || !source_chain || !tx_hash || !amount) {
      return res.status(400).json({ error: 'address, source_chain, tx_hash, and amount are required' });
    }

    const chain = SUPPORTED_CHAINS.find(c => c.id === source_chain);
    if (!chain) {
      return res.status(400).json({ error: `Unsupported chain: ${source_chain}` });
    }

    const existing = await pool.query(
      'SELECT id FROM bridge_deposits WHERE tx_hash = $1',
      [tx_hash]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Deposit already tracked' });
    }

    const result = await pool.query(
      `INSERT INTO bridge_deposits
       (address, source_chain, tx_hash, amount, asset, status, confirmations, required_confirmations, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, NOW()) RETURNING *`,
      [
        address.toLowerCase(), source_chain, tx_hash,
        Number(amount), asset || 'USDC', chain.confirmations,
      ]
    );

    res.json({ deposit: result.rows[0], estimatedTime: chain.estimatedTime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
