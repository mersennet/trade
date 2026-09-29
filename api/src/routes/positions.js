const { Router } = require('express');
const chain = require('../services/chain');
const { sendError } = require('../middleware/httpError');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Mark price: the oracle, or the book mid when both sides exist and sit within
// 5% of it. Prices are human quote units.
async function markPriceOf(m, entryPrice) {
  let oracleUsd = 0;
  try {
    const o = await chain.getOraclePriceForDisplay(m.id);
    oracleUsd = chain.toHumanPrice(m.id, o.price) || 0;
  } catch { /* ignore */ }

  let markPrice = oracleUsd || entryPrice;
  try {
    const { bestBid, bestAsk } = await chain.getBestBidAsk(m.id);
    const bid = chain.toHumanPrice(m.id, bestBid);
    const ask = chain.toHumanPrice(m.id, bestAsk);
    if (bid > 0 && ask > 0 && oracleUsd > 0) {
      const mid = (bid + ask) / 2;
      if (Math.abs(mid - oracleUsd) / oracleUsd < 0.05) markPrice = mid;
    }
  } catch (e) {
    console.error(`[positions] mark price error market ${m.id}:`, e.message);
  }
  return markPrice;
}

router.get('/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    if (!ETH_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Invalid address' });

    // Human MRSN. A failed read answers 503: with zero collateral every
    // liquidation price would sit next to its entry.
    const totalCollateral = await chain.getCollateral(addr);

    // Margin rates as the chain enforces them (settlement era: 10% initial,
    // 5% maintenance); before the switch the node reports 0 and nothing is
    // liquidatable.
    const protocol = await chain.getProtocol().catch(() => null);
    const mm = Number(protocol?.maintenanceMarginBps || 0) / 10000;
    const im = Number(protocol?.initialMarginBps || 0) / 10000;

    const open = [];
    for (const m of chain.MARKETS) {
      const pos = await chain.getPosition(m.id, addr);
      // pos.size is human base units (e.g. 0.5 BTC). Skip dust positions.
      if (!pos.size || Math.abs(pos.size) < 1e-12) continue;
      const markPrice = await markPriceOf(m, pos.entryPrice);
      open.push({
        m,
        sizeNum: pos.size,
        entryPrice: pos.entryPrice,
        markPrice,
        notional: Math.abs(pos.size) * markPrice,
        unrealizedPnl: pos.size * (markPrice - pos.entryPrice),
      });
    }

    const totalUnrealizedPnl = open.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalNotional = open.reduce((s, p) => s + p.notional, 0);
    // Equity = deposited collateral + open uPnL.
    const equity = totalCollateral + totalUnrealizedPnl;

    const positions = open.map(({ m, sizeNum, entryPrice, markPrice, notional, unrealizedPnl }) => {
      const isLong = sizeNum > 0;
      const absSize = Math.abs(sizeNum);
      // Cross margin: the mark at which this position takes account equity down
      // to the account's maintenance requirement, the other positions held at
      // their current marks. `base` is the rest of the account's equity net of
      // the rest of its maintenance.
      //   long : base + s(P − e) = mm·s·P  →  P = (e − base/s) / (1 − mm)
      //   short: base − s(P − e) = mm·s·P  →  P = (e + base/s) / (1 + mm)
      let liquidationPrice = null;
      if (mm > 0 && absSize > 0) {
        const base = totalCollateral + (totalUnrealizedPnl - unrealizedPnl) - mm * (totalNotional - notional);
        liquidationPrice = isLong
          ? Math.max(0, (entryPrice - base / absSize) / (1 - mm))
          : (entryPrice + base / absSize) / (1 + mm);
      }
      return {
        marketId: m.id,
        symbol: m.symbol,
        size: sizeNum,
        entryPrice,
        markPrice,
        unrealizedPnl,
        liquidationPrice,
        // Initial margin the position ties up at the current mark.
        margin: notional * im,
        maintenanceMargin: notional * mm,
        // Effective leverage: the position's notional over account equity.
        leverage: equity > 0 ? Math.max(0.1, Math.round((notional / equity) * 10) / 10) : null,
        fundingRate: m.fundingRate,
        notional,
      };
    });

    // Portfolio view: return the aggregate margin/health shape the /portfolio
    // page consumes. All figures are in human MRSN units (native collateral).
    if (req.query.mode === 'portfolio') {
      const totalMarginUsed = positions.reduce((s, p) => s + p.margin, 0);
      const totalMaintenance = positions.reduce((s, p) => s + p.maintenanceMargin, 0);
      // Margin ratio = maintenance requirement / equity (fraction): 1 means
      // liquidatable, 0 when flat.
      const marginRatio = totalMaintenance > 0 ? (equity > 0 ? Math.min(1, totalMaintenance / equity) : 1) : 0;
      const availableMargin = Math.max(0, equity - totalMarginUsed);
      // Health factor = equity / maintenance requirement. No positions ⇒ no
      // liquidation risk, surface 0 (the UI renders this as '—').
      const healthFactor = totalMaintenance > 0 ? equity / totalMaintenance : 0;

      return res.json({
        totalCollateral,
        totalMarginUsed,
        marginRatio,
        availableMargin,
        healthFactor,
        positions,
        spotBalances: [],
        timestamp: Date.now(),
      });
    }

    res.json({ positions, collateral: totalCollateral, timestamp: Date.now() });
  } catch (e) {
    console.error('[positions] error:', e.message);
    sendError(res, e, 'positions');
  }
});

module.exports = router;
