const { Router } = require('express');
const { ethers } = require('ethers');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');
const crypto = require('crypto');
const { sendError } = require('../middleware/httpError');

const router = Router();

// A code is created by its owner: the wallet signs the code, label and time
// (GET /message returns the exact text), the same way referral attribution and
// Telegram alert links are signed.
const CODE_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const LABEL_MAX = 40;
const MAX_CODES_PER_OWNER = 10;
const SIGNATURE_TTL_MS = 10 * 60 * 1000;

function creationMessage(owner, code, label, issuedAt) {
  return `Mersennet Trade builder code\nCode: ${code}\nLabel: ${label || '-'}\nOwner: ${owner}\nIssued: ${issuedAt}`;
}

/** Validated { owner, code, label } or { error }. A missing code gets a random one. */
function parseCodeRequest({ owner, code, label }) {
  if (!ethers.isAddress(String(owner || ''))) return { error: 'owner must be a 0x address' };
  const c = code == null || code === '' ? crypto.randomBytes(4).toString('hex') : String(code);
  if (!CODE_RE.test(c)) return { error: 'code must be 2-32 letters, digits, - or _' };
  const l = String(label ?? '').trim();
  if (l.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(l)) return { error: `label must be at most ${LABEL_MAX} characters on one line` };
  return { owner: String(owner).toLowerCase(), code: c, label: l };
}

async function capacityError(owner, code) {
  const [taken, owned] = await Promise.all([
    pool.query('SELECT 1 FROM builder_codes WHERE code = $1', [code]),
    pool.query('SELECT COUNT(*)::int AS n FROM builder_codes WHERE owner = $1 AND active = true', [owner]),
  ]);
  if (taken.rowCount > 0) return [409, 'Code already exists'];
  if (owned.rows[0].n >= MAX_CODES_PER_OWNER) return [429, `A wallet can hold at most ${MAX_CODES_PER_OWNER} codes`];
  return null;
}

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT code, owner, label, fee_share_bps, total_volume, total_fees_earned, total_orders, created_at
       FROM builder_codes WHERE active = true ORDER BY total_volume DESC`
    );
    res.json({ codes: result.rows });
  } catch (e) {
    sendError(res, e, 'builderCodes');
  }
});

/** GET /api/v1/builder-codes/message?owner=..&code=..&label=.. — the text the owner signs */
router.get('/message', async (req, res) => {
  const p = parseCodeRequest(req.query);
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    const blocked = await capacityError(p.owner, p.code);
    if (blocked) return res.status(blocked[0]).json({ error: blocked[1] });
    const issuedAt = Date.now();
    res.json({ owner: p.owner, code: p.code, label: p.label, issuedAt, message: creationMessage(p.owner, p.code, p.label, issuedAt) });
  } catch (e) {
    sendError(res, e, 'builderCodes');
  }
});

router.get('/:code', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM builder_codes WHERE code = $1', [req.params.code]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Builder code not found' });
    res.json(result.rows[0]);
  } catch (e) {
    sendError(res, e, 'builderCodes');
  }
});

router.get('/owner/:address', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM builder_codes WHERE owner = $1', [req.params.address.toLowerCase()]
    );
    res.json({ codes: result.rows });
  } catch (e) {
    sendError(res, e, 'builderCodes');
  }
});

/** POST /api/v1/builder-codes { owner, code, label, issuedAt, signature } */
router.post('/', strictLimiter, async (req, res) => {
  const body = req.body || {};
  if (body.code == null || body.code === '') return res.status(400).json({ error: 'code required (GET /builder-codes/message picks one)' });
  const p = parseCodeRequest(body);
  if (p.error) return res.status(400).json({ error: p.error });
  const issuedAt = Number(body.issuedAt);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > Date.now() + 60_000 || Date.now() - issuedAt > SIGNATURE_TTL_MS) {
    return res.status(400).json({ error: 'issuedAt missing or expired; sign a fresh message' });
  }
  if (typeof body.signature !== 'string') return res.status(400).json({ error: 'signature required' });
  let signer;
  try {
    signer = ethers.verifyMessage(creationMessage(p.owner, p.code, p.label, issuedAt), body.signature).toLowerCase();
  } catch {
    return res.status(400).json({ error: 'bad signature' });
  }
  if (signer !== p.owner) return res.status(401).json({ error: 'signature does not match owner' });
  try {
    const blocked = await capacityError(p.owner, p.code);
    if (blocked) return res.status(blocked[0]).json({ error: blocked[1] });
    await pool.query(
      `INSERT INTO builder_codes (code, owner, label) VALUES ($1, $2, $3)`,
      [p.code, p.owner, p.label || null]
    );
    res.json({ code: p.code, owner: p.owner, timestamp: Date.now() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Code already exists' });
    sendError(res, e, 'builderCodes');
  }
});

module.exports = router;
module.exports.creationMessage = creationMessage;
module.exports.parseCodeRequest = parseCodeRequest;
