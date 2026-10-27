const { Router } = require('express');
const { summary } = require('../services/accountSummary');
const { sendError } = require('../middleware/httpError');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

router.get('/:address/summary', async (req, res) => {
  try {
    if (!ETH_ADDR_RE.test(req.params.address)) return res.status(400).json({ error: 'Invalid address' });
    res.set('Cache-Control', 'public, max-age=30');
    res.json(await summary(req.params.address));
  } catch (e) { sendError(res, e, 'account/summary'); }
});

module.exports = router;
