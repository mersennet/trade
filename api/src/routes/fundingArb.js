const { Router } = require('express');
const pool = require('../db/pool');
const { sendError } = require('../middleware/httpError');

const router = Router();

// The platform's listed perp markets (native MRSN collateral, USDC quote).
const SYMBOLS = ['MRSN', 'BTC', 'ETH', 'SOL', 'ARB'];

// External-venue funding rates (Hyperliquid / dYdX / Binance) are PREVIEW data:
// we do not yet ingest live cross-exchange feeds, so these legs are simulated.
// The Mersennet leg is sourced from funding_rates when available, otherwise simulated.
function generateMockRates(symbol) {
  const base = (Math.random() - 0.5) * 0.02;
  return {
    symbol,
    exchanges: {
      mersennetTrade: { rate: +(base + (Math.random() - 0.5) * 0.005).toFixed(6), annualized: 0 },
      hyperliquid: { rate: +(base + (Math.random() - 0.5) * 0.008).toFixed(6), annualized: 0 },
      dydx: { rate: +(base + (Math.random() - 0.5) * 0.006).toFixed(6), annualized: 0 },
      binance: { rate: +(base + (Math.random() - 0.5) * 0.004).toFixed(6), annualized: 0 },
    },
  };
}

function annualizeRate(rate8h) {
  return +(rate8h * 3 * 365 * 100).toFixed(2);
}

router.get('/comparison', async (req, res) => {
  try {
    const symbols = (req.query.symbols || SYMBOLS.join(',')).split(',');

    // Map bare symbols (e.g. 'BTC') to integer market ids so the Mersennet leg
    // can use real on-chain funding when present.
    let dbRates = {};
    try {
      const result = await pool.query(
        `SELECT fr.market_id, fr.funding_rate, m.base
         FROM funding_rates fr
         JOIN markets m ON m.id = fr.market_id`
      );
      for (const row of result.rows) {
        if (row.base) dbRates[row.base] = Number(row.funding_rate);
      }
    } catch (_) {}

    const comparison = symbols.map(symbol => {
      const data = generateMockRates(symbol);
      if (dbRates[symbol] !== undefined) {
        data.exchanges.mersennetTrade.rate = dbRates[symbol];
      }
      for (const exchange of Object.keys(data.exchanges)) {
        data.exchanges[exchange].annualized = annualizeRate(data.exchanges[exchange].rate);
      }
      // Flatten to the shape the web FundingComparison interface expects.
      return {
        symbol,
        mersennetTrade: data.exchanges.mersennetTrade.rate,
        hyperliquid: data.exchanges.hyperliquid.rate,
        dydx: data.exchanges.dydx.rate,
        binance: data.exchanges.binance.rate,
      };
    });

    // simulated: external-venue rates are preview data, not live feeds.
    res.json({ comparison, simulated: true, timestamp: Date.now() });
  } catch (e) {
    sendError(res, e, 'fundingArb');
  }
});

const EXCHANGE_LABELS = {
  mersennetTrade: 'Mersennet Trade',
  hyperliquid: 'Hyperliquid',
  dydx: 'dYdX',
  binance: 'Binance',
};

router.get('/opportunities', async (req, res) => {
  try {
    const minSpread = Number(req.query.min_spread) || 0.001;

    const opportunities = [];

    for (const symbol of SYMBOLS) {
      const data = generateMockRates(symbol);
      const exchanges = Object.entries(data.exchanges);

      for (let i = 0; i < exchanges.length; i++) {
        for (let j = i + 1; j < exchanges.length; j++) {
          const [exA, infoA] = exchanges[i];
          const [exB, infoB] = exchanges[j];
          const spread = Math.abs(infoA.rate - infoB.rate);

          if (spread >= minSpread) {
            const longKey = infoA.rate < infoB.rate ? exA : exB;
            const shortKey = infoA.rate < infoB.rate ? exB : exA;
            opportunities.push({
              symbol,
              long_exchange: EXCHANGE_LABELS[longKey] || longKey,
              short_exchange: EXCHANGE_LABELS[shortKey] || shortKey,
              spread: +spread.toFixed(6),
              annualized: annualizeRate(spread),
              longRate: Math.min(infoA.rate, infoB.rate),
              shortRate: Math.max(infoA.rate, infoB.rate),
            });
          }
        }
      }
    }

    opportunities.sort((a, b) => b.spread - a.spread);

    res.json({
      opportunities: opportunities.slice(0, Number(req.query.limit) || 20),
      minSpread,
      simulated: true,
      timestamp: Date.now(),
    });
  } catch (e) {
    sendError(res, e, 'fundingArb');
  }
});

module.exports = router;
