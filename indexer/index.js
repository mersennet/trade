// dotenv is optional — production uses pm2-injected env vars, dev uses a .env
try { require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true }); } catch (_) { /* ok */ }
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const WS_URL = process.env.WS_URL || 'wss://rpc.mersennet.com';
const DB_URL = process.env.DATABASE_URL || 'postgresql://mersennet:m3rs3nn3t_db_2026@127.0.0.1:5432/mersennet_trade';
const REPORT_PORT = process.env.REPORT_PORT || 4010;
// Bind host for the internal trade-report server. Defaults to loopback (safe on
// a bare host); set REPORT_HOST=0.0.0.0 in docker so the api container can reach
// it over the internal network (the port is not published externally).
const REPORT_HOST = process.env.REPORT_HOST || '127.0.0.1';

const pool = new Pool({ connectionString: DB_URL, max: 10, idleTimeoutMillis: 30000 });
let rpcId = 1;

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function getLastIndexedBlock() {
  const r = await pool.query('SELECT last_block FROM indexer_state WHERE id = 1');
  return r.rows[0]?.last_block || 0;
}

async function setLastIndexedBlock(block) {
  await pool.query('UPDATE indexer_state SET last_block = $1, last_indexed_at = NOW() WHERE id = 1', [block]);
}

function parseHex(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function hexToAddress(hex) {
  if (!hex) return '0x0';
  const clean = hex.replace('0x', '').toLowerCase();
  return '0x' + clean.slice(-40);
}

function decodeU256(hex, offset = 0) {
  const h = hex.replace('0x', '');
  return BigInt('0x' + (h.slice(offset * 64, offset * 64 + 64) || '0'));
}

function decodeI128(hex, offset = 0) {
  const v = decodeU256(hex, offset) & ((1n << 128n) - 1n);
  return v >= (1n << 127n) ? v - (1n << 128n) : v;
}

function formatAmount(bigintVal, decimals = 18) {
  const str = bigintVal.toString();
  if (decimals === 0) return str;
  const padded = str.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, -decimals) || '0';
  const fracPart = padded.slice(-decimals);
  return `${intPart}.${fracPart}`;
}

