const { Router } = require('express');
const pool = require('../db/pool');
const { strictLimiter } = require('../middleware/rateLimit');

const router = Router();

// --- Black-Scholes helpers ---

function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function d1(S, K, T, r, sigma) {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function d2(S, K, T, r, sigma) {
  return d1(S, K, T, r, sigma) - sigma * Math.sqrt(T);
}

function callPrice(S, K, T, r, sigma) {
  if (T <= 0) return Math.max(0, S - K);
  const d1v = d1(S, K, T, r, sigma);
  const d2v = d2(S, K, T, r, sigma);
  return S * normCdf(d1v) - K * Math.exp(-r * T) * normCdf(d2v);
}

function putPrice(S, K, T, r, sigma) {
  if (T <= 0) return Math.max(0, K - S);
  const d1v = d1(S, K, T, r, sigma);
  const d2v = d2(S, K, T, r, sigma);
  return K * Math.exp(-r * T) * normCdf(-d2v) - S * normCdf(-d1v);
}

function delta(S, K, T, r, sigma, optionType) {
  if (T <= 0) return optionType === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const d1v = d1(S, K, T, r, sigma);
  return optionType === 'call' ? normCdf(d1v) : normCdf(d1v) - 1;
}

function gamma(S, K, T, r, sigma) {
  if (T <= 0) return 0;
  const d1v = d1(S, K, T, r, sigma);
  return normPdf(d1v) / (S * sigma * Math.sqrt(T));
}

function theta(S, K, T, r, sigma, optionType) {
  if (T <= 0) return 0;
  const d1v = d1(S, K, T, r, sigma);
  const d2v = d2(S, K, T, r, sigma);
  const term1 = -(S * normPdf(d1v) * sigma) / (2 * Math.sqrt(T));
  if (optionType === 'call') {
    return (term1 - r * K * Math.exp(-r * T) * normCdf(d2v)) / 365;
  }
  return (term1 + r * K * Math.exp(-r * T) * normCdf(-d2v)) / 365;
}

function vega(S, K, T, r, sigma) {
  if (T <= 0) return 0;
  const d1v = d1(S, K, T, r, sigma);
  return S * normPdf(d1v) * Math.sqrt(T) / 100;
}

function impliedVol(marketPrice, S, K, T, r, optionType, guess = 0.5) {
  let sigma = guess;
  for (let i = 0; i < 100; i++) {
    const price = optionType === 'call' ? callPrice(S, K, T, r, sigma) : putPrice(S, K, T, r, sigma);
    const v = vega(S, K, T, r, sigma) * 100;
    if (Math.abs(v) < 1e-12) break;
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-8) break;
    sigma -= diff / v;
    if (sigma <= 0.001) sigma = 0.001;
  }
  return sigma;
}

// --- Routes ---

router.get('/chains', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT underlying, expiry, COUNT(*) as contracts,
              MIN(strike) as min_strike, MAX(strike) as max_strike
       FROM options_contracts
       WHERE expiry > NOW()
       GROUP BY underlying, expiry
       ORDER BY underlying, expiry`
    );
    res.json({ chains: result.rows });
  } catch (e) {
    res.json({ chains: [], note: 'Options module initializing' });
  }
});

router.get('/chain/:underlying', async (req, res) => {
  try {
    const { underlying } = req.params;
    const expiry = req.query.expiry;
    // premium is the contract mark; iv is stored as whole percent, normalize to a fraction for the UI.
    // Cast NUMERIC to float8 so the JSON returns real numbers (the UI does arithmetic / toFixed on these).
    let query = `SELECT id, underlying, strike::float8 AS strike, option_type, expiry, status, created_at,
                        premium::float8 AS premium, premium::float8 AS mark_price,
                        (CASE WHEN iv > 2 THEN iv / 100.0 ELSE iv END)::float8 AS iv
                 FROM options_contracts WHERE underlying = $1 AND expiry > NOW()`;
    const params = [underlying.toUpperCase()];
    if (expiry) {
      query += ' AND expiry = $2';
      params.push(expiry);
    }
    query += ' ORDER BY expiry, strike, option_type';
    const result = await pool.query(query, params);
    res.json({ underlying: underlying.toUpperCase(), contracts: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/order', strictLimiter, async (req, res) => {
  try {
    const { contract_id, side, size, price } = req.body;
    const owner = req.body.owner || req.body.address;
    if (!owner || !contract_id || !side || !size || !price) {
      return res.status(400).json({ error: 'owner, contract_id, side, size, and price are required' });
    }
    if (!['buy', 'sell'].includes(side)) {
      return res.status(400).json({ error: 'side must be buy or sell' });
    }

    const contract = await pool.query('SELECT * FROM options_contracts WHERE id = $1', [contract_id]);
    if (!contract.rows[0]) return res.status(404).json({ error: 'Contract not found' });
    if (new Date(contract.rows[0].expiry) <= new Date()) {
      return res.status(400).json({ error: 'Contract has expired' });
    }

    const result = await pool.query(
      `INSERT INTO options_orders (owner, contract_id, side, size, price, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', NOW()) RETURNING *`,
      [owner.toLowerCase(), contract_id, side, Number(size), Number(price)]
    );
    res.json({ order: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/positions/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const result = await pool.query(
      `SELECT op.id, op.contract_id, op.owner, op.status,
              op.size::float8 AS size, op.entry_price::float8 AS entry_price, op.pnl::float8 AS pnl,
              oc.underlying, oc.strike::float8 AS strike, oc.option_type, oc.expiry,
              oc.premium::float8 AS mark_price
       FROM options_positions op
       JOIN options_contracts oc ON op.contract_id = oc.id
       WHERE op.owner = $1
       ORDER BY oc.expiry, oc.strike`,
      [addr]
    );
    res.json({ address: addr, positions: result.rows });
  } catch (e) {
    res.json({ address: req.params.address, positions: [] });
  }
});

