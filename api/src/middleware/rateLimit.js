const rateLimit = require('express-rate-limit');

function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  // A trading terminal polls several endpoints per page plus WS handshakes;
  // 300/min was tripping on ordinary multi-page sessions.
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: isLocalhost,
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded for write operations.' },
  skip: isLocalhost,
});

module.exports = { apiLimiter, strictLimiter };