async function processEvents(events, blockNumber, filterBlock = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const ev of (filterBlock ? events.filter(e => {
      const evBlock = e.block_number ? Number(BigInt(e.block_number)) : blockNumber;
      return evBlock >= blockNumber;
    }) : events)) {
      const domain = (ev.domain || '').toLowerCase();
      const kind = (ev.kind || '').toLowerCase();
      const data = ev.data || {};

      if (domain === 'mersennet_orders') {
        const hexToNum = (v) => {
          if (!v) return 0;
          if (typeof v === 'number') return v;
          if (typeof v === 'string' && v.startsWith('0x')) return Number(BigInt(v));
          return Number(v) || 0;
        };

        switch (kind) {
          case 'trade': {
            const taker = data.taker || '0x0';
            const maker = data.maker || '0x0';
            const marketId = hexToNum(data.market_id ?? data.marketId);
            const side = (data.side || 'buy').toLowerCase();
            // Trades table is `numeric(78,0)` — accept raw integer strings as-is
            // (sequencer sends 1e8 price + 1e18 size). Reject anything that
            // isn't a positive integer string.
            const priceStr = data.price != null ? String(data.price) : '';
            const sizeStr = data.size != null ? String(data.size) : '';
            const isPosInt = (s) => /^[0-9]+$/.test(s) && s !== '0';
            const evBlock = ev.block_number ? Number(ev.block_number) : blockNumber;
            if (marketId > 0 && isPosInt(priceStr) && isPosInt(sizeStr)) {
              await client.query(
                `INSERT INTO trades (block_number, block_timestamp, market_id, taker, maker, side, price, size)
                 VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)
                 ON CONFLICT DO NOTHING`,
                [evBlock, marketId, taker.toLowerCase(), maker.toLowerCase(), side, priceStr, sizeStr]
              );
            }
            break;
          }
          case 'order_submitted': {
            const owner = data.owner || '0x0';
            const orderId = data.order_id ?? data.orderId ?? '0';
            const marketId = hexToNum(data.market_id ?? data.marketId);
            const side = (data.side || 'buy').toLowerCase();
            const price = hexToNum(data.price);
            const size = hexToNum(data.size);
            const filled = hexToNum(data.filled);
            const remaining = hexToNum(data.remaining);
            const status = remaining === 0 ? 'filled' : filled > 0 ? 'partial' : 'submitted';
            await client.query(
              `INSERT INTO orders_history (order_id, block_number, owner, market_id, side, price, size, filled, status, tif)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT DO NOTHING`,
              [orderId, blockNumber, owner.toLowerCase(), marketId, side, price, size, filled, status, data.tif || 'gtc']
            );
            break;
          }
          case 'order_cancelled': {
            const orderId = data.order_id ?? data.orderId ?? '0';
            await client.query(
              `UPDATE orders_history SET status = 'cancelled' WHERE order_id = $1 AND status != 'filled'`,
              [orderId]
            );
            break;
          }
          case 'collateral_deposited': {
            const owner = data.owner || '0x0';
            const amount = hexToNum(data.amount);
            await client.query(
              `INSERT INTO collateral_events (block_number, address, event_type, amount)
               VALUES ($1, $2, 'deposit', $3)`,
              [blockNumber, owner.toLowerCase(), amount]
            );
            break;
          }
          case 'liquidation': {
            const owner = data.owner || '0x0';
            await client.query(
              `INSERT INTO liquidations (block_number, address)
               VALUES ($1, $2)`,
              [blockNumber, owner.toLowerCase()]
            );
            break;
          }
          case 'margin_params_updated':
          case 'market_added':
            break;
          default:
            break;
        }
      }
    }
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function backfill() {
  console.log('[indexer] Skipping heavy backfill (WS handles live events)');
  try {
    const currentBlockHex = await rpc('eth_blockNumber');
    const currentBlock = Number(parseHex(currentBlockHex));
    const lastIndexed = await getLastIndexedBlock();
    console.log(`[indexer] Last indexed: ${lastIndexed}, Current: ${currentBlock}`);
    // Just update to current block so WS picks up from here
    if (currentBlock > lastIndexed) {
      await setLastIndexedBlock(currentBlock);
      console.log(`[indexer] Jumped to block ${currentBlock}`);
    }
  } catch (e) {
    console.error('[indexer] Backfill skip error:', e.message);
  }
}

const MINUTE_MULTIPLIERS = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };

// ---------------------------------------------------------------------------
// Oracle-driven candle synthesis
// ---------------------------------------------------------------------------
// Until real on-chain trades start populating `candles`, the chart would be
// empty (or, with a single trade, render as a single vertical bar — which
// looks like a broken page). We solve this in two layers:
//
//   1) Backfill (run once at startup)
//      For BTC/ETH/SOL we pull 24h of real 1m klines from Binance — that's
//      the same reference market the pricer itself reads from, so the
//      chart matches our reference history. For MRSN we lay down a flat
//      line at the current oracle price (we have no public history with
//      that symbol).
//
//   2) Forward synth (every 30s)
//      For every market × every timeframe, upsert a candle for the *current*
//      bucket using the live oracle price. The upsert NEVER overwrites a
//      candle that already has trade_count > 0 — real trade-derived candles
//      always win. Once organic volume picks up, the synth becomes a no-op.
// ---------------------------------------------------------------------------

// Sources tried in order. Binance has the deepest 1m history for the majors.
// MRSN has no centralized listing with public klines, so it falls through to
// the flat-reference backfill. Market ids match api/src/services/chain.js.
const ORACLE_MARKETS = [
  { id: 1, symbol: 'MRSN', binance: null,      mexc: null      },
  { id: 2, symbol: 'BTC',  binance: 'BTCUSDT', mexc: 'BTCUSDT' },
  { id: 3, symbol: 'ETH',  binance: 'ETHUSDT', mexc: 'ETHUSDT' },
  { id: 4, symbol: 'SOL',  binance: 'SOLUSDT', mexc: 'SOLUSDT' },
  { id: 5, symbol: 'ARB',  binance: 'ARBUSDT', mexc: 'ARBUSDT' },
];

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4005/api/v1';

/** Read live oracle prices for all markets via the local API (already polling
 *  the chain). Returns Map<marketId, priceFloat>. Empty markets are skipped. */
