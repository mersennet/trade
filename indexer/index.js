// dotenv is optional — production uses pm2-injected env vars, dev uses a .env
try { require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true }); } catch (_) { /* ok */ }
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');

const RPC_URL = process.env.RPC_URL || 'https://rpc.mersennet.com';
const WS_URL = process.env.WS_URL || 'wss://rpc.mersennet.com';
const DB_URL = process.env.DATABASE_URL || 'postgresql://mersennet:m3rs3nn3t_db_2026@127.0.0.1:5432/mersennet_trade';
const REPORT_PORT = process.env.REPORT_PORT || 4010;

// Shared secret required to POST trades to the internal report endpoint. The
// endpoint writes straight into the trades/leaderboard tables, so leaving it
// open lets anything on the network forge volume/PnL. Set REPORT_SECRET on the
// indexer and the same value on the api/bots that report fills.
const REPORT_SECRET = process.env.REPORT_SECRET || '';

// Market-maker/taker bot addresses to exclude from the leaderboard and points
// (comma-separated, any case). Bots now use real keypairs (not 0x0000-prefixed
// system addresses), so the old prefix heuristic no longer catches them.
// Default list matches BOT_SEED=mersennet-bot-v1 / NUM_TAKERS=20 (maker + taker-0..19).
const DEFAULT_BOT_ADDRESSES = [
  // The maker vault (quoted by the maker bot through an agent key): its fills
  // are bot fills for every human-vs-bot statistic. The liquidation keeper's
  // address depends on BOT_SEED and is listed in BOT_ADDRESSES (.env).
  '0xe77f94c4bf7d6d2e2371afde440a0b9b8a567725',
  '0x6dd9bb44ddfaba76d8868915d6fe80c3f8a932ec',
  '0x2d268a6cf714a0a58a84c5345f2113f562a9ecb6',
  '0x05ed2c228f7fd5fc5750fbc36e7cc9ed95fdb08e',
  '0x5d6bc28f0db7048fe28dfb13cb4ddcb145ccd340',
  '0xd7e327055ab807d15dba84cf37524c4cf50e85b2',
  '0x2022e622d892221acef633987f84c446995608f1',
  '0xf27147c700feae6699be064df85f9a51958bfba3',
  '0x02305256df788283dd4881d53a291dffb9285614',
  '0x063d85c5aa15a3046d3bd2adb1e25718d1e203d0',
  '0xd4a93bdc80411dc27f5cd28c5faee9d5a368b53e',
  '0xae19feacea693facaebc3a24572ff30af84287df',
  '0x19a8e9379bdd2e4fb73473d746d44dc590233c28',
  '0x6e59d540f1843f51cfc72f18af04b1e1b99a6306',
  '0xd33b3b34eec8e2d116f948ce9f9c279ce74df4b8',
  '0x2f5e283d1dd4be66c4a692b83cdb266359d63989',
  '0xe08fd6ff63b370beaedf7710db362b3ae2b5d224',
  '0xb9d3191b8e762466e1ff523163f4517a11cc5a01',
  '0x85b593a711bcc721a33929300f39ccd04e94b644',
  '0x599d48e9028190f0ce46ca2b64101d42ea07d0b9',
  '0xa038a60c9ef33de711f4604573a7e1431a37d933',
  '0xed8db2dfc8999f859048ce83d555281d627df845',
];
// The configured list ADDS to the defaults: every bot generation we have ever
// run stays excluded, otherwise a seed rotation leaves the previous bots'
// balances on the board (that is exactly what happened before 2026-09-15).
const BOT_ADDRESSES = [...new Set(
  [...DEFAULT_BOT_ADDRESSES, ...(process.env.BOT_ADDRESSES || '').split(',')]
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
)];
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
// ---------------------------------------------------------------------------
// Price scale. On-chain prices are human × the market's priceScale (from
// `mersennet_orders_getMarkets`, 1 until a market is rescaled to finer ticks).
// Stored rows (trades, orders_history, candles) always carry chain prices at
// the CURRENT scale: when the chain scale of a market grows by k, the rows
// are multiplied by k once, in a transaction, so every reader can divide
// uniformly by the current scale. `market_price_scales` remembers the scale
// each market's rows are stored at.
// ---------------------------------------------------------------------------
const PRICE_SCALES = new Map(); // market_id -> scale the DB rows are stored at
function priceScaleOf(marketId) { return PRICE_SCALES.get(Number(marketId)) || 1; }
function priceScaleSql(col = 'market_id') {
  const cases = [...PRICE_SCALES.entries()].filter(([, sc]) => sc !== 1)
    .map(([id, sc]) => `WHEN ${Number(id)} THEN ${Number(sc)}`).join(' ');
  return cases ? `(CASE ${col} ${cases} ELSE 1 END)` : '1';
}
async function ensurePriceScaleSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS market_price_scales (
    market_id INT PRIMARY KEY, scale BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const r = await pool.query('SELECT market_id, scale FROM market_price_scales');
  for (const row of r.rows) PRICE_SCALES.set(Number(row.market_id), Number(row.scale));
}
async function syncPriceScales() {
  let live;
  try { live = await rpc('mersennet_orders_getMarkets', []); } catch (e) { return; }
  if (!Array.isArray(live)) return;
  // Rows written after the switch block already carry the new scale (the WS
  // feed keeps inserting while we run); only rows from before it are rescaled.
  let switchHeight = 0;
  try { switchHeight = Number((await rpc('mersennet_orders_getProtocol', []))?.switches?.priceScaleHeight || 0); } catch { /* fall back to all rows */ }
  for (const m of live) {
    const id = Number(m.id);
    let chainScale = 1;
    try { chainScale = Math.max(1, Number(BigInt(m.priceScale ?? 1))); } catch { chainScale = 1; }
    const stored = priceScaleOf(id);
    if (chainScale === stored) continue;
    if (chainScale < stored || chainScale % stored !== 0) {
      console.error(`[scale] market ${id}: chain scale ${chainScale} not a multiple of stored ${stored}; refusing to migrate`);
      continue;
    }
    const k = chainScale / stored;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize against concurrent inserts for this market while rows are rescaled.
      await client.query('LOCK TABLE trades, orders_history, candles IN SHARE ROW EXCLUSIVE MODE');
      const t = switchHeight > 0
        ? await client.query('UPDATE trades SET price = price * $2 WHERE market_id = $1 AND block_number < $3', [id, k, switchHeight])
        : await client.query('UPDATE trades SET price = price * $2 WHERE market_id = $1', [id, k]);
      const o = switchHeight > 0
        ? await client.query('UPDATE orders_history SET price = price * $2 WHERE market_id = $1 AND block_number < $3', [id, k, switchHeight])
        : await client.query('UPDATE orders_history SET price = price * $2 WHERE market_id = $1', [id, k]);
      // Candles: multiply everything; the last day is re-aggregated from
      // trades within a minute (authoritative), older buckets keep the factor.
      const c = await client.query('UPDATE candles SET open = open * $2, high = high * $2, low = low * $2, close = close * $2 WHERE market_id = $1', [id, k]);
      await client.query(`INSERT INTO market_price_scales (market_id, scale, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (market_id) DO UPDATE SET scale = EXCLUDED.scale, updated_at = NOW()`, [id, chainScale]);
      await client.query('COMMIT');
      PRICE_SCALES.set(id, chainScale);
      console.log(`[scale] market ${id}: ${stored} -> ${chainScale} (×${k}); rescaled ${t.rowCount} trades, ${o.rowCount} orders, ${c.rowCount} candles`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[scale] market ${id} migration failed:`, e.message);
    } finally {
      client.release();
    }
  }
}

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

/** Human USD → chain price units for `marketId` (× priceScale; integer column). */
function usdToRaw(usd, marketId) {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * priceScaleOf(marketId));
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
    const raw = usdToRaw(px, marketId);
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
          usdToRaw(k.open, market.id), usdToRaw(k.high, market.id), usdToRaw(k.low, market.id), usdToRaw(k.close, market.id),
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
                 date_bin(($3::text || ' minutes')::interval, open_time, TIMESTAMPTZ '1970-01-01') as bucket,
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
  const raw = usdToRaw(flatPriceUsd, market.id);
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
      await pool.query(`
        INSERT INTO candles (market_id, resolution, open_time, open, high, low, close, volume, trade_count)
        SELECT
          market_id,
          $1 as resolution,
          -- date_bin aligns every timeframe correctly (the old minute-modulo
          -- math produced hourly buckets mislabeled as 4h/1d/1w). Epoch
          -- origin matches the JS bucketStart() used by the synth writer so
          -- synthetic and trade-derived candles share bucket boundaries.
          date_bin('${res.interval}', block_timestamp, TIMESTAMPTZ '1970-01-01') as open_time,
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
          -- A trade-derived candle fully REPLACES a synthetic (trade_count=0)
          -- one: merging with GREATEST/LEAST kept stale synthetic highs/lows
          -- and the synthetic open forever. Trade-vs-trade updates still
          -- merge so late-arriving trades widen the range.
          open  = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.open ELSE candles.open END,
          high  = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.high ELSE GREATEST(candles.high, EXCLUDED.high) END,
          low   = CASE WHEN candles.trade_count = 0 THEN EXCLUDED.low  ELSE LEAST(candles.low, EXCLUDED.low) END,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume,
          trade_count = EXCLUDED.trade_count
      `, [res.name]);
    } catch (e) {
      console.error(`[candles] Error aggregating ${res.name}:`, e.message);
    }
  }
}

// Notional = price × size ÷ the market's priceScale (see syncPriceScales).
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
                  SUM(CASE WHEN side = 'buy' THEN -(price * size) ELSE price * size END)::numeric / ${priceScaleSql('market_id')} AS raw_pnl,
                  SUM(price * size)::numeric / ${priceScaleSql('market_id')} AS raw_vol,
                  COUNT(*) AS trade_count
           FROM trades
           WHERE block_timestamp IS NOT NULL
             AND block_timestamp > NOW() - $2::interval
             -- Exclude legacy zero-prefixed system accounts AND the configured
             -- market-maker/taker bot wallets. Bots self-trade for liquidity
             -- and would otherwise dominate the board; real wallets are kept.
             AND taker NOT LIKE '0x00000000000000000000000000000000000000%'
             AND LOWER(taker) <> ALL($4::text[])
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
        [period.name, period.interval, TRADE_USD_SCALE, BOT_ADDRESSES]
      );
      // Purge any previously-stored bot/system rows so the board reflects
      // only real traders going forward.
      await pool.query(
        `DELETE FROM leaderboard
          WHERE period = $1
            AND (
              address LIKE '0x00000000000000000000000000000000000000%'
              OR LOWER(address) = ANY($2::text[])
            )`,
        [period.name, BOT_ADDRESSES]
      );
    } catch (e) {
      console.error(`[leaderboard] Error updating ${period.name}:`, e.message);
    }
  }
}

// Loyalty points from cumulative traded volume — both sides of every fill
// (taker and resting maker each earn the fill's notional). Idempotent: trading_points is
// recomputed from all-time volume each run and upserted, so re-runs never
// double-count. A `points` history row is written only for the positive delta
// since the last run, so the points page shows recent activity.
const POINTS_PER_USD = 1; // 1 point per $1 of notional volume, credited to the taker and to the maker of each fill
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
    // Bot wallets never hold trading points. Zero any that accrued before an
    // address joined the exclusion list (node points, if the wallet also runs a
    // verified node, are real and stay), and drop rows left with nothing.
    await pool.query(
      `UPDATE points_balance
          SET trading_points = 0,
              total_points = COALESCE(node_points, 0) + COALESCE(lp_points, 0) + COALESCE(referral_points, 0) + COALESCE(bonus_points, 0),
              tier = CASE
                WHEN COALESCE(node_points, 0) + COALESCE(lp_points, 0) + COALESCE(referral_points, 0) + COALESCE(bonus_points, 0) >= 1000000 THEN 'Diamond'
                WHEN COALESCE(node_points, 0) + COALESCE(lp_points, 0) + COALESCE(referral_points, 0) + COALESCE(bonus_points, 0) >= 100000 THEN 'Platinum'
                WHEN COALESCE(node_points, 0) + COALESCE(lp_points, 0) + COALESCE(referral_points, 0) + COALESCE(bonus_points, 0) >= 10000 THEN 'Gold'
                WHEN COALESCE(node_points, 0) + COALESCE(lp_points, 0) + COALESCE(referral_points, 0) + COALESCE(bonus_points, 0) >= 1000 THEN 'Silver'
                ELSE 'Bronze' END,
              updated_at = NOW()
        WHERE LOWER(address) = ANY($1::text[]) AND trading_points <> 0`,
      [BOT_ADDRESSES]
    ).catch((e) => console.error('[points] bot purge (balance):', e.message));
    await pool.query(
      `DELETE FROM points WHERE LOWER(address) = ANY($1::text[]) AND point_type = 'trading'`,
      [BOT_ADDRESSES]
    ).catch((e) => console.error('[points] bot purge (history):', e.message));
    await pool.query(
      `DELETE FROM points_balance WHERE LOWER(address) = ANY($1::text[]) AND total_points = 0`,
      [BOT_ADDRESSES]
    ).catch((e) => console.error('[points] bot purge (empty rows):', e.message));
    const vol = await pool.query(
      `SELECT address, SUM(volume)::numeric AS volume
       FROM (
         SELECT LOWER(taker) AS address, price * size / ${priceScaleSql('market_id')} AS volume
           FROM trades WHERE taker IS NOT NULL AND block_timestamp IS NOT NULL
         UNION ALL
         SELECT LOWER(maker) AS address, price * size / ${priceScaleSql('market_id')} AS volume
           FROM trades WHERE maker IS NOT NULL AND block_timestamp IS NOT NULL
       ) sides
       -- Exclude legacy zero-prefixed accounts AND configured bot wallets
       -- so points reflect real traders only, matching the leaderboard.
       WHERE address NOT LIKE '0x00000000000000000000000000000000000000%'
         AND address <> ALL($1::text[])
       GROUP BY address`,
      [BOT_ADDRESSES]
    );
    let updated = 0;
    for (const row of vol.rows) {
      const address = row.address;
      const volumeUsd = Number(row.volume) || 0;
      const trading = Math.floor((volumeUsd * POINTS_PER_USD) / TRADE_USD_SCALE);
      if (trading <= 0) continue;

      const existing = await pool.query(
        `SELECT trading_points, lp_points, referral_points, COALESCE(node_points, 0) AS node_points, COALESCE(bonus_points, 0) AS bonus_points FROM points_balance
         WHERE address = $1 AND season = $2`,
        [address, season]
      ).catch(() => pool.query(   // columns added lazily; tolerate their absence
        `SELECT trading_points, lp_points, referral_points, 0 AS node_points, 0 AS bonus_points FROM points_balance
         WHERE address = $1 AND season = $2`,
        [address, season]
      ));
      const prev = existing.rows[0] || {};
      const prevTrading = Number(prev.trading_points) || 0;
      if (trading <= prevTrading) continue; // no new volume since last run

      const lp = Number(prev.lp_points) || 0;
      const ref = Number(prev.referral_points) || 0;
      const nodePts = Number(prev.node_points) || 0; // awarded by the API for verified node runners
      const bonus = Number(prev.bonus_points) || 0;  // weekly sprint awards (below)
      const total = trading + lp + ref + nodePts + bonus;

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

    await awardReferralPoints(season);
    await awardWeeklySprint(season);
    await normalizeTotals(season);
  } catch (e) {
    console.error('[points] Error awarding:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Referral points: a referrer earns 10 % of each referee's trading points.
// Attribution rows come from the API (POST /api/v1/referrals/attribute, wallet-
// signed, first code wins) into `referrals(referee, referrer, code)`.
// Recomputed from scratch every run so it is idempotent.
// ---------------------------------------------------------------------------
const REFERRAL_SHARE = 0.10;

async function ensurePointsSchema() {
  await pool.query(`ALTER TABLE points_balance ADD COLUMN IF NOT EXISTS bonus_points NUMERIC(20,4) NOT NULL DEFAULT 0`).catch(() => {});
  // Single source of truth for "not a real trader": the API's live standings
  // (weekly sprint) read this table instead of carrying their own bot list.
  await pool.query(`CREATE TABLE IF NOT EXISTS excluded_addresses (address TEXT PRIMARY KEY, reason TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  await pool.query(
    `INSERT INTO excluded_addresses (address, reason) SELECT UNNEST($1::text[]), 'bot' ON CONFLICT (address) DO UPDATE SET updated_at = NOW()`,
    [BOT_ADDRESSES]
  ).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS referrals (
    referee TEXT PRIMARY KEY,
    referrer TEXT NOT NULL,
    code TEXT,
    attributed_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer)`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS weekly_sprint_awards (
    week_start DATE NOT NULL,
    address TEXT NOT NULL,
    rank INTEGER NOT NULL,
    volume NUMERIC(78,4) NOT NULL DEFAULT 0,
    points NUMERIC(20,4) NOT NULL,
    awarded_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (week_start, address)
  )`).catch(() => {});
}

async function awardReferralPoints(season) {
  try {
    const r = await pool.query(
      `SELECT LOWER(r.referrer) AS referrer, COALESCE(SUM(pb.trading_points), 0)::numeric AS referee_trading
         FROM referrals r
         LEFT JOIN points_balance pb ON LOWER(pb.address) = LOWER(r.referee) AND pb.season = $1
        WHERE LOWER(r.referrer) <> LOWER(r.referee)
        GROUP BY LOWER(r.referrer)`,
      [season]
    );
    let changed = 0;
    for (const row of r.rows) {
      const earned = Math.floor(Number(row.referee_trading) * REFERRAL_SHARE);
      const cur = await pool.query(`SELECT referral_points FROM points_balance WHERE address = $1 AND season = $2`, [row.referrer, season]);
      const prev = Number(cur.rows[0]?.referral_points) || 0;
      if (earned === prev) continue;
      await pool.query(
        `INSERT INTO points_balance (address, season, total_points, trading_points, lp_points, referral_points, tier, updated_at)
         VALUES ($1, $2, $3, 0, 0, $3, 'Bronze', NOW())
         ON CONFLICT (address, season) DO UPDATE SET referral_points = EXCLUDED.referral_points, updated_at = NOW()`,
        [row.referrer, season, earned]
      );
      if (earned > prev) {
        await pool.query(`INSERT INTO points (address, season, point_type, amount, reason) VALUES ($1, $2, 'referral', $3, 'Referee trading (10%)')`, [row.referrer, season, earned - prev]).catch(() => {});
      }
      changed++;
    }
    if (changed > 0) console.log(`[points] referral points updated for ${changed} referrer(s)`);
  } catch (e) {
    console.error('[points] referral award:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Weekly sprint: every Monday 00:00 UTC the previous week's top three traders
// by taker volume (real traders only) receive bonus points 3,000 / 2,000 /
// 1,000. One award per (week, address); safe to run every cycle.
// ---------------------------------------------------------------------------
const SPRINT_PRIZES = [3000, 2000, 1000];

function lastCompletedWeekStartUtc(now = new Date()) {
  // Monday 00:00 UTC of the week that just ended.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);   // this week's Monday
  d.setUTCDate(d.getUTCDate() - 7);     // previous Monday
  return d;
}

async function awardWeeklySprint(season) {
  try {
    const weekStart = lastCompletedWeekStartUtc();
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    const iso = weekStart.toISOString().slice(0, 10);
    const done = await pool.query(`SELECT 1 FROM weekly_sprint_awards WHERE week_start = $1 LIMIT 1`, [iso]);
    if (done.rowCount > 0) return;
    const top = await pool.query(
      `SELECT address, SUM(volume)::numeric AS volume
         FROM (
           SELECT LOWER(taker) AS address, price * size / ${priceScaleSql('market_id')} AS volume
             FROM trades WHERE taker IS NOT NULL AND block_timestamp >= $1 AND block_timestamp < $2
           UNION ALL
           SELECT LOWER(maker) AS address, price * size / ${priceScaleSql('market_id')} AS volume
             FROM trades WHERE maker IS NOT NULL AND block_timestamp >= $1 AND block_timestamp < $2
         ) sides
        WHERE address NOT LIKE '0x00000000000000000000000000000000000000%'
          AND address <> ALL($3::text[])
        GROUP BY address
        ORDER BY volume DESC
        LIMIT 3`,
      [weekStart.toISOString(), weekEnd.toISOString(), BOT_ADDRESSES]
    );
    if (top.rowCount === 0) {
      // Nobody traded that week: record a marker row so we do not re-query forever.
      await pool.query(`INSERT INTO weekly_sprint_awards (week_start, address, rank, volume, points) VALUES ($1, 'none', 0, 0, 0) ON CONFLICT DO NOTHING`, [iso]);
      return;
    }
    for (let i = 0; i < top.rows.length; i++) {
      const { address, volume } = top.rows[i];
      const pts = SPRINT_PRIZES[i];
      await pool.query(
        `INSERT INTO weekly_sprint_awards (week_start, address, rank, volume, points) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [iso, address, i + 1, volume, pts]
      );
      await pool.query(
        `INSERT INTO points_balance (address, season, total_points, trading_points, lp_points, referral_points, bonus_points, tier, updated_at)
         VALUES ($1, $2, $3, 0, 0, 0, $3, 'Bronze', NOW())
         ON CONFLICT (address, season) DO UPDATE SET bonus_points = points_balance.bonus_points + $3, updated_at = NOW()`,
        [address, season, pts]
      );
      await pool.query(`INSERT INTO points (address, season, point_type, amount, reason) VALUES ($1, $2, 'competition', $3, $4)`, [address, season, pts, `Weekly sprint #${i + 1}, week of ${iso}`]).catch(() => {});
    }
    console.log(`[points] weekly sprint awarded for week ${iso}: ${top.rows.map((r, i) => `${r.address.slice(0, 8)}=${SPRINT_PRIZES[i]}`).join(', ')}`);
  } catch (e) {
    console.error('[points] weekly sprint:', e.message);
  }
}

/** total = trading + lp + referral + node + bonus, tier from total. One statement, every run. */
async function normalizeTotals(season) {
  await pool.query(
    `UPDATE points_balance
        SET total_points = COALESCE(trading_points,0) + COALESCE(lp_points,0) + COALESCE(referral_points,0) + COALESCE(node_points,0) + COALESCE(bonus_points,0),
            tier = CASE
              WHEN COALESCE(trading_points,0) + COALESCE(lp_points,0) + COALESCE(referral_points,0) + COALESCE(node_points,0) + COALESCE(bonus_points,0) >= 1000000 THEN 'Diamond'
              WHEN COALESCE(trading_points,0) + COALESCE(lp_points,0) + COALESCE(referral_points,0) + COALESCE(node_points,0) + COALESCE(bonus_points,0) >= 100000 THEN 'Platinum'
              WHEN COALESCE(trading_points,0) + COALESCE(lp_points,0) + COALESCE(referral_points,0) + COALESCE(node_points,0) + COALESCE(bonus_points,0) >= 10000 THEN 'Gold'
              WHEN COALESCE(trading_points,0) + COALESCE(lp_points,0) + COALESCE(referral_points,0) + COALESCE(node_points,0) + COALESCE(bonus_points,0) >= 1000 THEN 'Silver'
              ELSE 'Bronze' END
      WHERE season = $1
        AND total_points <> COALESCE(trading_points,0) + COALESCE(lp_points,0) + COALESCE(referral_points,0) + COALESCE(node_points,0) + COALESCE(bonus_points,0)`,
    [season]
  ).catch((e) => console.error('[points] normalize:', e.message));
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
      // Require the shared secret when one is configured — this endpoint writes
      // directly into trades/leaderboard, so an open one lets anything forge
      // volume/PnL. (Empty secret = disabled, for local dev only.)
      if (REPORT_SECRET && req.headers['x-report-secret'] !== REPORT_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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

// ---------------------------------------------------------------------------
// Launch metrics: one row per UTC day with cumulative network counters read
// once per run (faucet transactions = the faucet wallet's nonce; verified
// nodes; active validators; block height). The API turns consecutive rows
// into per-day deltas and joins them with human-vs-bot trading from `trades`.
// Cheap (three RPC calls + one SELECT), idempotent, so it runs every 5 minutes.
// ---------------------------------------------------------------------------
const FAUCET_ADDRESS = (process.env.FAUCET_ADDRESS || '0xecef1bb56f77fad9ed34b2fb4300393ace974ee6').toLowerCase();
async function ensureDailyMetricsSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_metrics (
    day DATE PRIMARY KEY,
    faucet_txs BIGINT,
    verified_nodes INT,
    validators INT,
    block_height BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
async function snapshotDailyMetrics() {
  try {
    const [nonceHex, heightHex, vset, nodes] = await Promise.all([
      rpc('eth_getTransactionCount', [FAUCET_ADDRESS, 'latest']).catch(() => null),
      rpc('eth_blockNumber', []).catch(() => null),
      rpc('mersennet_validatorSet', []).catch(() => null),
      pool.query('SELECT COUNT(*)::int AS n FROM verified_nodes WHERE consecutive_failures < 3').then((r) => r.rows[0].n).catch(() => null),
    ]);
    const validators = vset && Array.isArray(vset.activeSet) ? vset.activeSet.length : null;
    await pool.query(`
      INSERT INTO daily_metrics (day, faucet_txs, verified_nodes, validators, block_height, updated_at)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, NOW())
      ON CONFLICT (day) DO UPDATE SET
        faucet_txs = COALESCE(EXCLUDED.faucet_txs, daily_metrics.faucet_txs),
        verified_nodes = COALESCE(EXCLUDED.verified_nodes, daily_metrics.verified_nodes),
        validators = COALESCE(EXCLUDED.validators, daily_metrics.validators),
        block_height = COALESCE(EXCLUDED.block_height, daily_metrics.block_height),
        updated_at = NOW()
    `, [nonceHex ? Number(BigInt(nonceHex)) : null, nodes, validators, heightHex ? Number(BigInt(heightHex)) : null]);
  } catch (e) {
    console.error('[metrics] daily snapshot failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// MakerVault index. Deposit/Withdraw events of the on-chain vault are tailed
// into `vault_deposits` (one row per event, MRSN + shares in human units) and
// `vault_state` mirrors the contract (NAV, shares, depositors, share-price
// derived PnL/APY). LP points accrue to depositors pro-rata to the MRSN value
// of their shares: LP_POINTS_PER_MRSN_DAY per MRSN per day, credited every run.
// ---------------------------------------------------------------------------
const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || '0xe77F94c4Bf7D6d2E2371aFdE440a0b9b8a567725').toLowerCase();
const VAULT_DEPLOY_BLOCK = Number(process.env.VAULT_DEPLOY_BLOCK || 1505525);
const LP_POINTS_PER_MRSN_DAY = Number(process.env.LP_POINTS_PER_MRSN_DAY || 0.1); // 1,000 MRSN parked for a day = 100 pts
// keccak topics / selectors precomputed (cast keccak / cast sig) — no ABI lib needed:
// the event data is three plain uint256 words.
const VAULT_TOPICS = {
  deposit: '0x36af321ec8d3c75236829c5317affd40ddb308863a1236d2d277a4025cccee1e',  // Deposit(address,uint256,uint256,uint256)
  withdraw: '0x02f25270a4d87bea75db541cdfe559334a275b4a233520ed6c0a2429667cca94', // Withdraw(address,uint256,uint256,uint256)
};
const VAULT_SELECTORS = { 'nav()': '0xc1590cd7', 'totalShares()': '0x3a98ef39', 'depositors()': '0xaaa46688' };
const abi = { decode: (_types, data) => { const h = data.slice(2); const w = []; for (let i = 0; i + 64 <= h.length; i += 64) w.push(BigInt('0x' + h.slice(i, i + 64))); return w; } };
const WEI = 1e18;

async function ensureVaultSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS vault_index_state (id SMALLINT PRIMARY KEY DEFAULT 1, last_block BIGINT NOT NULL DEFAULT 0, lp_points_at TIMESTAMPTZ)`);
  await pool.query(`ALTER TABLE vault_deposits ADD COLUMN IF NOT EXISTS tx_hash TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE vault_deposits ADD COLUMN IF NOT EXISTS block_number BIGINT`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_vault_deposits_tx ON vault_deposits (tx_hash, address, action) WHERE tx_hash IS NOT NULL`).catch(() => {});
  await pool.query(`INSERT INTO vault_index_state (id, last_block) VALUES (1, $1) ON CONFLICT DO NOTHING`, [VAULT_DEPLOY_BLOCK]);
}

async function vaultCall(sig) {
  const selector = VAULT_SELECTORS[sig];
  if (!selector) throw new Error(`no selector for ${sig}`);
  const r = await rpc('eth_call', [{ to: VAULT_ADDRESS, data: selector }, 'latest']);
  return BigInt(r && r !== '0x' ? r : '0x0');
}

async function indexVault() {
  try {
    const st = await pool.query('SELECT last_block FROM vault_index_state WHERE id = 1');
    let from = Number(st.rows[0]?.last_block || VAULT_DEPLOY_BLOCK) + 1;
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    // Chunked so a long gap after downtime cannot blow the RPC's log limit.
    while (from <= head) {
      const to = Math.min(head, from + 4999);
      const logs = await rpc('eth_getLogs', [{ address: VAULT_ADDRESS, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [[VAULT_TOPICS.deposit, VAULT_TOPICS.withdraw]] }]).catch(() => []);
      for (const lg of logs || []) {
        const isDeposit = (lg.topics[0] || '').toLowerCase() === VAULT_TOPICS.deposit;
        const account = ('0x' + lg.topics[1].slice(26)).toLowerCase();
        const [a, b, navAfter] = abi.decode(['uint256', 'uint256', 'uint256'], lg.data);
        // Deposit(account, amount, shares, navAfter) · Withdraw(account, shares, amount, navAfter)
        const amount = Number(isDeposit ? a : b) / WEI;
        const shares = Number(isDeposit ? b : a) / WEI;
        await pool.query(
          `INSERT INTO vault_deposits (address, action, amount, shares, vault_tvl_after, tx_hash, block_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [account, isDeposit ? 'deposit' : 'withdraw', amount, shares, Number(navAfter) / WEI, lg.transactionHash, Number(BigInt(lg.blockNumber))]
        );
      }
      await pool.query('UPDATE vault_index_state SET last_block = $1 WHERE id = 1', [to]);
      from = to + 1;
    }
    // Mirror the contract: NAV, shares, depositors; PnL = NAV − net deposits.
    const [nav, shares, depositors] = await Promise.all([vaultCall('nav()'), vaultCall('totalShares()'), vaultCall('depositors()')]);
    const net = await pool.query(`SELECT COALESCE(SUM(CASE WHEN action = 'deposit' THEN amount ELSE -amount END), 0)::float8 AS net FROM vault_deposits WHERE tx_hash IS NOT NULL`);
    const navH = Number(nav) / WEI;
    const pnl = navH - Number(net.rows[0].net || 0);
    // 7d / 30d APY from the share price trajectory (first event in the window vs now).
    const apy = async (days) => {
      const r = await pool.query(`SELECT shares, amount FROM vault_deposits WHERE tx_hash IS NOT NULL AND created_at <= NOW() - ($1 || ' days')::interval AND shares > 0 ORDER BY created_at DESC LIMIT 1`, [String(days)]);
      if (!r.rows[0] || Number(shares) === 0) return 0;
      const oldPx = Number(r.rows[0].amount) / Number(r.rows[0].shares);
      const nowPx = navH / (Number(shares) / WEI);
      return oldPx > 0 ? ((nowPx / oldPx) ** (365 / days) - 1) * 100 : 0;
    };
    await pool.query(
      `INSERT INTO vault_state (id, total_shares, total_tvl, total_pnl, apy_7d, apy_30d, depositors, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET total_shares = $1, total_tvl = $2, total_pnl = $3, apy_7d = $4, apy_30d = $5, depositors = $6, updated_at = NOW()`,
      [Number(shares) / WEI, navH, pnl, await apy(7), await apy(30), Number(depositors)]
    );
    await awardLpPoints(navH, Number(shares) / WEI);
  } catch (e) {
    console.error('[vault] index failed:', e.message);
  }
}

async function awardLpPoints(navH, totalShares) {
  if (totalShares <= 0 || navH <= 0) { await pool.query('UPDATE vault_index_state SET lp_points_at = NOW() WHERE id = 1'); return; }
  const st = await pool.query('SELECT lp_points_at FROM vault_index_state WHERE id = 1');
  const last = st.rows[0]?.lp_points_at ? new Date(st.rows[0].lp_points_at).getTime() : Date.now();
  const days = Math.max(0, (Date.now() - last) / 86_400_000);
  await pool.query('UPDATE vault_index_state SET lp_points_at = NOW() WHERE id = 1');
  if (days <= 0) return;
  const pricePerShare = navH / totalShares;
  const holders = await pool.query(`SELECT address, SUM(CASE WHEN action = 'deposit' THEN shares ELSE -shares END)::float8 AS shares FROM vault_deposits WHERE tx_hash IS NOT NULL GROUP BY address HAVING SUM(CASE WHEN action = 'deposit' THEN shares ELSE -shares END) > 0`);
  const season = await pool.query('SELECT COALESCE(MAX(season), 1) AS s FROM points_balance').then((r) => Number(r.rows[0].s) || 1).catch(() => 1);
  for (const h of holders.rows) {
    const pts = Number(h.shares) * pricePerShare * LP_POINTS_PER_MRSN_DAY * days;
    if (pts <= 0) continue;
    await pool.query(
      `INSERT INTO points_balance (address, season, trading_points, lp_points, referral_points, total_points, tier)
       VALUES ($1, $2, 0, $3, 0, $3, 'Bronze')
       ON CONFLICT (address, season) DO UPDATE SET lp_points = points_balance.lp_points + $3`,
      [h.address, season, pts]
    ).catch((e) => console.error('[vault] lp points:', e.message));
  }
  await normalizeTotals(season);
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
  
  await ensurePriceScaleSchema().catch((e) => console.error('[scale] schema:', e.message));
  await syncPriceScales();
  setInterval(syncPriceScales, 15_000);

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
  ensurePointsSchema().then(() => awardPoints());
  ensureDailyMetricsSchema().then(() => snapshotDailyMetrics()).catch((e) => console.error('[metrics] schema:', e.message));
  setInterval(snapshotDailyMetrics, 300_000);
  ensureVaultSchema().then(() => indexVault()).catch((e) => console.error('[vault] schema:', e.message));
  setInterval(indexVault, 60_000);

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
