const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

router.post('/magic-link', strictLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await pool.query(
      `INSERT INTO auth_magic_links (email, token, expires_at, used, created_at)
       VALUES ($1, $2, $3, false, NOW())`,
      [email.toLowerCase(), token, expiresAt]
    );

    const magicLink = `${process.env.APP_URL || 'https://trade.mersennet.com'}/auth/verify?token=${token}`;

    res.json({
      success: true,
      message: 'Magic link sent to email',
      expiresIn: '15 minutes',
      ...(process.env.NODE_ENV === 'development' ? { token, magicLink } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/verify', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    await client.query('BEGIN');

    const result = await client.query(
      "SELECT * FROM auth_magic_links WHERE token = $1 AND used = false AND expires_at > NOW()",
      [token]
    );

    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const magicLink = result.rows[0];

    await client.query(
      'UPDATE auth_magic_links SET used = true WHERE id = $1',
      [magicLink.id]
    );

    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await client.query(
      `INSERT INTO auth_sessions (email, token, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [magicLink.email, sessionToken, expiresAt]
    );

    await client.query('COMMIT');

    res.json({
      session: {
        token: sessionToken,
        email: magicLink.email,
        expiresAt,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/session/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      "SELECT * FROM auth_sessions WHERE token = $1 AND expires_at > NOW()",
      [token]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ valid: false, error: 'Invalid or expired session' });
    }

    const session = result.rows[0];
    res.json({
      valid: true,
      email: session.email,
      expiresAt: session.expires_at,
      createdAt: session.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