async function fetchOraclePrices() {
  const out = new Map();
  await Promise.all(ORACLE_MARKETS.map(async (m) => {
    try {
      const r = await fetch(`${API_BASE}/markets/${m.id}/ticker`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return;
      const j = await r.json();
      const px = Number(j.oracleMarkUsd || j.markPrice || 0);
      if (px > 0) out.set(m.id, px);
    } catch (_) { /* swallow — we'll try again next tick */ }
  }));
  return out;
}

/** Mersennet CLOB prices are plain units — store the USD price as-is
 *  (rounded to 8 dp so the numeric column stays tidy). */
function usdToRaw(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 1e8) / 1e8;
}

/** Upsert a single OHLCV row, but never clobber a candle a real trade
 *  already filled (trade_count > 0). */
async function upsertSyntheticCandle(marketId, resolution, openTime, openRaw, highRaw, lowRaw, closeRaw) {
  await pool.query(`
    INSERT INTO candles (market_id, resolution, open_time, open, high, low, close, volume, trade_count)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0)
    ON CONFLICT (market_id, resolution, open_time) DO UPDATE SET
      open  = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.open  ELSE candles.open  END,
      high  = CASE WHEN candles.trade_count = 0 THEN GREATEST(candles.high, EXCLUDED.high) ELSE candles.high END,
      low   = CASE WHEN candles.trade_count = 0 THEN LEAST(candles.low,   EXCLUDED.low)   ELSE candles.low  END,
      close = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.close ELSE candles.close END
  `, [
    marketId, resolution, openTime,
    openRaw.toString(), highRaw.toString(), lowRaw.toString(), closeRaw.toString(),
  ]);
}

function bucketStart(now, multiplierMin) {
  const bucketMs = multiplierMin * 60 * 1000;
  return new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
}

let oracleSynthCount = 0;

async function synthesizeOracleCandles() {
  const prices = await fetchOraclePrices();
  if (prices.size === 0) return;
  const now = new Date();

  // Persist the live oracle marks so /api/v1/oracle/prices and /oracle/health
  // are populated (they read the oracle_prices table, which previously had no
  // writer). Best-effort — never let an oracle-cache error break candle synth.
  for (const [marketId, px] of prices) {
    const sym = ORACLE_MARKETS.find((m) => m.id === marketId)?.symbol;
    if (!sym || !(px > 0)) continue;
    try {
      await pool.query(
        `INSERT INTO oracle_prices (symbol, price, confidence, sources, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (symbol) DO UPDATE SET
           price = EXCLUDED.price, confidence = EXCLUDED.confidence,
           sources = EXCLUDED.sources, updated_at = NOW()`,
        [sym, px, 0.99, 1]
      );
    } catch (_) { /* table may be absent on an un-migrated deploy */ }
  }

  for (const [marketId, px] of prices) {
    const raw = usdToRaw(px);
    if (raw === 0) continue;
    for (const [resolution, mult] of Object.entries(MINUTE_MULTIPLIERS)) {
      try {
        await upsertSyntheticCandle(marketId, resolution, bucketStart(now, mult), raw, raw, raw, raw);
      } catch (e) {
        if (oracleSynthCount % 50 === 0) {
          console.error(`[oracle-candles] ${marketId}/${resolution}:`, e.message);
        }
      }
    }
  }
  oracleSynthCount++;
  if (oracleSynthCount === 1 || oracleSynthCount % 60 === 0) {
    console.log(`[oracle-candles] tick #${oracleSynthCount} — synth ${prices.size} markets × 7 timeframes`);
  }
}

/** Generic 1m klines fetcher. Both Binance and MEXC return the same array
 *  shape: [openTime, open, high, low, close, volume, ...]. */
async function fetch1mKlines(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((k) => ({
      openTime: new Date(Number(k[0])),
      open:     Number(k[1]),
      high:     Number(k[2]),
      low:      Number(k[3]),
      close:    Number(k[4]),
    }));
  } catch (_) { return null; }
}

