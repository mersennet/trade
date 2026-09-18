const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');
const { sendError } = require('../middleware/httpError');

const router = Router();

// pg returns NUMERIC columns as strings; the web client renders prize_pool via
// formatUsd → toFixed and would crash on a string, so coerce it to a number.
function shapeCompetition(row) {
  return { ...row, prize_pool: Number(row.prize_pool) };
}

router.get('/', async (req, res) => {
  try {
    const status = req.query.status;
    let query = 'SELECT * FROM competitions ORDER BY start_at DESC';
    const params = [];
    if (status) {
      query = 'SELECT * FROM competitions WHERE status = $1 ORDER BY start_at DESC';
      params.push(status);
    }
    const result = await pool.query(query, params);
    res.json({ competitions: result.rows.map(shapeCompetition) });
  } catch (e) {
    sendError(res, e, 'competitions');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const comp = await pool.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    if (!comp.rows[0]) return res.status(404).json({ error: 'Competition not found' });

    const entries = await pool.query(
      `SELECT address, pnl, roi, volume, rank
       FROM competition_entries WHERE competition_id = $1
       ORDER BY CASE WHEN $2 = 'pnl' THEN pnl WHEN $2 = 'volume' THEN volume ELSE roi END DESC
       LIMIT 100`,
      [req.params.id, comp.rows[0].comp_type]
    );

    res.json({
      competition: shapeCompetition(comp.rows[0]),
      standings: entries.rows.map((e, i) => ({
        address: e.address,
        pnl: Number(e.pnl),
        roi: Number(e.roi),
        volume: Number(e.volume),
        rank: i + 1,
      })),
    });
  } catch (e) {
    sendError(res, e, 'competitions');
  }
});

router.post('/:id/join', strictLimiter, async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Missing address' });

    const comp = await pool.query('SELECT * FROM competitions WHERE id = $1', [req.params.id]);
    if (!comp.rows[0]) return res.status(404).json({ error: 'Competition not found' });
    if (comp.rows[0].status !== 'active' && comp.rows[0].status !== 'upcoming') {
      return res.status(400).json({ error: 'Competition is not accepting entries' });
    }

    await pool.query(
      `INSERT INTO competition_entries (competition_id, address) VALUES ($1, $2)
       ON CONFLICT (competition_id, address) DO NOTHING`,
      [req.params.id, address.toLowerCase()]
    );

    res.json({ joined: true, timestamp: Date.now() });
  } catch (e) {
    sendError(res, e, 'competitions');
  }
});

module.exports = router;
