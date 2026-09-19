const { Router } = require('express');
const { strictLimiter } = require('../middleware/rateLimit');
const { sendError } = require('../middleware/httpError');
const alerts = require('../services/alerts');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** GET /alerts/status/:address — is this wallet linked to a Telegram chat? */
router.get('/status/:address', async (req, res) => {
  try {
    const address = String(req.params.address || '').toLowerCase();
    if (!ETH_ADDR_RE.test(address)) return res.status(400).json({ error: 'Invalid address' });
    const links = await alerts.linksFor(address);
    res.json({
      linked: links.length > 0,
      bot: await alerts.botName(),
      chats: links.map((l) => ({ kind: l.kind, username: l.username, linkedAt: l.linked_at })),
    });
  } catch (e) { sendError(res, e, 'alerts'); }
});

/**
 * POST /alerts/link { address, kind, signature }
 * `signature` is the wallet's signature over alerts.linkMessage(address, kind,
 * <current UTC minute>) — proves control of the address without a session.
 * Answers a one-time deep link to the bot.
 */
router.post('/link', strictLimiter, async (req, res) => {
  try {
    const { address, kind = 'operator', signature } = req.body || {};
    if (!ETH_ADDR_RE.test(String(address || ''))) return res.status(400).json({ error: 'Invalid address' });
    if (!alerts.KINDS.has(kind)) return res.status(400).json({ error: 'kind must be operator or trader' });
    if (typeof signature !== 'string' || !alerts.verifyLinkSignature(address, kind, signature)) {
      return res.status(401).json({ error: 'Signature does not match the address (or is older than 10 minutes)' });
    }
    const { code, deepLink } = await alerts.createLinkCode(address, kind);
    res.json({ code, deepLink, expiresInSec: 900 });
  } catch (e) { sendError(res, e, 'alerts'); }
});

/** POST /alerts/unlink { address, signature } — same proof; removes every chat for the address. */
router.post('/unlink', strictLimiter, async (req, res) => {
  try {
    const { address, signature } = req.body || {};
    if (!ETH_ADDR_RE.test(String(address || ''))) return res.status(400).json({ error: 'Invalid address' });
    const ok = ['operator', 'trader'].some((k) => typeof signature === 'string' && alerts.verifyLinkSignature(address, k, signature));
    if (!ok) return res.status(401).json({ error: 'Signature does not match the address (or is older than 10 minutes)' });
    await alerts.unlinkAddress(address);
    res.json({ unlinked: true });
  } catch (e) { sendError(res, e, 'alerts'); }
});

module.exports = router;