/** Try Binance, then MEXC. Returns klines or null. */
async function fetchKlines1m(market, hours = 24) {
  const limit = Math.min(hours * 60, 1000);
  if (market.binance) {
    const k = await fetch1mKlines(`https://api.binance.com/api/v3/klines?symbol=${market.binance}&interval=1m&limit=${limit}`);
    if (k) return { source: 'binance', klines: k };
  }
  if (market.mexc) {
    const k = await fetch1mKlines(`https://api.mexc.com/api/v3/klines?symbol=${market.mexc}&interval=1m&limit=${limit}`);
    if (k) return { source: 'mexc', klines: k };
  }
  return null;
}

/** Backfill candles for one market at all 7 timeframes. Uses Binance/MEXC 1m
 *  if available, otherwise lays down a flat line at `flatPrice`. */
async function backfillMarket(market, flatPriceUsd) {
  const result = await fetchKlines1m(market, 24);
  const klines = result?.klines;

  if (klines) {
    // Real history. Insert all 1m candles, then roll up into bigger buckets.
    let inserted = 0;
    for (const k of klines) {
      try {
        await upsertSyntheticCandle(
          market.id, '1m', k.openTime,
          usdToRaw(k.open), usdToRaw(k.high), usdToRaw(k.low), usdToRaw(k.close),
        );
        inserted++;
      } catch (_) {}
    }
    // Higher timeframes: aggregate from the freshly-inserted 1m rows so the
    // chart looks correct on every resolution toggle.
    for (const [resolution, mult] of Object.entries(MINUTE_MULTIPLIERS)) {
      if (resolution === '1m') continue;
      try {
        await pool.query(`
          INSERT INTO candles (market_id, resolution, open_time, open, high, low, close, volume, trade_count)
          SELECT $1::int, $2::text,
                 date_trunc('minute', open_time) -
                   (EXTRACT(MINUTE FROM open_time)::int % $3) * interval '1 minute' as bucket,
                 (array_agg(open  ORDER BY open_time ASC))[1],
                 MAX(high), MIN(low),
                 (array_agg(close ORDER BY open_time DESC))[1],
                 0, 0
          FROM candles
          WHERE market_id = $1 AND resolution = '1m'
            AND open_time >= NOW() - interval '24 hours'
          GROUP BY bucket
          ON CONFLICT (market_id, resolution, open_time) DO UPDATE SET
            open  = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.open  ELSE candles.open  END,
            high  = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.high  ELSE candles.high  END,
            low   = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.low   ELSE candles.low   END,
            close = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.close ELSE candles.close END
        `, [market.id, resolution, mult]);
      } catch (e) {
        console.error(`[backfill] rollup ${market.symbol}/${resolution}:`, e.message);
      }
    }
    console.log(`[backfill] ${market.symbol} (${result.source}): ${inserted} 1m candles + 6 rollup tfs`);
    return;
  }

  // No Binance source. Lay a flat oracle price across the last 60 buckets per tf.
  if (flatPriceUsd <= 0) return;
  const raw = usdToRaw(flatPriceUsd);
  const now = new Date();
  for (const [resolution, mult] of Object.entries(MINUTE_MULTIPLIERS)) {
    const bucketMs = mult * 60 * 1000;
    const N = resolution === '1m' ? 120 : resolution === '5m' ? 100 : 60;
    for (let i = 0; i < N; i++) {
      const t = new Date(Math.floor((now.getTime() - i * bucketMs) / bucketMs) * bucketMs);
      try {
        await upsertSyntheticCandle(market.id, resolution, t, raw, raw, raw, raw);
      } catch (_) {}
    }
  }
  console.log(`[backfill] ${market.symbol}: flat-oracle line @ $${flatPriceUsd}`);
}

async function backfillOracleCandles() {
  console.log('[backfill] starting candle backfill...');
  const prices = await fetchOraclePrices();
  // Run sequentially so we don't slam Binance with parallel requests.
  for (const m of ORACLE_MARKETS) {
    await backfillMarket(m, prices.get(m.id) || 0);
  }
  console.log('[backfill] done');
}

