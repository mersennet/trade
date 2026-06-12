const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { hashKey } = require('../middleware/apiKey');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

router.get('/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      `SELECT id, label, permissions, rate_limit, active, created_at, last_used_at 
       FROM api_keys WHERE address = $1 ORDER BY created_at DESC`,
      [addr]
    );
    res.json({ keys: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', strictLimiter, async (req, res) => {
  try {
    const { address, label, permissions } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });
    const addr = address.toLowerCase();
    const rawKey = `mt_${crypto.randomBytes(32).toString('hex')}`;
    const hash = hashKey(rawKey);
    const perms = permissions || ['read', 'trade'];

    await pool.query(
      `INSERT INTO api_keys (address, key_hash, label, permissions, active) VALUES ($1, $2, $3, $4, true)`,
      [addr, hash, label || 'My API Key', perms]
    );

    res.json({ key: rawKey, label: label || 'My API Key', permissions: perms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', strictLimiter, async (req, res) => {
  try {
    await pool.query('UPDATE api_keys SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
