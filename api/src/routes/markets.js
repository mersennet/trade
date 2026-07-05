const { Router } = require('express');
const chain = require('../services/chain');
const pool = require('../db/pool');
const { dataCache } = require('../ws');

const router = Router();

router.get('/', (req, res) => {
  res.json({ markets: chain.MARKETS, timestamp: Date.now() });
});

router.get('/:marketId/orderbook', async (req, res) => {
  try {
    const marketId = Number(req.params.marketId);

    // Mersennet CLOB stores prices and sizes as plain integer units —
    // no decimal rescaling needed, just hex/string -> number conversion.
    const parsePrice = (v) => {
      if (v == null) return 0;
      const s = String(v);
      const n = s.startsWith('0x') ? Number(BigInt(s)) : Number(s);
      return Number.isFinite(n) ? n : 0;
    };
    const parseSize = parsePrice;
    const parseLevels = (levels) =>
      (levels || []).map((l) => {
        if (Array.isArray(l)) return [parsePrice(l[0]), parseSize(l[1])];
        return [parsePrice(l.price), parseSize(l.size)];
      });

    // wsCache is ALREADY scaled to USD/base by ws.js, do not re-scale.
    const wsCache = dataCache?.orderbooks?.get(marketId);
    if (wsCache) {
      return res.json({
        orderbook: {
          bids: wsCache.bids || [],
          asks: wsCache.asks || [],
        },
        timestamp: wsCache.timestamp,
      });
    }

    // Fallback path reads RAW units from the sequencer; scale here.
    const raw = await chain.getOrderBook(marketId);
    res.json({
      orderbook: { bids: parseLevels(raw?.bids), asks: parseLevels(raw?.asks) },
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getMarketStats(marketId) {
  // trades.price and trades.size are stored in plain integer chain units.
  const [volResult, changeResult] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(price * size), 0)::float8 as volume,
              COUNT(*) as trades
         FROM trades
         WHERE market_id = $1 AND block_timestamp > NOW() - interval '24 hours'`,
      [marketId]
    ),
    // Reference close from ~24h ago (not the first candle ever) and the
    // latest close, both in the SAME chain price units.
    pool.query(
      `SELECT
         (SELECT close FROM candles
            WHERE market_id = $1 AND resolution = '1h'
              AND open_time <= NOW() - interval '24 hours'
            ORDER BY open_time DESC LIMIT 1) AS ref_close,
         (SELECT close FROM candles
            WHERE market_id = $1 AND resolution = '1h'
            ORDER BY open_time DESC LIMIT 1) AS last_close`,
      [marketId]
    ),
  ]);

  const volume24h = Number(volResult.rows[0]?.volume || 0);
  const trades24h = Number(volResult.rows[0]?.trades || 0);
  const refClose = Number(changeResult.rows[0]?.ref_close || 0);
  const lastClose = Number(changeResult.rows[0]?.last_close || 0);

  return { volume24h, trades24h, refClose, lastClose };
}

// 24h price-change cache lives in services/change24h.js so both the REST
// endpoint and the WS broadcaster can read identical data and never race.
const { getCachedChange24hPct } = require('../services/change24h');

router.get('/:marketId/ticker', async (req, res) => {
  try {
    const marketId = Number(req.params.marketId);
    const wsCache = dataCache?.tickers?.get(marketId);
    const { volume24h, trades24h, refClose, lastClose } = await getMarketStats(marketId);

    // The on-chain CLOB stores prices as plain integer units.
    const toUsd = (raw) => {
      const s = String(raw ?? '0');
      const n = s.startsWith('0x') ? Number(BigInt(s)) : Number(s);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return n;
    };

    let bestBid, bestAsk, wsMark;
    if (wsCache) {
      bestBid = Number(wsCache.bestBid) || 0;
      bestAsk = Number(wsCache.bestAsk) || 0;
      wsMark = Number(wsCache.markPrice) || 0;
    } else {
      const ba = await chain.getBestBidAsk(marketId);
      bestBid = toUsd(ba.bestBid);
      bestAsk = toUsd(ba.bestAsk);
      wsMark = 0;
    }

    // Book-mid mark price (integer chain units).
    const oraclePx = await chain.getOraclePriceForDisplay(marketId);
    const oracleMarkUsd = oraclePx.price !== '0' ? toUsd(oraclePx.price) : 0;

    // Mark policy: only trust mid-of-book when both sides exist AND mid is
    // within 5% of oracle. Otherwise prefer oracle to avoid stale resting
    // orders from skewing UI.
    let markPrice;
    if (bestBid > 0 && bestAsk > 0 && oracleMarkUsd > 0) {
      const mid = (bestBid + bestAsk) / 2;
      const dev = Math.abs(mid - oracleMarkUsd) / oracleMarkUsd;
      markPrice = dev < 0.05 ? mid : oracleMarkUsd;
    } else if (wsMark > 0 && oracleMarkUsd > 0 && Math.abs(wsMark - oracleMarkUsd) / oracleMarkUsd < 0.05) {
      markPrice = wsMark;
    } else {
      markPrice = oracleMarkUsd || wsMark || bestBid || bestAsk;
    }

    // 24h change: prefer the real public-exchange feed (BTC/ETH/SOL/ARB).
    // For MRSN (no external feed) derive it from our own candles using a
    // 24h-ago reference in matching chain units. Never mix the USD mark
    // with chain-unit candles — that produced nonsense values like +125%.
    let change24h = getCachedChange24hPct(marketId);
    if (!Number.isFinite(change24h)) {
      change24h = refClose > 0 && lastClose > 0
        ? ((lastClose - refClose) / refClose) * 100
        : 0;
    }

    res.json({
      marketId, bestBid, bestAsk, markPrice,
      oracleMarkUsd, oracleAgeSec: oraclePx.age,
      volume24h, trades24h,
      change24h: Math.round(change24h * 100) / 100,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:marketId/funding-history', async (req, res) => {
  try {
    const marketId = Number(req.params.marketId);
    const market = chain.MARKETS.find(m => m.id === marketId);
    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const existing = await pool.query(
      `SELECT market_id AS "marketId", rate, timestamp FROM funding_rates
       WHERE market_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [marketId, limit]
    );

    if (existing.rows.length > 0) {
      return res.json({ rates: existing.rows, synthetic: false, timestamp: Date.now() });
    }

    // No real history yet (no funding interval has settled on-chain). Return a
    // flat line at the current rate instead of a random walk — random noise on
    // a per-8h funding rate gets multiplied by ~1095 in APR display, which made
    // a tiny ±0.2% wobble look like "-178% APR". Honest UX > pretty noise.
    const baseRate = Number(market.fundingRate) || 0;
    const now = Date.now();
    const history = [];
    for (let i = 0; i < limit; i++) {
      history.push({
        marketId,
        rate: Number(baseRate.toFixed(6)),
        timestamp: new Date(now - i * 8 * 3600 * 1000),
      });
    }
    res.json({ rates: history, synthetic: true, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
