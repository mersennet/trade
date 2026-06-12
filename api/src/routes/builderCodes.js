const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');
const crypto = require('crypto');

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT code, owner, label, fee_share_bps, total_volume, total_fees_earned, total_orders, created_at
       FROM builder_codes WHERE active = true ORDER BY total_volume DESC`
    );
    res.json({ codes: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:code', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM builder_codes WHERE code = $1', [req.params.code]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Builder code not found' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/owner/:address', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM builder_codes WHERE owner = $1', [req.params.address.toLowerCase()]
    );
    res.json({ codes: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', strictLimiter, async (req, res) => {
  try {
    const { owner, label, code } = req.body;
    if (!owner) return res.status(400).json({ error: 'Missing owner address' });

    const builderCode = code || crypto.randomBytes(4).toString('hex');

    const existing = await pool.query('SELECT code FROM builder_codes WHERE code = $1', [builderCode]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Code already exists' });

    await pool.query(
      `INSERT INTO builder_codes (code, owner, label) VALUES ($1, $2, $3)`,
      [builderCode, owner.toLowerCase(), label || null]
    );

    res.json({ code: builderCode, owner: owner.toLowerCase(), timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
