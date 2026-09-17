/**
 * Referral attribution.
 *
 * A visitor who lands on ?ref=<code> keeps the code in their browser; once
 * they connect a wallet the terminal asks them to sign a one-line statement
 * and posts it here. The signature is what makes the attribution trustworthy:
 * nobody can attach someone else's wallet to their code. First code wins and
 * is permanent; self-referral is rejected. The indexer then pays the referrer
 * 10 % of the referee's trading points (see indexer awardReferralPoints).
 */
const { Router } = require('express');
const { ethers } = require('ethers');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

const ready = (async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS referrals (
    referee TEXT PRIMARY KEY,
    referrer TEXT NOT NULL,
    code TEXT,
    attributed_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer)`).catch(() => {});
})();

function attributionMessage(code, wallet) {
  return `Mersennet Trade referral\nI was referred by code ${code}\nWallet: ${wallet.toLowerCase()}`;
}

/** GET /api/v1/referrals/message?code=..&wallet=.. — the exact text to sign */
router.get('/message', (req, res) => {
  const { code, wallet } = req.query;
  if (!code || !ethers.isAddress(String(wallet || ''))) return res.status(400).json({ error: 'code and wallet required' });
  res.json({ message: attributionMessage(String(code), String(wallet)) });
});

/** GET /api/v1/referrals/status/:wallet — who referred this wallet (if anyone) and its referral stats */
router.get('/status/:wallet', async (req, res) => {
  await ready;
  const wallet = String(req.params.wallet || '').toLowerCase();
  if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'invalid address' });
  try {
    const [mine, asReferrer] = await Promise.all([
      pool.query('SELECT referrer, code, attributed_at FROM referrals WHERE referee = $1', [wallet]),
      pool.query(
        `SELECT COUNT(*)::int AS referees,
                COALESCE((SELECT referral_points FROM points_balance WHERE address = $1 AND season = 1), 0)::float8 AS referral_points
           FROM referrals WHERE referrer = $1`,
        [wallet]
      ),
    ]);
    res.json({
      referredBy: mine.rows[0] ? { referrer: mine.rows[0].referrer, code: mine.rows[0].code, at: mine.rows[0].attributed_at } : null,
      referees: asReferrer.rows[0]?.referees || 0,
      referralPoints: Number(asReferrer.rows[0]?.referral_points || 0),
      share: 0.10,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/v1/referrals/attribute { wallet, code, signature } */
router.post('/attribute', strictLimiter, async (req, res) => {
  await ready;
  const { wallet, code, signature } = req.body || {};
  const w = String(wallet || '').toLowerCase();
  const c = String(code || '').trim();
  if (!ethers.isAddress(w)) return res.status(400).json({ error: 'wallet must be a 0x address' });
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(c)) return res.status(400).json({ error: 'invalid code' });
  if (typeof signature !== 'string') return res.status(400).json({ error: 'signature required' });
  try {
    let signer;
    try {
      signer = ethers.verifyMessage(attributionMessage(c, w), signature).toLowerCase();
    } catch {
      return res.status(400).json({ error: 'bad signature' });
    }
    if (signer !== w) return res.status(401).json({ error: 'signature does not match wallet' });

    const owner = await pool.query('SELECT owner FROM builder_codes WHERE code = $1 AND active = true', [c]);
    if (owner.rowCount === 0) return res.status(404).json({ error: 'unknown referral code' });
    const referrer = String(owner.rows[0].owner).toLowerCase();
    if (referrer === w) return res.status(400).json({ error: 'you cannot refer yourself' });

    const existing = await pool.query('SELECT referrer, code FROM referrals WHERE referee = $1', [w]);
    if (existing.rowCount > 0) {
      return res.json({ ok: true, alreadyAttributed: true, referrer: existing.rows[0].referrer, code: existing.rows[0].code });
    }
    await pool.query('INSERT INTO referrals (referee, referrer, code) VALUES ($1, $2, $3) ON CONFLICT (referee) DO NOTHING', [w, referrer, c]);
    await pool.query('UPDATE builder_codes SET total_orders = total_orders + 1 WHERE code = $1', [c]).catch(() => {});
    res.json({ ok: true, referrer, code: c });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
