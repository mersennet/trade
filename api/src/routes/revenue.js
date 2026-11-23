const { Router } = require('express');
const { report } = require('../services/revenue');
const { sendError } = require('../middleware/httpError');

const router = Router();

// Internal: payer categories name our own wallets, so the admin key is required.
router.get('/', async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || req.get('X-Admin-Key') !== adminKey) return res.status(401).json({ error: 'admin key required' });
    res.set('Cache-Control', 'no-store');
    res.json(await report());
  } catch (e) { sendError(res, e, 'admin/revenue'); }
});

module.exports = router;
