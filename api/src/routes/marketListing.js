const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

const REQUIRED_STAKE = 1000;

// SELECT that exposes base_asset/quote_asset under the base/quote aliases the web reads.
const PROPOSAL_COLS =
  'id, proposer, symbol, base_asset AS base, quote_asset AS quote, max_leverage, ' +
  'stake_amount, votes_for, votes_against, status, created_at';

router.get('/proposals', async (req, res) => {
  try {
    const status = req.query.status;
    let query = `SELECT ${PROPOSAL_COLS} FROM market_proposals ORDER BY created_at DESC`;
    const params = [];
    if (status && status !== 'all') {
      query = `SELECT ${PROPOSAL_COLS} FROM market_proposals WHERE status = $1 ORDER BY created_at DESC`;
      params.push(status);
    }
    const result = await pool.query(query, params);
    res.json({ proposals: result.rows });
  } catch (e) {
    res.json({ proposals: [], note: 'Market listing module initializing' });
  }
});

router.post('/propose', strictLimiter, async (req, res) => {
  try {
    const { proposer, symbol, base, quote, max_leverage } = req.body;
    if (!proposer || !symbol || !base || !quote) {
      return res.status(400).json({ error: 'proposer, symbol, base, and quote are required' });
    }

    const staked = await pool.query(
      'SELECT COALESCE(staked, 0) as staked FROM staking_balance WHERE address = $1',
      [proposer.toLowerCase()]
    );
    const stakedAmount = Number(staked.rows[0]?.staked || 0);
    if (stakedAmount < REQUIRED_STAKE) {
      return res.status(400).json({
        error: `Minimum ${REQUIRED_STAKE} MRSN staked required to propose a market`,
        current: stakedAmount,
      });
    }

    const existing = await pool.query(
      "SELECT id FROM market_proposals WHERE symbol = $1 AND status IN ('pending', 'active', 'approved')",
      [symbol.toUpperCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A proposal for this symbol already exists' });
    }

    const leverage = Math.min(100, Math.max(1, Number(max_leverage) || 20));

    const result = await pool.query(
      `INSERT INTO market_proposals
       (proposer, symbol, base_asset, quote_asset, max_leverage,
        stake_amount, votes_for, votes_against, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'pending', NOW())
       RETURNING ${PROPOSAL_COLS}`,
      [
        proposer.toLowerCase(), symbol.toUpperCase(),
        base.toUpperCase(), quote.toUpperCase(), leverage, REQUIRED_STAKE,
      ]
    );
    res.json({ proposal: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/proposals/:id/vote', strictLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { voter, direction } = req.body;
    if (!voter || !direction) {
      return res.status(400).json({ error: 'voter and direction required' });
    }
    if (!['for', 'against'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be for or against' });
    }

    const proposal = await pool.query(
      "SELECT * FROM market_proposals WHERE id = $1 AND status = 'pending'", [id]
    );
    if (!proposal.rows[0]) {
      return res.status(404).json({ error: 'Active proposal not found' });
    }

    const existing = await pool.query(
      'SELECT id FROM market_proposal_votes WHERE proposal_id = $1 AND voter = $2',
      [id, voter.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already voted on this proposal' });
    }

    const staked = await pool.query(
      'SELECT COALESCE(staked, 0) as staked FROM staking_balance WHERE address = $1',
      [voter.toLowerCase()]
    );
    const votingPower = Number(staked.rows[0]?.staked || 0);

    await pool.query(
      'INSERT INTO market_proposal_votes (proposal_id, voter, direction, voting_power, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [id, voter.toLowerCase(), direction, votingPower]
    );

    const col = direction === 'for' ? 'votes_for' : 'votes_against';
    const updated = await pool.query(
      `UPDATE market_proposals SET ${col} = ${col} + $1 WHERE id = $2 RETURNING ${PROPOSAL_COLS}`,
      [votingPower, id]
    );

    res.json({ success: true, votingPower, proposal: updated.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/proposals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT ${PROPOSAL_COLS} FROM market_proposals WHERE id = $1`, [id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found' });

    const votes = await pool.query(
      'SELECT voter, direction, voting_power, created_at FROM market_proposal_votes WHERE proposal_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json({ proposal: result.rows[0], votes: votes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
