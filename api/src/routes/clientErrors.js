const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');

// Client-side error intake for the terminal. The browser posts uncaught
// exceptions, unhandled rejections and error-boundary hits (see
// web/src/lib/errorReporter.ts). Stored for the admin API and forwarded to
// the ops Telegram group, de-duplicated by message so one broken chunk does
// not page us a thousand times: the same (message, page) posts at most once
// per 10 minutes with a count.
const router = Router();

// On the standby (read-only replica) the table already exists via replication.
const ready = process.env.API_ROLE === 'standby' ? Promise.resolve() : pool.query(`CREATE TABLE IF NOT EXISTS client_errors (
  id BIGSERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  stack TEXT,
  page TEXT,
  kind TEXT,
  build TEXT,
  ua TEXT,
  wallet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`).catch((e) => console.error('[client-errors] table:', e.message));

const limiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

const recent = new Map(); // key -> { count, firstAt, notifiedAt }
const DEDUP_MS = 10 * 60_000;

function notify(key, entry, body) {
  const tgToken = process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.FEEDBACK_TELEGRAM_CHAT_ID;
  if (!tgToken || !tgChat) return;
  const text = `🐞 terminal ${body.kind || 'error'}${entry.count > 1 ? ` ×${entry.count}` : ''}` +
    `\n${String(body.message).slice(0, 300)}` +
    (body.page ? `\npage: ${String(body.page).slice(0, 120)}` : '') +
    (body.build ? `\nbuild: ${String(body.build).slice(0, 40)}` : '') +
    (body.ua ? `\nua: ${String(body.ua).slice(0, 100)}` : '') +
    (body.stack ? `\n\n${String(body.stack).split('\n').slice(0, 4).join('\n').slice(0, 600)}` : '');
  fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChat, text, disable_web_page_preview: true }),
  }).catch((e) => console.warn('[client-errors] telegram fail:', e.message));
}

router.post('/', limiter, async (req, res) => {
  await ready;
  const b = req.body || {};
  const message = typeof b.message === 'string' ? b.message.slice(0, 1000) : '';
  if (!message) return res.status(400).json({ error: 'message required' });
  // Browser-extension and wallet-injection noise is not ours.
  if (/chrome-extension:|moz-extension:|ResizeObserver loop|Script error\.$/i.test(message + ' ' + (b.stack || ''))) return res.json({ ok: true, ignored: true });
  const row = {
    message,
    stack: typeof b.stack === 'string' ? b.stack.slice(0, 4000) : null,
    page: typeof b.page === 'string' ? b.page.slice(0, 300) : null,
    kind: typeof b.kind === 'string' ? b.kind.slice(0, 40) : 'error',
    build: typeof b.build === 'string' ? b.build.slice(0, 64) : null,
    ua: (req.headers['user-agent'] || '').slice(0, 300),
    wallet: typeof b.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(b.wallet) ? b.wallet.toLowerCase() : null,
  };
  try {
    await pool.query(
      `INSERT INTO client_errors (message, stack, page, kind, build, ua, wallet) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.message, row.stack, row.page, row.kind, row.build, row.ua, row.wallet]
    );
  } catch (e) { console.error('[client-errors] insert:', e.message); }
  const key = `${row.message.slice(0, 120)}|${(row.page || '').replace(/\?.*$/, '')}`;
  const now = Date.now();
  const entry = recent.get(key) || { count: 0, firstAt: now, notifiedAt: 0 };
  entry.count += 1;
  if (now - entry.notifiedAt > DEDUP_MS) { notify(key, entry, row); entry.notifiedAt = now; entry.count = 0; }
  recent.set(key, entry);
  if (recent.size > 500) for (const [k, v] of recent) if (now - v.notifiedAt > DEDUP_MS) recent.delete(k);
  res.json({ ok: true });
});

// Admin read: recent errors (same key as the feedback admin API).
router.get('/', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  await ready;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const r = await pool.query(`SELECT id, message, page, kind, build, ua, wallet, created_at FROM client_errors ORDER BY id DESC LIMIT $1`, [limit]);
  res.json({ errors: r.rows });
});

module.exports = router;
