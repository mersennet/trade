const WebSocket = require('ws');
const chain = require('./services/chain');
const pool = require('./db/pool');
const { getCachedChange24hPct } = require('./services/change24h');

const WS_CHAIN_URL = process.env.WS_URL || 'wss://rpc.mersennet.com';
const HEARTBEAT_INTERVAL = 30000;
const UPDATE_THROTTLE = 5_000; // Refresh every 5s
const VALID_CHANNELS = /^(blocks|ticker:\d+|orderbook:\d+|trades:\d+|trades:followed:0x[0-9a-fA-F]{40})$/;

const lastTradeIds = new Map();

// OI + long/short account ratios are aggregated from full trade history —
// too heavy for the 5s refresh, so they are recomputed on a 30s cadence and
// merged into every ticker broadcast in between.
const OI_CACHE_MS = 30_000;
const oiCache = new Map(); // marketId -> { openInterest, longAccounts, shortAccounts, ts }

async function getOiStats(marketId, markPrice) {
  const cached = oiCache.get(marketId);
  if (cached && Date.now() - cached.ts < OI_CACHE_MS) return cached;
  try {
    const r = await pool.query(
      `WITH fills AS (
         SELECT taker AS account, CASE WHEN side = 'buy' THEN size ELSE -size END AS signed
         FROM trades WHERE market_id = $1
         UNION ALL
         SELECT maker AS account, CASE WHEN side = 'buy' THEN -size ELSE size END AS signed
         FROM trades WHERE market_id = $1
       ), net AS (
         SELECT account, SUM(signed)::float8 AS net_size FROM fills GROUP BY account
       )
       SELECT
         COALESCE(SUM(GREATEST(net_size, 0)), 0)::float8 AS long_size,
         COUNT(*) FILTER (WHERE net_size > 0) AS longs,
         COUNT(*) FILTER (WHERE net_size < 0) AS shorts
       FROM net`,
      [marketId]
    );
    const row = r.rows[0] || {};
    const out = {
      openInterest: Math.round(Number(row.long_size || 0) * (markPrice || 0)),
      longAccounts: Number(row.longs || 0),
      shortAccounts: Number(row.shorts || 0),
      ts: Date.now(),
    };
    oiCache.set(marketId, out);
    return out;
  } catch {
    return cached || { openInterest: 0, longAccounts: 0, shortAccounts: 0, ts: 0 };
  }
}