async function aggregateCandles() {
  const resolutions = [
    { name: '1m', interval: '1 minute' },
    { name: '5m', interval: '5 minutes' },
    { name: '15m', interval: '15 minutes' },
    { name: '1h', interval: '1 hour' },
    { name: '4h', interval: '4 hours' },
    { name: '1d', interval: '1 day' },
    { name: '1w', interval: '1 week' },
  ];
  
  for (const res of resolutions) {
    try {
      const multiplier = MINUTE_MULTIPLIERS[res.name] || 1;
      await pool.query(`
        INSERT INTO candles (market_id, resolution, open_time, open, high, low, close, volume, trade_count)
        SELECT
          market_id,
          $1 as resolution,
          date_trunc('minute', block_timestamp) -
            (EXTRACT(MINUTE FROM block_timestamp)::int % ${multiplier}) * interval '1 minute' as open_time,
          (array_agg(price ORDER BY block_timestamp ASC))[1] as open,
          MAX(price) as high,
          MIN(price) as low,
          (array_agg(price ORDER BY block_timestamp DESC))[1] as close,
          SUM(size) as volume,
          COUNT(*) as trade_count
        FROM trades
        WHERE block_timestamp IS NOT NULL AND block_timestamp > NOW() - interval '1 day'
        GROUP BY market_id, open_time
        ON CONFLICT (market_id, resolution, open_time)
        DO UPDATE SET
          high = GREATEST(candles.high, EXCLUDED.high),
          low = LEAST(candles.low, EXCLUDED.low),
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          trade_count = EXCLUDED.trade_count
      `, [res.name]);
    } catch (e) {
      console.error(`[candles] Error aggregating ${res.name}:`, e.message);
    }
  }
}

// Trades are stored in plain integer chain units, so price*size is already
// a plain USD-equivalent number. No rescaling needed before persisting.
const TRADE_USD_SCALE = '1';

async function updateLeaderboard() {
  const periods = [
    { name: 'daily', interval: '1 day' },
    { name: 'weekly', interval: '7 days' },
    { name: 'monthly', interval: '30 days' },
    { name: 'alltime', interval: '100 years' },
  ];

  for (const period of periods) {
    try {
      // Per-trader PnL approximation: signed cash-flow over the period, in
      // USD. Negative for buys, positive for sells. Equals realized PnL when
      // positions net to zero, otherwise reads as cost basis with wrong sign
      // for open longs. Good enough for a beta leaderboard while we don't
      // have a per-position cost-basis tracker — mark it as such in the UI.
      //
      // Per-market roundtrips are used to derive a directionally correct
      // win/loss count: for each (trader, market) pair the cash-flow PnL is
      // computed in isolation, and we count it as a "win" if positive and a
      // "loss" if negative. This collapses partial fills into a single bucket
      // per market which is a reasonable beta heuristic.
      await pool.query(
        `WITH per_market AS (
           SELECT taker AS address,
                  market_id,
                  SUM(CASE WHEN side = 'buy' THEN -(price * size) ELSE price * size END)::numeric AS raw_pnl,
                  SUM(price * size)::numeric AS raw_vol,
                  COUNT(*) AS trade_count
           FROM trades
           WHERE block_timestamp IS NOT NULL
             AND block_timestamp > NOW() - $2::interval
           GROUP BY taker, market_id
         ),
         agg AS (
           SELECT address,
                  SUM(raw_pnl) / $3::numeric AS pnl,
                  SUM(raw_vol) / $3::numeric AS volume,
                  SUM(trade_count) AS trade_count,
                  COUNT(*) FILTER (WHERE raw_pnl > 0) AS win_count,
                  COUNT(*) FILTER (WHERE raw_pnl < 0) AS loss_count,
                  COALESCE(MAX(raw_pnl) / $3::numeric, 0) AS best_trade,
                  COALESCE(MIN(raw_pnl) / $3::numeric, 0) AS worst_trade
           FROM per_market
           GROUP BY address
         )
         INSERT INTO leaderboard (
           address, period, pnl, volume, trade_count,
           win_count, loss_count, best_trade, worst_trade
         )
         SELECT address, $1 AS period, pnl, volume, trade_count,
                win_count, loss_count, best_trade, worst_trade
         FROM agg
         ON CONFLICT (address, period) DO UPDATE SET
           pnl         = EXCLUDED.pnl,
           volume      = EXCLUDED.volume,
           trade_count = EXCLUDED.trade_count,
           win_count   = EXCLUDED.win_count,
           loss_count  = EXCLUDED.loss_count,
           best_trade  = EXCLUDED.best_trade,
           worst_trade = EXCLUDED.worst_trade,
           updated_at  = NOW()`,
        [period.name, period.interval, TRADE_USD_SCALE]
      );
    } catch (e) {
      console.error(`[leaderboard] Error updating ${period.name}:`, e.message);
    }
  }
}

