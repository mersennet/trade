/**
 * Adoption metrics — one set of numbers for the public /stats page, the ops
 * digest and any internal view, so they can never disagree.
 *
 * Sources: the trade database (trades, vault, points, referrals, nodes, the
 * bot allowlist), the explorer's transaction index (every tx since genesis:
 * wallets funded by the faucet, active senders, contracts), the chain itself
 * (validator set, protocol, order-book accounts for TVL) and two outside
 * counters (Telegram members, GitHub stars). Everything here is aggregate;
 * addresses appear only in the internal section, behind the admin key.
 *
 * Honesty rules: bots (market maker, takers, liquidator) are excluded from
 * "wallets" and "traders" wherever the source can tell them apart, and the
 * bot share is reported next to the human figure rather than hidden.
 */
const pool = require('../db/pool');
const explorer = require('../db/explorerPool');
const chain = require('./chain');
const { compute: launchSeries } = require('../routes/launch');

const FAUCET = (process.env.FAUCET_ADDRESS || '0xecef1bb56f77fad9ed34b2fb4300393ace974ee6').toLowerCase();
const TELEGRAM_PUBLIC_CHAT = process.env.TELEGRAM_PUBLIC_CHAT || '@Mersennet';
const GITHUB_ORG = process.env.GITHUB_ORG || 'mersennet';
const STATUS_PAGE = process.env.STATUS_PAGE_HEARTBEAT || 'https://status.mersennet.com/api/status-page/heartbeat/mersennet';

const FAST_TTL = 5 * 60_000;   // most numbers
const SLOW_TTL = 60 * 60_000;  // full-table scans and outside counters
const fast = { at: 0, body: null, inflight: null };
const slow = { at: 0, body: null, inflight: null };

const num = (v) => (v == null ? null : Number(v));
const wei = (v) => { try { return Number(BigInt(v)) / 1e18; } catch { return 0; } };

async function fetchJson(url, opts = {}, timeoutMs = 6000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- slow set

/** Hourly: whole-history scans and third-party counters. */
async function computeSlow() {
  const [senders, funded, contracts, txTotal, telegram, github] = await Promise.all([
    explorer.query('SELECT COUNT(DISTINCT from_addr)::int AS n FROM transactions').then((r) => r.rows[0].n).catch(() => null),
    explorer.query('SELECT COUNT(DISTINCT to_addr)::int AS n FROM transactions WHERE from_addr = $1', [FAUCET]).then((r) => r.rows[0].n).catch(() => null),
    explorer.query("SELECT COUNT(*)::int AS n FROM transactions WHERE contract_address IS NOT NULL AND contract_address <> ''").then((r) => r.rows[0].n).catch(() => null),
    explorer.query('SELECT COUNT(*)::bigint AS n FROM transactions').then((r) => Number(r.rows[0].n)).catch(() => null),
    (async () => {
      const token = process.env.FEEDBACK_TELEGRAM_BOT_TOKEN;
      if (!token) return null;
      const j = await fetchJson(`https://api.telegram.org/bot${token}/getChatMemberCount?chat_id=${encodeURIComponent(TELEGRAM_PUBLIC_CHAT)}`);
      return j.ok ? Number(j.result) : null;
    })().catch(() => null),
    fetchJson(`https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=100`, { headers: { 'User-Agent': 'mersennet-trade-api', Accept: 'application/vnd.github+json' } })
      .then((repos) => ({ repos: repos.length, stars: repos.reduce((s, r) => s + (r.stargazers_count || 0), 0), forks: repos.reduce((s, r) => s + (r.forks_count || 0), 0) }))
      .catch(() => null),
  ]);
  return { sendersTotal: senders, fundedWalletsTotal: funded, contractsDeployed: contracts, txTotal, telegramMembers: telegram, github };
}

/**
 * A copy past its TTL is still served while its refresh runs in the
 * background; only the very first computation is awaited. The slow set's
 * scans take ~12 s, and no visitor should ever wait for them.
 */
function staleWhileRefreshing(state, ttl, refresh, label) {
  if (state.body && Date.now() - state.at < ttl) return Promise.resolve(state.body);
  const pending = refresh();
  if (!state.body) return pending;
  pending.catch((e) => console.warn(`[adoption] ${label} refresh failed:`, e.message));
  return Promise.resolve(state.body);
}

function refreshSlow() {
  if (!slow.inflight) {
    slow.inflight = computeSlow()
      .then((body) => { slow.at = Date.now(); slow.body = body; return body; })
      .finally(() => { slow.inflight = null; });
  }
  return slow.inflight;
}

function slowCached() {
  return staleWhileRefreshing(slow, SLOW_TTL, refreshSlow, 'slow set');
}

// ---------------------------------------------------------------- fast set

/** Order-book collateral held by every address we know about, as the chain counts it. */
async function orderBookTvl(addresses) {
  if (!addresses.length) return { collateralMrsn: 0, accounts: 0 };
  const assets = await chain.getCollateralAssets().catch(() => []);
  const batch = addresses.map((a, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'mersennet_orders_getAccount', params: [a] }));
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  let results = [];
  try {
    const r = await fetch(process.env.RPC_URL || 'https://rpc.mersennet.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch), signal: c.signal,
    });
    results = await r.json();
  } finally { clearTimeout(t); }
  let units = 0n; let accounts = 0;
  for (const res of Array.isArray(results) ? results : []) {
    const acct = res && res.result; if (!acct) continue;
    let mine = 0n;
    try { mine += BigInt(acct.collateral || 0); } catch { /* skip */ }
    for (const tc of acct.tokenCollateral || []) {
      const asset = assets.find((x) => x.token === String(tc.token).toLowerCase());
      if (!asset) continue;
      try { mine += (BigInt(tc.amount) * asset.valueNum / asset.valueDen) * BigInt(asset.weightBps) / 10_000n; } catch { /* skip */ }
    }
    if (mine > 0n) accounts++;
    units += mine;
  }
  return { collateralMrsn: chain.unitsToMrsn(units), accounts };
}