// Shared cache that REST endpoints can also import
const dataCache = {
  tickers: new Map(),
  orderbooks: new Map(),
};

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const subscriptions = new Map();
  let chainWs = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let isUpdating = false;
  let lastUpdateStart = 0;

  function connectChainWs() {
    if (chainWs) try { chainWs.close(); } catch (_) {}

    chainWs = new WebSocket(WS_CHAIN_URL);

    chainWs.on('open', () => {
      console.log('[ws] Connected to chain WebSocket');
      chainWs.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    });

    chainWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'eth_subscription' && msg.params?.result?.number) {
          broadcastToChannel('blocks', { type: 'newBlock', block: msg.params.result });
          throttledUpdate();
        }
      } catch (e) {
        console.error('[ws] Chain message parse error:', e.message);
      }
    });

    chainWs.on('close', () => {
      console.log('[ws] Chain WS disconnected, reconnecting...');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectChainWs, 5000);
    });

    chainWs.on('error', (e) => {
      console.error('[ws] Chain WS error:', e.message);
    });
  }

  function throttledUpdate() {
    const now = Date.now();
    if (isUpdating || (now - lastUpdateStart) < UPDATE_THROTTLE) return;
    lastUpdateStart = now;
    updateAllParallel();
  }

  async function updateAllParallel() {
    if (isUpdating) return;
    isUpdating = true;
    const start = Date.now();

    try {
      // Mersennet CLOB units are plain integers — no decimal rescaling.
      const toUsd = (v) => {
        if (v == null) return 0;
        const s = String(v);
        const n = s.startsWith('0x') ? Number(BigInt(s)) : Number(s);
        return Number.isFinite(n) && n > 0 ? n : 0;
      };
      const toBase = toUsd;

      const tickerPromises = chain.MARKETS.map(async (m) => {
        try {
          const [{ bestBid, bestAsk }, oraclePx] = await Promise.all([
            chain.getBestBidAsk(m.id),
            chain.getOraclePriceForDisplay(m.id).catch(() => ({ price: '0', age: 0 })),
          ]);
          const bid = toUsd(bestBid);
          const ask = toUsd(bestAsk);
          const oracleUsd = oraclePx.price !== '0' ? toUsd(oraclePx.price) : 0;
          // Mark price policy:
          //  - Two-sided book within 5% of oracle: use mid-of-book
          //  - Anything else: use oracle (one-sided book or stale resting orders
          //    can otherwise drag the mark away from reality during early beta).
          let markPrice;
          if (bid > 0 && ask > 0 && oracleUsd > 0) {
            const mid = (bid + ask) / 2;
            const dev = Math.abs(mid - oracleUsd) / oracleUsd;
            markPrice = dev < 0.05 ? mid : oracleUsd;
          } else {
            markPrice = oracleUsd || bid || ask;
          }

          // trades.price and trades.size are plain integer chain units.
          const [volR, chgR] = await Promise.all([
            pool.query(
              `SELECT COALESCE(SUM(price * size), 0)::float8 as volume,
                      COUNT(*) as trades
                 FROM trades
                 WHERE market_id = $1 AND block_timestamp > NOW() - interval '24 hours'`,
              [m.id]
            ),
            // Reference candle from ~24h ago and the latest candle, both in
            // the SAME chain price units, so the % is unit-consistent.
            pool.query(
              `SELECT
                 (SELECT close FROM candles
                    WHERE market_id = $1 AND resolution = '1h'
                      AND open_time <= NOW() - interval '24 hours'
                    ORDER BY open_time DESC LIMIT 1) AS ref_close,
                 (SELECT close FROM candles
                    WHERE market_id = $1 AND resolution = '1h'
                    ORDER BY open_time DESC LIMIT 1) AS last_close`,
              [m.id]
            ),
          ]);

          const volume24h = Number(volR.rows[0]?.volume || 0);
          const trades24h = Number(volR.rows[0]?.trades || 0);

          // 24h change: prefer the real public-exchange feed for markets
          // that have one (BTC/ETH/SOL/ARB). For MRSN (no external feed)
          // derive it from our own candles using a 24h-ago reference in
          // matching units — never by mixing USD mark with chain-unit
          // candles, which produced nonsense values like +125%.
          let change24h = 0;
          const cached = getCachedChange24hPct(m.id);
          if (Number.isFinite(cached)) {
            change24h = Math.round(cached * 100) / 100;
          } else {
            const ref = Number(chgR.rows[0]?.ref_close || 0);
            const last = Number(chgR.rows[0]?.last_close || 0);
            if (ref > 0 && last > 0) {
              change24h = Math.round(((last - ref) / ref) * 10000) / 100;
            }
          }

          const oi = await getOiStats(m.id, markPrice);
          const ticker = {
            type: 'ticker', marketId: m.id, bestBid: bid, bestAsk: ask,
            markPrice, volume24h, trades24h, change24h,
            oracleMarkUsd: oracleUsd, oracleAgeSec: oraclePx.age,
            openInterest: oi.openInterest,
            longAccounts: oi.longAccounts,
            shortAccounts: oi.shortAccounts,
            timestamp: Date.now(),
          };
          dataCache.tickers.set(m.id, ticker);
          broadcastToChannel(`ticker:${m.id}`, ticker);
        } catch (e) {
          // silent — stale data stays in cache
        }
      });

      const orderbookPromises = chain.MARKETS.map(async (m) => {
        try {
          const book = await chain.getOrderBook(m.id);
          const parseLevel = (l) => {
            if (Array.isArray(l)) return [toUsd(l[0]), toBase(l[1])];
            return [toUsd(l.price), toBase(l.size)];
          };
          const parsed = {
            type: 'orderbook', marketId: m.id,
            bids: (book?.bids || []).map(parseLevel),
            asks: (book?.asks || []).map(parseLevel),
            timestamp: Date.now(),
          };
          dataCache.orderbooks.set(m.id, parsed);
          broadcastToChannel(`orderbook:${m.id}`, parsed);
        } catch (e) {
          // silent
        }
      });

      await Promise.allSettled([...tickerPromises, ...orderbookPromises]);
      await broadcastRecentTrades();

      const elapsed = Date.now() - start;
      console.log(`[ws] Data refresh: ${elapsed}ms (${chain.MARKETS.length} markets)`);
    } catch (e) {
      console.error('[ws] Update error:', e.message);
    } finally {
      isUpdating = false;
    }
  }

  async function broadcastRecentTrades() {
    for (const m of chain.MARKETS) {
      try {
        const lastId = lastTradeIds.get(m.id) || 0;
        const result = await pool.query(
          `SELECT id, block_number, block_timestamp, market_id, taker, maker, side, price, size
           FROM trades WHERE market_id = $1 AND id > $2
           ORDER BY id DESC LIMIT 20`,
          [m.id, lastId]
        );
        if (result.rows.length > 0) {
          lastTradeIds.set(m.id, result.rows[0].id);
          for (const row of result.rows) {
            const tradeData = {
              type: 'trade', id: row.id, marketId: row.market_id,
              side: row.side, price: Number(row.price), size: Number(row.size),
              time: row.block_timestamp, taker: row.taker, maker: row.maker,
            };
            broadcastToChannel(`trades:${m.id}`, tradeData);
            if (row.taker) broadcastToChannel(`trades:followed:${row.taker.toLowerCase()}`, tradeData);
            if (row.maker) broadcastToChannel(`trades:followed:${row.maker.toLowerCase()}`, tradeData);
          }
        }
      } catch (e) {
        console.error(`[ws] Trades broadcast error market ${m.id}:`, e.message);
      }
    }
  }

  function broadcastToChannel(channel, data) {
    const msg = JSON.stringify(data);
    for (const [ws, channels] of subscriptions) {
      if (channels.has(channel) && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch (e) {
          console.error('[ws] Broadcast error:', e.message);
        }
      }
    }
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      for (const [ws] of subscriptions) {
        if (ws.readyState === WebSocket.OPEN) {
          if (ws._isAlive === false) {
            subscriptions.delete(ws);
            ws.terminate();
            continue;
          }
          ws._isAlive = false;
          ws.ping();
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  wss.on('connection', (ws) => {
    ws._isAlive = true;
    subscriptions.set(ws, new Set());

    ws.on('pong', () => { ws._isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const channels = subscriptions.get(ws);
        if (!channels) return;

        if (msg.action === 'subscribe' && msg.channel) {
          if (!VALID_CHANNELS.test(msg.channel)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel' }));
            return;
          }
          channels.add(msg.channel);
          ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));

          // Send cached data immediately on subscribe
          const match = msg.channel.match(/^(ticker|orderbook):(\d+)$/);
          if (match) {
            const [, type, id] = match;
            const cached = type === 'ticker'
              ? dataCache.tickers.get(Number(id))
              : dataCache.orderbooks.get(Number(id));
            if (cached) {
              try { ws.send(JSON.stringify(cached)); } catch (_) {}
            }
          }
        } else if (msg.action === 'unsubscribe' && msg.channel) {
          channels.delete(msg.channel);
          ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
        } else if (msg.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (e) {
        console.error('[ws] Client message parse error:', e.message);
      }
    });

    ws.on('close', () => {
      subscriptions.delete(ws);
    });

    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now(), channels: ['blocks', 'ticker:{marketId}', 'orderbook:{marketId}', 'trades:{marketId}'] }));
  });

  connectChainWs();
  startHeartbeat();

  // Start initial cache warm-up
  setTimeout(() => updateAllParallel(), 2000);

  // Reliable polling fallback (WS events may not flow through Nginx proxy)
  setInterval(() => throttledUpdate(), UPDATE_THROTTLE);

  wss.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  console.log(`[ws] WebSocket server ready on /ws (heartbeat: ${HEARTBEAT_INTERVAL / 1000}s)`);
  return wss;
}

module.exports = { setupWebSocket, dataCache };
