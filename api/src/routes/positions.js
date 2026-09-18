const { Router } = require('express');
const chain = require('../services/chain');
const { sendError } = require('../middleware/httpError');

const router = Router();
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

router.get('/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    if (!ETH_ADDR_RE.test(addr)) return res.status(400).json({ error: 'Invalid address' });

    const positions = [];

    let totalCollateral;
    try {
      // Already returned in human USDC (e.g. 100.5)
      totalCollateral = await chain.getCollateral(addr);
    } catch (e) {
      console.error('[positions] collateral error:', e.message);
      totalCollateral = 0;
    }

    for (const m of chain.MARKETS) {
      const pos = await chain.getPosition(m.id, addr);
      // pos.size is human base units (e.g. 0.5 BTC). Skip dust positions.
      if (!pos.size || Math.abs(pos.size) < 1e-12) continue;

      const sizeNum = pos.size;
      const entryPrice = pos.entryPrice;

      // Mark price: prefer book mid (always sane); only use mid-of-book when
      // both sides exist AND are within 5% of the reference price. Prices are
      // plain integer chain units.
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

      const isLong = sizeNum > 0;
      const absSize = Math.abs(sizeNum);
      const notional = absSize * markPrice;

      const unrealizedPnl = isLong
        ? (markPrice - entryPrice) * absSize
        : (entryPrice - markPrice) * absSize;

      const positionNotional = absSize * entryPrice;
      const leverage = totalCollateral > 0
        ? Math.max(1, Math.round(positionNotional / totalCollateral))
        : 2;

      const margin = positionNotional / leverage;

      // Maintenance margin as the chain enforces it (settlement era: 5%);
      // before the switch the node reports 0 and nothing is liquidatable.
      const protocol = await chain.getProtocol().catch(() => null);
      const maintenanceMarginBps = Number(protocol?.maintenanceMarginBps || 0);
      const mm = maintenanceMarginBps / 10000;
      // Cross-margin liquidation price for this position alone: the mark at
      // which collateral + PnL equals the maintenance requirement.
      //   long : C + s(m − e) = mm·s·m  →  m = (e − C/s) / (1 − mm)
      //   short: C − s(m − e) = mm·s·m  →  m = (e + C/s) / (1 + mm)
      let liquidationPrice = null;
      if (maintenanceMarginBps > 0 && absSize > 0) {
        const cPerUnit = totalCollateral / absSize;
        liquidationPrice = isLong
          ? Math.max(0, (entryPrice - cPerUnit) / (1 - mm))
          : (entryPrice + cPerUnit) / (1 + mm);
      }
      const maintenanceMargin = (notional * maintenanceMarginBps) / 10000;

      positions.push({
        marketId: m.id,
        symbol: m.symbol,
        size: sizeNum,
        entryPrice,
        markPrice,
        unrealizedPnl,
        liquidationPrice,
        margin,
        maintenanceMargin,
        leverage,
        fundingRate: m.fundingRate,
        notional,
      });
    }

    // Portfolio view: return the aggregate margin/health shape the /portfolio
    // page consumes. All figures are in human MRSN units (native collateral).
    if (req.query.mode === 'portfolio') {
      const totalMarginUsed = positions.reduce((s, p) => s + (p.margin || 0), 0);
      const totalUnrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
      const totalMaintenance = positions.reduce((s, p) => s + (p.maintenanceMargin || 0), 0);
      // Equity = deposited collateral + open uPnL.
      const equity = totalCollateral + totalUnrealizedPnl;
      // Margin ratio = margin currently committed / equity (fraction). 0 when flat.
      const marginRatio = equity > 0 ? totalMarginUsed / equity : 0;
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