// Loyalty points from cumulative taker volume. Idempotent: trading_points is
// recomputed from all-time volume each run and upserted, so re-runs never
// double-count. A `points` history row is written only for the positive delta
// since the last run, so the points page shows recent activity.
const POINTS_PER_USD = 1; // 1 point per $1 of taker notional volume
function pointsTier(total) {
  if (total >= 1_000_000) return 'Diamond';
  if (total >= 100_000) return 'Platinum';
  if (total >= 10_000) return 'Gold';
  if (total >= 1_000) return 'Silver';
  return 'Bronze';
}
async function awardPoints() {
  const season = 1;
  try {
    const vol = await pool.query(
      `SELECT LOWER(taker) AS address, SUM(price * size)::numeric AS volume
       FROM trades
       WHERE taker IS NOT NULL AND block_timestamp IS NOT NULL
       GROUP BY LOWER(taker)`
    );
    let updated = 0;
    for (const row of vol.rows) {
      const address = row.address;
      const volumeUsd = Number(row.volume) || 0;
      const trading = Math.floor((volumeUsd * POINTS_PER_USD) / TRADE_USD_SCALE);
      if (trading <= 0) continue;

      const existing = await pool.query(
        `SELECT trading_points, lp_points, referral_points FROM points_balance
         WHERE address = $1 AND season = $2`,
        [address, season]
      );
      const prev = existing.rows[0] || {};
      const prevTrading = Number(prev.trading_points) || 0;
      if (trading <= prevTrading) continue; // no new volume since last run

      const lp = Number(prev.lp_points) || 0;
      const ref = Number(prev.referral_points) || 0;
      const total = trading + lp + ref;

      await pool.query(
        `INSERT INTO points_balance
           (address, season, total_points, trading_points, lp_points, referral_points, tier, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (address, season) DO UPDATE SET
           total_points = EXCLUDED.total_points,
           trading_points = EXCLUDED.trading_points,
           tier = EXCLUDED.tier,
           updated_at = NOW()`,
        [address, season, total, trading, lp, ref, pointsTier(total)]
      );
      await pool.query(
        `INSERT INTO points (address, season, point_type, amount, reason)
         VALUES ($1, $2, 'trading', $3, 'Trading volume')`,
        [address, season, trading - prevTrading]
      );
      updated++;
    }
    if (updated > 0) console.log(`[points] awarded trading points to ${updated} trader(s)`);
    // Bound the history table — it gets one row per active trader per run.
    // Balances live in points_balance; 30 days of event history is plenty.
    await pool.query(`DELETE FROM points WHERE created_at < NOW() - interval '30 days'`).catch(() => {});
  } catch (e) {
    console.error('[points] Error awarding:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Live event tailing over the Mersennet WebSocket RPC.
// Subscribes to newHeads (block cursor) and MersennetOrdersTrades (fill events).
// HTTP polling below remains as a fallback when the WS endpoint is down.
// ---------------------------------------------------------------------------

let ws = null;
let reconnectTimer = null;

function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch (_) {}
  }

  console.log(`[indexer] Connecting to WebSocket: ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[indexer] WebSocket connected');
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'],
    }));
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'mersennet_subscribe', params: ['MersennetOrdersTrades'],
    }));
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        const result = msg.params.result;

        // New block header — just update the cursor, no heavy RPC calls.
        if (result.number) {
          const blockNum = Number(parseHex(result.number));
          await setLastIndexedBlock(blockNum);
        }

        // Direct trade push from the MersennetOrdersTrades subscription.
        if (result.taker || result.maker) {
          const lastBlock = await getLastIndexedBlock();
          await processEvents([{ domain: 'mersennet_orders', kind: 'trade', data: result }], lastBlock);
        }

        // Direct order event push.
        if (result.order_id && result.owner && !result.taker) {
          const lastBlock = await getLastIndexedBlock();
          const kind = result.remaining ? 'order_submitted' : 'order_cancelled';
          await processEvents([{ domain: 'mersennet_orders', kind, data: result }], lastBlock);
        }
      }
    } catch (e) {
      console.error('[indexer] WS message error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[indexer] WebSocket disconnected, reconnecting in 5s...');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (err) => {
    console.error('[indexer] WebSocket error:', err.message);
  });
}

// Fallback block-cursor polling over HTTP RPC.
const BLOCK_POLL_MS = Number(process.env.BLOCK_POLL_MS || 5000);
let blockPollTimer = null;
let consecutivePollErrors = 0;

async function pollBlockNumber() {
  try {
    const hex = await rpc('eth_blockNumber', []);
    const blockNum = Number(parseHex(hex));
    if (blockNum > 0) {
      await setLastIndexedBlock(blockNum);
      consecutivePollErrors = 0;
    }
  } catch (e) {
    consecutivePollErrors++;
    if (consecutivePollErrors === 1 || consecutivePollErrors % 12 === 0) {
      console.error(`[indexer] block poll error (${consecutivePollErrors}):`, e.message);
    }
  }
}

function startBlockPolling() {
  console.log(`[indexer] Polling eth_blockNumber every ${BLOCK_POLL_MS}ms via ${RPC_URL}`);
  pollBlockNumber();
  blockPollTimer = setInterval(pollBlockNumber, BLOCK_POLL_MS);
}

let tradeReportCount = 0;

function startTradeReportServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/trades') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const trades = JSON.parse(body);
          if (!Array.isArray(trades) || trades.length === 0) {
            res.writeHead(400); res.end('[]'); return;
          }
          const lastBlock = await getLastIndexedBlock();
          const events = trades.map(t => ({
            domain: 'mersennet_orders', kind: 'trade',
            block_number: t.block_number ?? t.blockNumber ?? lastBlock,
            data: {
              market_id: t.market_id ?? t.marketId,
              taker: (t.taker || '0x0').toLowerCase(),
              maker: (t.maker || '0x0').toLowerCase(),
              side: t.side,
              price: t.price,
              size: t.size,
            },
          }));
          await processEvents(events, lastBlock);
          tradeReportCount += trades.length;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, indexed: trades.length }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, trades: tradeReportCount }));
    } else {
      res.writeHead(404); res.end('not found');
    }
  });
  server.listen(REPORT_PORT, REPORT_HOST, () => {
    console.log(`[indexer] Trade report server on http://${REPORT_HOST}:${REPORT_PORT}/trades`);
  });
}