router.post('/exercise/:id', strictLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });

    await client.query('BEGIN');

    const pos = await client.query(
      `SELECT op.*, oc.underlying, oc.strike, oc.option_type, oc.expiry
       FROM options_positions op
       JOIN options_contracts oc ON op.contract_id = oc.id
       WHERE op.id = $1 AND op.owner = $2 AND op.status = 'active'`,
      [id, address.toLowerCase()]
    );
    if (!pos.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active position not found' });
    }

    const position = pos.rows[0];
    if (new Date(position.expiry) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Option has expired' });
    }

    const spotResult = await client.query(
      `SELECT st.price
         FROM spot_trades st
         JOIN spot_markets sm ON sm.id = st.market_id
        WHERE sm.base = $1
        ORDER BY st.created_at DESC
        LIMIT 1`,
      [position.underlying]
    );
    const spotPrice = Number(spotResult.rows[0]?.price || 0);
    if (spotPrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No spot price available' });
    }

    const strike = Number(position.strike);
    let pnl = 0;
    if (position.option_type === 'call') {
      pnl = Math.max(0, spotPrice - strike) * Number(position.size);
    } else {
      pnl = Math.max(0, strike - spotPrice) * Number(position.size);
    }

    if (pnl <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Option is out of the money' });
    }

    await client.query(
      "UPDATE options_positions SET status = 'exercised', pnl = $1 WHERE id = $2",
      [pnl, id]
    );

    await client.query('COMMIT');
    res.json({ exercised: true, pnl, spotPrice, strike: strike, type: position.option_type });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/greeks/:contractId', async (req, res) => {
  try {
    const { contractId } = req.params;
    const contract = await pool.query('SELECT * FROM options_contracts WHERE id = $1', [contractId]);
    if (!contract.rows[0]) return res.status(404).json({ error: 'Contract not found' });

    const c = contract.rows[0];
    // derive spot from latest underlying spot trade; fall back to strike if unavailable.
    // spot_trades keys by market_id; map the underlying via spot_markets.base.
    const spotResult = await pool.query(
      `SELECT st.price
         FROM spot_trades st
         JOIN spot_markets sm ON sm.id = st.market_id
        WHERE sm.base = $1
        ORDER BY st.created_at DESC
        LIMIT 1`,
      [c.underlying]
    );
    const K = Number(c.strike);
    const S = Number(spotResult.rows[0]?.price) || K;
    const T = Math.max(0.001, (new Date(c.expiry) - new Date()) / (365 * 24 * 3600 * 1000));
    const r = 0.05;
    // iv is stored as whole percent (e.g. 65); normalize to a fraction for Black-Scholes
    const rawIv = Number(c.iv || 60);
    const sigma = rawIv > 2 ? rawIv / 100 : rawIv;

    const greeks = {
      contractId: c.id,
      underlying: c.underlying,
      strike: K,
      expiry: c.expiry,
      optionType: c.option_type,
      spot: S,
      timeToExpiry: T,
      iv: sigma,
      delta: delta(S, K, T, r, sigma, c.option_type),
      gamma: gamma(S, K, T, r, sigma),
      theta: theta(S, K, T, r, sigma, c.option_type),
      vega: vega(S, K, T, r, sigma),
      theoreticalPrice: c.option_type === 'call'
        ? callPrice(S, K, T, r, sigma)
        : putPrice(S, K, T, r, sigma),
    };

    res.json(greeks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
