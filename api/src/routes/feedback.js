/**
 * Feedback collection endpoint for beta testers.
 * Stores submissions in the database and (optionally) forwards to a webhook.
 *
 * POST /api/v1/feedback
 *   {category, message, contact, wallet, userAgent, page, submittedAt}
 *
 * Rate-limited at the nginx layer; we additionally cap message size here.
 */
const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

const MAX_MESSAGE = 4000;
const ALLOWED_CATEGORIES = new Set(['bug', 'feature', 'security', 'other']);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id           BIGSERIAL PRIMARY KEY,
      category     TEXT NOT NULL,
      message      TEXT NOT NULL,
      contact      TEXT,
      wallet       TEXT,
      user_agent   TEXT,
      page         TEXT,
      ip_hash      TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_submitted ON feedback (submitted_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback (category)`);
}

const tableReady = ensureTable().catch((e) => {
  console.error('[feedback] failed to create table:', e.message);
});

const crypto = require('crypto');
function hashIp(req) {
  const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + (process.env.FEEDBACK_IP_SALT || 'mersennet-trade')).digest('hex').slice(0, 16);
}

router.post('/', async (req, res) => {
  await tableReady;
  try {
    let { category, message, contact, wallet, userAgent, page } = req.body || {};

    if (!ALLOWED_CATEGORIES.has(category)) category = 'other';
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    if (message.length > MAX_MESSAGE) message = message.slice(0, MAX_MESSAGE);
    if (typeof contact === 'string' && contact.length > 200) contact = contact.slice(0, 200);
    if (typeof wallet === 'string' && wallet.length > 64) wallet = wallet.slice(0, 64);
    if (typeof userAgent === 'string' && userAgent.length > 500) userAgent = userAgent.slice(0, 500);
    if (typeof page === 'string' && page.length > 500) page = page.slice(0, 500);

    const ipHash = hashIp(req);

    const r = await pool.query(
      `INSERT INTO feedback (category, message, contact, wallet, user_agent, page, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, submitted_at`,
      [category, message, contact || null, wallet || null, userAgent || null, page || null, ipHash]
    );

    // Optional: forward to a webhook (Discord, Slack, ntfy.sh, etc.)
    const hook = process.env.FEEDBACK_WEBHOOK_URL;
    if (hook) {
      const payload = {
        content: `**[${category}] feedback #${r.rows[0].id}**\nWallet: \`${wallet || 'n/a'}\`\nContact: ${contact || 'n/a'}\n\n${message.slice(0, 1500)}`,
      };
      fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((e) => console.warn('[feedback] webhook fail:', e.message));
    }

    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error('[feedback] insert error:', e.message);
    res.status(500).json({ error: 'failed to save feedback' });
  }
});

// Admin-only: read recent submissions (requires X-Admin-Key header)
router.get('/', async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey || req.get('X-Admin-Key') !== adminKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const r = await pool.query(
      `SELECT id, category, message, contact, wallet, page, submitted_at
       FROM feedback ORDER BY submitted_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ items: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
