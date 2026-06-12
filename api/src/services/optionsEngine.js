const pool = require('../db/pool');

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function d1(S, K, T, r, sigma) {
  return (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
}

function d2(S, K, T, r, sigma) {
  return d1(S, K, T, r, sigma) - sigma * Math.sqrt(T);
}

function callPrice(S, K, T, r, sigma) {
  if (T <= 0) return Math.max(0, S - K);
  const _d1 = d1(S, K, T, r, sigma);
  const _d2 = d2(S, K, T, r, sigma);
  return S * normalCDF(_d1) - K * Math.exp(-r * T) * normalCDF(_d2);
}

function putPrice(S, K, T, r, sigma) {
  if (T <= 0) return Math.max(0, K - S);
  const _d1 = d1(S, K, T, r, sigma);
  const _d2 = d2(S, K, T, r, sigma);
  return K * Math.exp(-r * T) * normalCDF(-_d2) - S * normalCDF(-_d1);
}

function delta(S, K, T, r, sigma, type) {
  if (T <= 0) return type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const _d1 = d1(S, K, T, r, sigma);
  return type === 'call' ? normalCDF(_d1) : normalCDF(_d1) - 1;
}

function gamma(S, K, T, r, sigma) {
  if (T <= 0) return 0;
  const _d1 = d1(S, K, T, r, sigma);
  const pdf = Math.exp(-_d1 * _d1 / 2) / Math.sqrt(2 * Math.PI);
  return pdf / (S * sigma * Math.sqrt(T));
}

function theta(S, K, T, r, sigma, type) {
  if (T <= 0) return 0;
  const _d1 = d1(S, K, T, r, sigma);
  const _d2 = d2(S, K, T, r, sigma);
  const pdf = Math.exp(-_d1 * _d1 / 2) / Math.sqrt(2 * Math.PI);
  const term1 = -(S * pdf * sigma) / (2 * Math.sqrt(T));
  if (type === 'call') {
    return (term1 - r * K * Math.exp(-r * T) * normalCDF(_d2)) / 365;
  }
  return (term1 + r * K * Math.exp(-r * T) * normalCDF(-_d2)) / 365;
}

function vega(S, K, T, r, sigma) {
  if (T <= 0) return 0;
  const _d1 = d1(S, K, T, r, sigma);
  const pdf = Math.exp(-_d1 * _d1 / 2) / Math.sqrt(2 * Math.PI);
  return (S * Math.sqrt(T) * pdf) / 100;
}

function rho(S, K, T, r, sigma, type) {
  if (T <= 0) return 0;
  const _d2 = d2(S, K, T, r, sigma);
  if (type === 'call') {
    return (K * T * Math.exp(-r * T) * normalCDF(_d2)) / 100;
  }
  return (-K * T * Math.exp(-r * T) * normalCDF(-_d2)) / 100;
}

function impliedVolatility(marketPrice, S, K, T, r, type, precision = 1e-6, maxIter = 100) {
  let sigma = 0.5;
  for (let i = 0; i < maxIter; i++) {
    const price = type === 'call' ? callPrice(S, K, T, r, sigma) : putPrice(S, K, T, r, sigma);
    const diff = price - marketPrice;
    if (Math.abs(diff) < precision) return sigma;

    const v = vega(S, K, T, r, sigma) * 100;
    if (v < 1e-10) break;
    sigma -= diff / v;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 10) sigma = 10;
  }
  return sigma;
}

function generateOptionChain(underlying, spotPrice, expiryDays, volPercent) {
  const T = expiryDays / 365;
  const r = 0.05;
  const sigma = volPercent / 100;
  const strikes = [];

  for (let pct = -20; pct <= 20; pct += 5) {
    const K = +(spotPrice * (1 + pct / 100)).toFixed(2);
    const call = callPrice(spotPrice, K, T, r, sigma);
    const put = putPrice(spotPrice, K, T, r, sigma);
    strikes.push({
      underlying,
      strike: K,
      expiry_days: expiryDays,
      call_price: +call.toFixed(4),
      put_price: +put.toFixed(4),
      call_delta: +delta(spotPrice, K, T, r, sigma, 'call').toFixed(4),
      put_delta: +delta(spotPrice, K, T, r, sigma, 'put').toFixed(4),
      gamma: +gamma(spotPrice, K, T, r, sigma).toFixed(6),
      theta_call: +theta(spotPrice, K, T, r, sigma, 'call').toFixed(4),
      theta_put: +theta(spotPrice, K, T, r, sigma, 'put').toFixed(4),
      vega: +vega(spotPrice, K, T, r, sigma).toFixed(4),
      iv: volPercent,
    });
  }
  return strikes;
}

async function initOptionsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options_contracts (
      id SERIAL PRIMARY KEY,
      underlying TEXT NOT NULL,
      strike NUMERIC NOT NULL,
      option_type TEXT NOT NULL,
      expiry TIMESTAMP NOT NULL,
      premium NUMERIC,
      iv NUMERIC,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options_orders (
      id SERIAL PRIMARY KEY,
      contract_id INTEGER REFERENCES options_contracts(id),
      owner TEXT NOT NULL,
      side TEXT NOT NULL,
      price NUMERIC NOT NULL,
      size NUMERIC NOT NULL,
      filled NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options_positions (
      id SERIAL PRIMARY KEY,
      contract_id INTEGER REFERENCES options_contracts(id),
      owner TEXT NOT NULL,
      size NUMERIC NOT NULL,
      entry_price NUMERIC NOT NULL,
      pnl NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS options_settlements (
      id SERIAL PRIMARY KEY,
      contract_id INTEGER REFERENCES options_contracts(id),
      settlement_price NUMERIC NOT NULL,
      total_payout NUMERIC DEFAULT 0,
      settled_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function seedOptionContracts() {
  const underlyings = [
    { symbol: 'BTC', spot: 97000, vol: 65 },
    { symbol: 'ETH', spot: 2500,  vol: 70 },
  ];
  const now = new Date();

  for (const u of underlyings) {
    const expiries = [
      { label: 'weekly',  days: 7 },
      { label: 'monthly', days: 30 },
    ];

    for (const exp of expiries) {
      const expiryDate = new Date(now.getTime() + exp.days * 86400000);
      const chain = generateOptionChain(u.symbol, u.spot, exp.days, u.vol);

      for (const link of chain) {
        for (const optType of ['call', 'put']) {
          const premium = optType === 'call' ? link.call_price : link.put_price;
          await pool.query(
            `INSERT INTO options_contracts (underlying, strike, option_type, expiry, premium, iv)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [u.symbol, link.strike, optType, expiryDate, premium, u.vol]
          );
        }
      }
    }
  }
}

module.exports = {
  normalCDF, d1, d2, callPrice, putPrice,
  delta, gamma, theta, vega, rho,
  impliedVolatility, generateOptionChain,
  initOptionsTables, seedOptionContracts,
};
