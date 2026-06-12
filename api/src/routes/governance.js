const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

router.get('/proposals', async (req, res) => {
  try {
    const status = req.query.status;
    let query = `SELECT * FROM governance_proposals ORDER BY created_at DESC`;
    const params = [];
    if (status && status !== 'all') {
      query = `SELECT * FROM governance_proposals WHERE status = $1 ORDER BY created_at DESC`;
      params.push(status);
    }
    const result = await pool.query(query, params);
    res.json({ proposals: result.rows });
  } catch (e) {
    res.json({
      proposals: [],
      note: 'Governance module initializing',
    });
  }
});

router.get('/proposals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM governance_proposals WHERE id = $1', [id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found' });
    const votes = await pool.query(
      'SELECT voter, direction, voting_power, created_at FROM governance_votes WHERE proposal_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json({ proposal: result.rows[0], votes: votes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/proposals', async (req, res) => {
  try {
    const { title, description, proposer, end_days } = req.body;
    if (!title || !description || !proposer) {
      return res.status(400).json({ error: 'title, description, and proposer required' });
    }
    const addr = proposer.toLowerCase();
    const staked = await pool.query(
      'SELECT COALESCE(staked, 0) as staked FROM staking_balance WHERE address = $1',
      [addr]
    );
    const power = Number(staked.rows[0]?.staked || 0);
    if (power < 100) {
      return res.status(400).json({ error: 'Minimum 100 MRSN staked to create proposals' });
    }

    const days = Math.min(30, Math.max(3, Number(end_days) || 7));
    const endTime = new Date(Date.now() + days * 86400000).toISOString();

    const result = await pool.query(
      `INSERT INTO governance_proposals (title, description, proposer, status, for_votes, against_votes, end_time) 
       VALUES ($1, $2, $3, 'active', 0, 0, $4) RETURNING *`,
      [title, description, addr, endTime]
    );
    res.json({ proposal: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/proposals/:id/vote', async (req, res) => {
  try {
    const { id } = req.params;
    const { voter, direction } = req.body;
    if (!voter || !direction) return res.status(400).json({ error: 'voter and direction required' });
    if (!['for', 'against'].includes(direction)) return res.status(400).json({ error: 'direction must be for or against' });

    const staked = await pool.query(
      'SELECT COALESCE(staked, 0) as staked FROM staking_balance WHERE address = $1',
      [voter.toLowerCase()]
    );
    const votingPower = Number(staked.rows[0]?.staked || 0);

    const existing = await pool.query(
      'SELECT id FROM governance_votes WHERE proposal_id = $1 AND voter = $2',
      [id, voter.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already voted on this proposal' });
    }

    await pool.query(
      'INSERT INTO governance_votes (proposal_id, voter, direction, voting_power) VALUES ($1, $2, $3, $4)',
      [id, voter.toLowerCase(), direction, votingPower]
    );

    const col = direction === 'for' ? 'for_votes' : 'against_votes';
    await pool.query(
      `UPDATE governance_proposals SET ${col} = ${col} + $1 WHERE id = $2`,
      [votingPower, id]
    );

    res.json({ success: true, votingPower });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/voting-power/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const staked = await pool.query(
      'SELECT COALESCE(staked, 0) as staked FROM staking_balance WHERE address = $1',
      [addr]
    );
    res.json({ address: addr, votingPower: Number(staked.rows[0]?.staked || 0) });
  } catch (e) {
    res.json({ address: req.params.address, votingPower: 0 });
  }
});

module.exports = router;
