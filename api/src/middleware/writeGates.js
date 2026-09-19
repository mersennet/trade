/**
 * Two gates for unsigned write routes.
 *
 * `retired(reason)` — 410 for endpoints that no live surface calls any more
 * and that would otherwise accept an unsigned `owner`/`address` and write it
 * to the database: the DB-only staking simulation (superseded by the on-chain
 * staking precompile), the API-side conditional/TWAP order tables (the
 * terminal arms and executes those in the browser), and the API-key issuer
 * (keys unlock nothing yet). Keeping them answering 200 let anyone create
 * rows in someone else's name.
 *
 * `previewWrites` — roadmap previews (governance, market listing,
 * competitions, whale alerts, OTC, options, spot, pre-launch, bridge, AI
 * agents, paper trading) are reachable behind the Preview banner. Their
 * writes are unsigned and simulated; on the public testnet they answer 410
 * unless PREVIEW_WRITES=1 (a staging box that wants the demos interactive).
 */
function retired(reason) {
  return (_req, res) => res.status(410).json({ error: reason, code: 'RETIRED' });
}

const PREVIEW_ON = process.env.PREVIEW_WRITES === '1';
function previewWrites(req, res, next) {
  if (PREVIEW_ON) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return res.status(410).json({
    error: 'This is a roadmap preview: actions are disabled on the public testnet. Perpetuals, staking, the Maker Vault and points are live — see the Preview banner for what ships when.',
    code: 'PREVIEW_DISABLED',
  });
}

module.exports = { retired, previewWrites };