async function main() {
  console.log('[indexer] Mersennet Trade Indexer starting...');
  console.log(`[indexer] RPC: ${RPC_URL}`);
  console.log(`[indexer] WS:  ${WS_URL}`);
  
  let retries = 0;
  while (retries < 5) {
    try {
      await pool.query('SELECT 1');
      console.log('[indexer] PostgreSQL connected');
      break;
    } catch (e) {
      retries++;
      console.error(`[indexer] PostgreSQL connection failed (attempt ${retries}/5):`, e.message);
      if (retries >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  await backfill();
  
  connectWebSocket();
  startBlockPolling();
  startTradeReportServer();
  
  setInterval(aggregateCandles, 60_000);
  setInterval(updateLeaderboard, 300_000);
  setInterval(awardPoints, 300_000);
  // Synthesize a candle from the live oracle every 30s so the chart never
  // looks empty even when there's no organic trading volume yet.
  setInterval(synthesizeOracleCandles, 30_000);

  aggregateCandles();
  updateLeaderboard();
  awardPoints();

  // Fire-and-forget historical backfill — don't block startup.
  // We delay 5s to let the API service finish its own oracle warmup.
  setTimeout(() => {
    backfillOracleCandles().catch((e) => console.error('[backfill] failed:', e.message));
  }, 5000);
  // First forward synth right after backfill kicks off.
  setTimeout(() => synthesizeOracleCandles().catch(() => {}), 8000);

  console.log('[indexer] Running. Candle aggregation 60s | oracle synth 30s | leaderboard 5m | points 5m.');
}

main().catch(e => {
  console.error('[indexer] Fatal:', e);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('[indexer] Shutting down...');
  if (blockPollTimer) clearInterval(blockPollTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(); } catch (_) {} }
  await pool.end();
  process.exit(0);
});
