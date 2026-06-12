const crypto = require('crypto');
const pool = require('../db/pool');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return next();

  try {
    const hash = hashKey(key);
    const result = await pool.query(
      'SELECT address, permissions, rate_limit FROM api_keys WHERE key_hash = $1 AND active = true',
      [hash]
    );
    if (result.rows.length > 0) {
      req.apiKey = result.rows[0];
      await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1', [hash]);
    }
  } catch (_) {}
  next();
}

function requireApiKey(req, res, next) {
  if (!req.apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  next();
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.apiKey) return res.status(401).json({ error: 'API key required' });
    if (!req.apiKey.permissions.includes(perm) && !req.apiKey.permissions.includes('admin')) {
      return res.status(403).json({ error: `Permission '${perm}' required` });
    }
    next();
  };
}

module.exports = { apiKeyAuth, requireApiKey, requirePermission, hashKey };