async function computeFast() {
  const [
    tradeTotals, activity, tradeAddrs, vault, nodes, validatorSet, protocol, explorerActive, fundedDaily, uptime, series, slowPart,
  ] = await Promise.all([
    pool.query(`
      WITH bots AS (SELECT address FROM excluded_addresses),
      t AS (SELECT t.*, (t.taker IN (SELECT address FROM bots) AND t.maker IN (SELECT address FROM bots)) AS bot,
                   (t.price * t.size / ${chain.priceScaleSql('t.market_id')})::float8 AS notional
            FROM trades t)
      SELECT
        COUNT(*)::int AS trades_total,
        COUNT(*) FILTER (WHERE NOT bot)::int AS human_trades_total,
        COALESCE(SUM(notional), 0)::float8 AS volume_total,
        COALESCE(SUM(notional) FILTER (WHERE NOT bot), 0)::float8 AS human_volume_total,
        COUNT(*) FILTER (WHERE block_timestamp > now() - interval '24 hours')::int AS trades_24h,
        COUNT(*) FILTER (WHERE NOT bot AND block_timestamp > now() - interval '24 hours')::int AS human_trades_24h,
        COALESCE(SUM(notional) FILTER (WHERE block_timestamp > now() - interval '24 hours'), 0)::float8 AS volume_24h,
        COALESCE(SUM(notional) FILTER (WHERE NOT bot AND block_timestamp > now() - interval '24 hours'), 0)::float8 AS human_volume_24h,
        COUNT(*) FILTER (WHERE block_timestamp > now() - interval '7 days')::int AS trades_7d,
        COUNT(*) FILTER (WHERE NOT bot AND block_timestamp > now() - interval '7 days')::int AS human_trades_7d,
        COALESCE(SUM(notional) FILTER (WHERE block_timestamp > now() - interval '7 days'), 0)::float8 AS volume_7d,
        COALESCE(SUM(notional) FILTER (WHERE NOT bot AND block_timestamp > now() - interval '7 days'), 0)::float8 AS human_volume_7d
      FROM t`).then((r) => r.rows[0]),
    pool.query(`
      WITH bots AS (SELECT address FROM excluded_addresses),
      w AS (SELECT taker AS a, block_timestamp AS at FROM trades UNION ALL SELECT maker, block_timestamp FROM trades)
      SELECT
        COUNT(DISTINCT a) FILTER (WHERE a NOT IN (SELECT address FROM bots))::int AS human_traders_total,
        COUNT(DISTINCT a) FILTER (WHERE a IN (SELECT address FROM bots))::int AS bot_traders_total,
        COUNT(DISTINCT a) FILTER (WHERE a NOT IN (SELECT address FROM bots) AND at > now() - interval '24 hours')::int AS human_traders_24h,
        COUNT(DISTINCT a) FILTER (WHERE a NOT IN (SELECT address FROM bots) AND at > now() - interval '7 days')::int AS human_traders_7d,
        COUNT(DISTINCT a) FILTER (WHERE a NOT IN (SELECT address FROM bots) AND at > now() - interval '30 days')::int AS human_traders_30d
      FROM w`).then((r) => r.rows[0]),
    pool.query(`
      SELECT DISTINCT a FROM (
        SELECT taker AS a FROM trades UNION SELECT maker FROM trades
        UNION SELECT address FROM vault_deposits UNION SELECT address FROM points_balance
        UNION SELECT operator FROM verified_nodes
      ) x WHERE a ~ '^0x[0-9a-fA-F]{40}$'`).then((r) => r.rows.map((x) => x.a.toLowerCase())).catch(() => []),
    pool.query('SELECT total_tvl, total_shares, depositors, updated_at FROM vault_state ORDER BY id DESC LIMIT 1').then((r) => r.rows[0] || null).catch(() => null),
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE consecutive_failures < 3 AND last_seen_at > now() - interval '1 hour')::int AS online,
             COUNT(DISTINCT operator)::int AS operators
      FROM verified_nodes`).then((r) => r.rows[0]).catch(() => ({})),
    chain.rpcCall('mersennet_validatorSet', []).catch(() => null),
    chain.getProtocol().catch(() => null),
    explorer.query(`
      SELECT
        COUNT(*) FILTER (WHERE timestamp > extract(epoch FROM now() - interval '24 hours'))::int AS tx_24h,
        COUNT(DISTINCT from_addr) FILTER (WHERE timestamp > extract(epoch FROM now() - interval '24 hours'))::int AS senders_24h,
        COUNT(DISTINCT from_addr) FILTER (WHERE timestamp > extract(epoch FROM now() - interval '7 days'))::int AS senders_7d,
        COUNT(DISTINCT from_addr) FILTER (WHERE timestamp > extract(epoch FROM now() - interval '30 days'))::int AS senders_30d
      FROM transactions WHERE timestamp > extract(epoch FROM now() - interval '30 days')`).then((r) => r.rows[0]).catch(() => ({})),
    explorer.query(`
      SELECT to_char(to_timestamp(timestamp)::date, 'YYYY-MM-DD') AS day, COUNT(DISTINCT to_addr)::int AS wallets
      FROM transactions WHERE from_addr = $1 AND timestamp > extract(epoch FROM now() - interval '30 days')
      GROUP BY 1 ORDER BY 1`, [FAUCET]).then((r) => r.rows).catch(() => []),
    fetchJson(STATUS_PAGE).then((j) => {
      const u = j.uptimeList || {};
      const day = Object.entries(u).filter(([k]) => k.endsWith('_24')).map(([, v]) => Number(v));
      const month = Object.entries(u).filter(([k]) => k.endsWith('_720')).map(([, v]) => Number(v));
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
      return { monitors: day.length, avg24h: avg(day), avg30d: avg(month) };
    }).catch(() => null),
    launchSeries(30).catch(() => ({ days: [] })),
    slowCached().catch(() => ({})),
  ]);

  // Chain: validators and stake.
  let validators = null;
  if (validatorSet && Array.isArray(validatorSet.validators)) {
    const vs = validatorSet.validators;
    const stake = vs.reduce((s, v) => s + wei(v.selfStake) + wei(v.delegated), 0);
    validators = {
      registered: vs.length,
      active: Array.isArray(validatorSet.activeSet) ? validatorSet.activeSet.length : null,
      community: vs.filter((v) => !v.genesis).length,
      jailed: vs.filter((v) => v.status && /jail/i.test(String(v.status))).length,
      networkStakeMrsn: stake,
      delegatedMrsn: vs.reduce((s, v) => s + wei(v.delegated), 0),
      epoch: num(validatorSet.epoch),
      height: num(validatorSet.height),
    };
  }

  const tvlBook = await orderBookTvl(tradeAddrs).catch(() => ({ collateralMrsn: null, accounts: null }));
  const vaultNav = vault ? Number(vault.total_tvl) : null;
  const staked = validators ? validators.networkStakeMrsn : null;

  const bt = await chain.observedBlockTime().catch(() => null); // seconds per block

  return {
    generatedAt: new Date().toISOString(),
    note: 'Aggregates only. "Human" excludes the network\u2019s own market-making, taker and liquidation bots; MRSN on the testnet has no monetary value.',
    wallets: {
      fundedByFaucet: slowPart.fundedWalletsTotal ?? null,       // unique wallets that ever received a drip
      sendersTotal: slowPart.sendersTotal ?? null,               // unique addresses that ever sent a transaction (bots included)
      activeSenders24h: num(explorerActive.senders_24h),
      activeSenders7d: num(explorerActive.senders_7d),
      activeSenders30d: num(explorerActive.senders_30d),
      humanTradersTotal: num(activity.human_traders_total),
      humanTraders24h: num(activity.human_traders_24h),
      humanTraders7d: num(activity.human_traders_7d),
      humanTraders30d: num(activity.human_traders_30d),
      botWallets: num(activity.bot_traders_total),
      vaultDepositors: vault ? num(vault.depositors) : null,
      pointsHolders: null, // filled below
      referrals: null,
      fundedPerDay: fundedDaily.map((r) => ({ day: r.day, wallets: r.wallets })),
    },
    trading: {
      trades24h: num(tradeTotals.trades_24h), humanTrades24h: num(tradeTotals.human_trades_24h),
      volume24h: num(tradeTotals.volume_24h), humanVolume24h: num(tradeTotals.human_volume_24h),
      trades7d: num(tradeTotals.trades_7d), humanTrades7d: num(tradeTotals.human_trades_7d),
      volume7d: num(tradeTotals.volume_7d), humanVolume7d: num(tradeTotals.human_volume_7d),
      tradesTotal: num(tradeTotals.trades_total), humanTradesTotal: num(tradeTotals.human_trades_total),
      volumeTotal: num(tradeTotals.volume_total), humanVolumeTotal: num(tradeTotals.human_volume_total),
      markets: protocol && Array.isArray(protocol.markets) ? protocol.markets.length : null,
    },
    tvl: {
      orderBookCollateralMrsn: tvlBook.collateralMrsn,
      orderBookAccounts: tvlBook.accounts,
      makerVaultNavMrsn: vaultNav,
      stakedMrsn: staked,
      totalMrsn: [tvlBook.collateralMrsn, vaultNav, staked].every((x) => typeof x === 'number') ? tvlBook.collateralMrsn + vaultNav + staked : null,
    },
    network: {
      height: validators ? validators.height : (protocol ? num(protocol.height) : null),
      blockTimeSec: typeof bt === 'number' ? bt : null,
      tx24h: num(explorerActive.tx_24h),
      txTotal: slowPart.txTotal ?? null,
      contractsDeployed: slowPart.contractsDeployed ?? null,
      validators,
      verifiedNodes: num(nodes.total), verifiedNodesOnline: num(nodes.online), nodeOperators: num(nodes.operators),
      uptime,
    },
    community: {
      telegramMembers: slowPart.telegramMembers ?? null,
      github: slowPart.github ?? null,
    },
    daily: series.days || [],
  };
}

function refreshFast() {
  if (!fast.inflight) {
    fast.inflight = (async () => {
      const body = await computeFast();
      // Two small counts that live in the trade DB; kept here so the shape above stays readable.
      try {
        const r = await pool.query(`
          WITH bots AS (SELECT address FROM excluded_addresses)
          SELECT (SELECT COUNT(*) FROM points_balance WHERE total_points > 0 AND address NOT IN (SELECT address FROM bots))::int AS points_holders,
                 (SELECT COUNT(*) FROM referrals)::int AS referrals`);
        body.wallets.pointsHolders = num(r.rows[0].points_holders);
        body.wallets.referrals = num(r.rows[0].referrals);
      } catch { /* leave null */ }
      return body;
    })()
      .then((body) => { fast.at = Date.now(); fast.body = body; return body; })
      .finally(() => { fast.inflight = null; });
  }
  return fast.inflight;
}

function getAdoption() {
  return staleWhileRefreshing(fast, FAST_TTL, refreshFast, 'fast set');
}

/** Internal extras (admin key): the addresses behind the aggregates, node hosts, faucet concentration. */
async function getInternal() {
  const [topTraders, topFunded, nodes, faucetTop] = await Promise.all([
    pool.query(`
      WITH bots AS (SELECT address FROM excluded_addresses)
      SELECT taker AS address, COUNT(*)::int AS trades, MAX(block_timestamp) AS last_trade
      FROM trades WHERE taker NOT IN (SELECT address FROM bots) GROUP BY taker ORDER BY trades DESC LIMIT 25`).then((r) => r.rows).catch(() => []),
    explorer.query(`
      SELECT to_addr AS address, COUNT(*)::int AS drips, MAX(to_timestamp(timestamp)) AS last_drip
      FROM transactions WHERE from_addr = $1 GROUP BY to_addr ORDER BY drips DESC LIMIT 25`, [FAUCET]).then((r) => r.rows).catch(() => []),
    pool.query('SELECT identity, operator, host, version, height, last_seen_at, consecutive_failures FROM verified_nodes ORDER BY last_seen_at DESC').then((r) => r.rows).catch(() => []),
    explorer.query(`
      SELECT COUNT(*)::int AS drips_7d, COUNT(DISTINCT to_addr)::int AS wallets_7d
      FROM transactions WHERE from_addr = $1 AND timestamp > extract(epoch FROM now() - interval '7 days')`, [FAUCET]).then((r) => r.rows[0]).catch(() => ({})),
  ]);
  return { topTraders, topFunded, nodes, faucet7d: faucetTop };
}

module.exports = { getAdoption, getInternal };

// Keep the cache warm: the first computation scans the whole transaction
// index (~12 s); visitors should only ever hit the cached copy. The timer
// refreshes unconditionally: its period is shorter than the TTL, so a TTL
// check would skip every other tick. Skipped without a database (CI
// module-load checks, unit tests).
if (process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
  const warm = () => refreshFast().catch((e) => console.warn('[adoption] warm-up failed:', e.message));
  setTimeout(warm, 8_000).unref();
  setInterval(warm, FAST_TTL - 30_000).unref();
}
