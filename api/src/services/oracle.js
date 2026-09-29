const pool = require('../db/pool');
const chain = require('./chain');

// External (CoinGecko) price ids for assets with a real-world listing.
// MRSN is a Mersennet-native testnet token with no external listing, so it
// has no entry here and falls back to the on-chain order-book mid price.
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ARB: 'arbitrum',
};

const priceCache = new Map();

async function fetchCoinGeckoPrice(symbol) {
  const id = COINGECKO_IDS[symbol];
  if (!id) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: controller.signal }
    );
    const data = await res.json();
    return data[id]?.usd ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchChainPrice(symbol) {
  const market = chain.MARKETS.find(m => m.base === symbol);
  if (!market) return null;
  try {
    const mark = Number(await chain.getMarkPrice(market.id));
    return mark > 0 ? mark : null;
  } catch (_) {
    return null;
  }
}

async function fetchPrice(symbol) {
  let price = await fetchCoinGeckoPrice(symbol);
  if (price !== null) {
    priceCache.set(symbol, { price, timestamp: Date.now() });
    return price;
  }

  price = await fetchChainPrice(symbol);
  if (price !== null) {
    priceCache.set(symbol, { price, timestamp: Date.now() });
    return price;
  }

  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.timestamp < 300_000) return cached.price;

  return null;
}

async function getMedianPrice(symbol) {
  const sources = await Promise.allSettled([
    fetchCoinGeckoPrice(symbol),
    fetchChainPrice(symbol),
  ]);

  const prices = sources
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);

  if (prices.length === 0) return fetchPrice(symbol);

  if (prices.length >= 3) {
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const filtered = prices.filter(p => Math.abs(p - mean) / mean < 0.05);
    if (filtered.length > 0) {
      filtered.sort((a, b) => a - b);
      const mid = Math.floor(filtered.length / 2);
      return filtered.length % 2 === 0
        ? (filtered[mid - 1] + filtered[mid]) / 2
        : filtered[mid];
    }
  }

  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0
    ? (prices[mid - 1] + prices[mid]) / 2
    : prices[mid];

  priceCache.set(symbol, { price: median, timestamp: Date.now() });
  return median;
}

function circuitBreaker(symbol, newPrice) {
  const cached = priceCache.get(symbol);
  if (!cached) {
    priceCache.set(symbol, { price: newPrice, timestamp: Date.now() });
    return { accepted: true, price: newPrice };
  }

  const deviation = Math.abs(newPrice - cached.price) / cached.price;
  if (deviation > 0.10) {
    console.warn(
      `[oracle] Circuit breaker tripped for ${symbol}: ` +
      `${cached.price} -> ${newPrice} (${(deviation * 100).toFixed(1)}% deviation)`
    );
    return {
      accepted: false,
      price: cached.price,
      rejectedPrice: newPrice,
      deviation: +(deviation * 100).toFixed(2),
    };
  }

  priceCache.set(symbol, { price: newPrice, timestamp: Date.now() });
  return { accepted: true, price: newPrice };
}

async function initOracleCache() {
  const symbols = Object.keys(COINGECKO_IDS);
  const results = {};
  for (const symbol of symbols) {
    try {
      const price = await fetchPrice(symbol);
      if (price !== null) results[symbol] = price;
    } catch (e) {
      console.error(`[oracle] Failed to cache ${symbol}:`, e.message);
    }
  }
  console.log(`[oracle] Cache initialized with ${Object.keys(results).length} prices`);
  return results;
}

module.exports = { fetchPrice, getMedianPrice, circuitBreaker, initOracleCache };
