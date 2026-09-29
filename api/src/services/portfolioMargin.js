const pool = require('../db/pool');
const chain = require('./chain');

const HAIRCUTS = {
  BTC:  0.85,
  ETH:  0.80,
  SOL:  0.70,
  MRSN: 0.60,
  ARB:  0.60,
  USDC: 1.00,
};

async function fetchSpotBalances(address) {
  const { rows } = await pool.query(
    'SELECT asset, available, locked FROM spot_balances WHERE owner = $1',
    [address]
  );
  return rows;
}

async function fetchPerpPositions(address) {
  const positions = [];
  for (const market of chain.MARKETS) {
    try {
      const pos = await chain.getPosition(market.id, address);
      const size = Number(pos.size);
      if (size !== 0) {
        positions.push({
          marketId: market.id,
          symbol: market.symbol,
          base: market.base,
          size,
          entryPrice: Number(pos.entryPrice),
          maxLeverage: market.maxLeverage,
        });
      }
    } catch (_) { /* position doesn't exist */ }
  }
  return positions;
}

async function getMarkPrice(marketId) {
  try {
    return chain.toHumanPrice(marketId, await chain.getMarkPrice(marketId)) || 0;
  } catch (_) {
    return 0;
  }
}

async function calculatePortfolioMargin(address) {
  const [perpCollateralRaw, spotBalances, perpPositions] = await Promise.all([
    chain.getCollateral(address),
    fetchSpotBalances(address),
    fetchPerpPositions(address),
  ]);

  // chain.getCollateral already returns human MRSN for the current unit era.
  const perpCollateral = Number(perpCollateralRaw);

  let spotValue = 0;
  for (const bal of spotBalances) {
    const total = Number(bal.available) + Number(bal.locked);
    if (total <= 0) continue;
    const haircut = HAIRCUTS[bal.asset] ?? 0.50;
    if (bal.asset === 'USDC') {
      spotValue += total * haircut;
    } else {
      const market = chain.MARKETS.find(m => m.base === bal.asset);
      if (market) {
        const price = await getMarkPrice(market.id);
        spotValue += total * price * haircut;
      }
    }
  }

  const totalCollateral = perpCollateral + spotValue;

  let totalMarginUsed = 0;
  for (const pos of perpPositions) {
    const markPrice = await getMarkPrice(pos.marketId);
    const notional = Math.abs(pos.size) * markPrice;
    const marginRequired = notional / pos.maxLeverage;
    totalMarginUsed += marginRequired;
  }

  const marginRatio = totalMarginUsed > 0 ? totalCollateral / totalMarginUsed : Infinity;
  const availableMargin = Math.max(0, totalCollateral - totalMarginUsed);
  const healthFactor = totalMarginUsed > 0 ? totalCollateral / totalMarginUsed : Infinity;

  return {
    address,
    totalCollateral: +totalCollateral.toFixed(6),
    spotValue: +spotValue.toFixed(6),
    perpCollateral: +perpCollateral.toFixed(6),
    totalMarginUsed: +totalMarginUsed.toFixed(6),
    marginRatio: marginRatio === Infinity ? null : +marginRatio.toFixed(4),
    availableMargin: +availableMargin.toFixed(6),
    healthFactor: healthFactor === Infinity ? null : +healthFactor.toFixed(4),
    perpPositions: perpPositions.length,
    spotAssets: spotBalances.length,
  };
}

module.exports = { calculatePortfolioMargin };
