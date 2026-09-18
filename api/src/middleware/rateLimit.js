const rateLimit = require('express-rate-limit');

/**
 * Real client address for per-IP limiting.
 *
 * Path in production: browser → Cloudflare → Caddy (host) → this container.
 * Express only sees the Docker bridge gateway as the peer, so `req.ip` is the
 * same string for every visitor and the default key put the whole internet in
 * one 600-req/min bucket. Cloudflare sets and overwrites CF-Connecting-IP with
 * the real client, so that is the trusted source (same rule as the faucet).
 * Fallback: the LAST X-Forwarded-For hop — appended by our own proxy, unlike
 * the first entry which the client controls — then the socket peer.
 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const last = xff.split(',').pop().trim();
    if (last) return last;
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

// One bucket per IPv4 address or per IPv6 /64 (a single subscriber's prefix),
// so a v6 client cannot rotate through 2^64 addresses to dodge the limit.
function bucketKey(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}

function keyGenerator(req) {
  return bucketKey(clientIp(req));
}

function isLocalhost(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  // A trading terminal polls several endpoints per page plus WS handshakes;
  // 300/min was tripping on ordinary multi-page sessions.
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  // keyGenerator handles IPv6 bucketing itself (see bucketKey).
  validate: { ip: false },
  message: { error: 'Too many requests, please try again later.' },
  skip: isLocalhost,
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: { ip: false },
  message: { error: 'Rate limit exceeded for write operations.' },
  skip: isLocalhost,
});

module.exports = { apiLimiter, strictLimiter, clientIp };
