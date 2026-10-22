const { Router } = require('express');
const { getAdoption, getInternal } = require('../services/adoption');
const { growth } = require('../services/growth');
const { sendError } = require('../middleware/httpError');

const router = Router();

/** Public adoption metrics (aggregates only; cached 5 min in the service). */
router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getAdoption());
  } catch (e) {
    sendError(res, e, 'stats/adoption');
  }
});

/** Internal view: the addresses and hosts behind the aggregates. Admin key required. */
router.get('/internal', async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || req.get('X-Admin-Key') !== adminKey) return res.status(401).json({ error: 'admin key required' });
    res.set('Cache-Control', 'no-store');
    const [pub, internal] = await Promise.all([getAdoption(), getInternal()]);
    res.json({ ...pub, internal });
  } catch (e) {
    sendError(res, e, 'stats/adoption/internal');
  }
});

/** Internal: first appearances per day and the last full week against the one before. Admin key required. */
router.get('/growth', async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || req.get('X-Admin-Key') !== adminKey) return res.status(401).json({ error: 'admin key required' });
    res.set('Cache-Control', 'no-store');
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    const pub = await getAdoption().catch(() => null);
    res.json(await growth(days, pub?.community?.telegramMembers ?? null));
  } catch (e) {
    sendError(res, e, 'stats/adoption/growth');
  }
});

module.exports = router;
