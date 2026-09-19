/**
 * Telegram alerts for validator operators and traders.
 *
 * Linking: the terminal asks the wallet to sign
 *   "Mersennet alerts · link Telegram to <address> · <kind> · <minute>"
 * the API verifies the signature, mints a short code and hands back
 * https://t.me/<bot>?start=<code>. The bot poller turns the /start into a
 * (chat_id, address) row. No address is ever typed into Telegram.
 *
 * Engine (primary only, every 60 s):
 *   operators  benched · missed slots with none proposed · jailed · status
 *              change · node behind the head · node silent · outdated build
 *              (+ 24 h / 6 h / 1 h before every protocol switch)
 *   traders    equity within 1.6× of maintenance margin, or below it (the
 *              keeper liquidates) — only once settlement is active
 * Every alert is de-duplicated through alert_state so a stuck condition
 * pages once per window, not once per minute.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const pool = require('../db/pool');
const chain = require('./chain');

const TOKEN = process.env.ALERTS_TELEGRAM_BOT_TOKEN || process.env.FEEDBACK_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${TOKEN}`;
const LINK_TTL_MS = 15 * 60_000;
const TICK_MS = 60_000;
const HOUR = 3_600_000;
let botUsername = null;

// ─── schema ────────────────────────────────────────────────────────────────
async function initTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS alert_links (
    chat_id BIGINT NOT NULL,
    address TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'operator',
    username TEXT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, address)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS alert_link_codes (
    code TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'operator',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS alert_state (
    address TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (address, key)
  )`);
}

// ─── telegram ──────────────────────────────────────────────────────────────
async function tg(method, body) {
  if (!TOKEN) throw new Error('alerts: no bot token');
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
async function send(chatId, html) {
  try {
    await tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    // 403 = the user blocked the bot: forget the link so we stop trying.
    if (/bot was blocked|chat not found|user is deactivated/i.test(e.message)) {
      await pool.query('DELETE FROM alert_links WHERE chat_id = $1', [chatId]).catch(() => {});
    } else console.error('[alerts]', e.message);
    return false;
  }
}
async function botName() {
  if (botUsername) return botUsername;
  try { botUsername = (await tg('getMe')).username; } catch { botUsername = process.env.ALERTS_BOT_USERNAME || 'mersennet_alerts_bot'; }
  return botUsername;
}

// ─── linking ───────────────────────────────────────────────────────────────
const KINDS = new Set(['operator', 'trader']);
function linkMessage(address, kind, minute) {
  return `Mersennet alerts · link Telegram to ${address.toLowerCase()} · ${kind} · ${minute}`;
}
/** Minute buckets accepted for a signature: now and the previous 10 minutes. */
function recentMinutes() {
  const out = [];
  for (let i = 0; i <= 10; i++) out.push(new Date(Date.now() - i * 60_000).toISOString().slice(0, 16) + 'Z');
  return out;
}
function verifyLinkSignature(address, kind, signature) {
  for (const m of recentMinutes()) {
    try {
      if (ethers.verifyMessage(linkMessage(address, kind, m), signature).toLowerCase() === address.toLowerCase()) return true;
    } catch { /* try the next minute */ }
  }
  return false;
}
async function createLinkCode(address, kind) {
  const code = crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8);
  await pool.query('INSERT INTO alert_link_codes (code, address, kind) VALUES ($1, $2, $3)', [code, address.toLowerCase(), kind]);
  return { code, deepLink: `https://t.me/${await botName()}?start=${code}` };
}
async function linksFor(address) {
  const r = await pool.query('SELECT chat_id, kind, username, linked_at FROM alert_links WHERE address = $1 ORDER BY linked_at', [address.toLowerCase()]);
  return r.rows;
}
async function unlinkAddress(address) {
  await pool.query('DELETE FROM alert_links WHERE address = $1', [address.toLowerCase()]);
}

// ─── bot poller (/start <code>, /status, /stop) ────────────────────────────
let offset = 0;
async function pollOnce() {
  const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
  for (const u of updates) {
    offset = u.update_id + 1;
    const msg = u.message;
    if (!msg || !msg.text || !msg.chat) continue;
    const chatId = msg.chat.id;
    const username = msg.from && msg.from.username ? msg.from.username : null;
    const [cmd, arg] = msg.text.trim().split(/\s+/);
    try {
      if (cmd === '/start' && arg) {
        const r = await pool.query(
          `UPDATE alert_link_codes SET used_at = NOW() WHERE code = $1 AND used_at IS NULL AND created_at > NOW() - INTERVAL '15 minutes' RETURNING address, kind`,
          [arg]);
        if (!r.rows[0]) { await send(chatId, 'That link has expired or was already used. Open the terminal again and press <b>Telegram alerts</b> for a fresh one.'); continue; }
        const { address, kind } = r.rows[0];
        await pool.query(
          `INSERT INTO alert_links (chat_id, address, kind, username) VALUES ($1, $2, $3, $4)
           ON CONFLICT (chat_id, address) DO UPDATE SET kind = EXCLUDED.kind, username = EXCLUDED.username, linked_at = NOW()`,
          [chatId, address, kind, username]);
        await send(chatId, `Linked to <code>${short(address)}</code> (${kind}). You will hear from me when ${kind === 'operator'
          ? 'your validator misses slots, is benched or jailed, falls behind the chain, goes silent, runs an outdated build, or a protocol switch is 24 h / 6 h / 1 h away'
          : 'a position gets within reach of liquidation (equity under 1.6× maintenance margin) or is liquidatable'}.\n\n/status — where things stand now\n/stop — unlink everything`);
        await send(chatId, await statusText(chatId));
      } else if (cmd === '/status') {
        await send(chatId, await statusText(chatId));
      } else if (cmd === '/stop') {
        await pool.query('DELETE FROM alert_links WHERE chat_id = $1', [chatId]);
        await send(chatId, 'Unlinked. Nothing more will be sent here; relink any time from the terminal.');
      } else if (cmd === '/start') {
        await send(chatId, `This bot sends Mersennet validator and position alerts. Link it from <a href="https://trade.mersennet.com/staking">trade.mersennet.com/staking</a> (operators) or the account panel on <a href="https://trade.mersennet.com/trade">/trade</a> (traders) — press <b>Telegram alerts</b> there.`);
      } else {
        await send(chatId, '/status — current state of your linked addresses\n/stop — unlink');
      }
    } catch (e) { console.error('[alerts] update:', e.message); }
  }
}
async function pollLoop() {
  for (;;) {
    try { await pollOnce(); }
    catch (e) { console.error('[alerts] poll:', e.message); await sleep(5000); }
  }
}

// ─── data ──────────────────────────────────────────────────────────────────
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const wei = (x) => (typeof x === 'string' && x.startsWith('0x') ? BigInt(x) : BigInt(x || 0));
const mrsn = (x) => Number(wei(x) / 10n ** 14n) / 10_000;

async function snapshot() {
  const [vset, head, protocol] = await Promise.all([
    chain.rpcCall('mersennet_validatorSet', []).catch(() => null),
    chain.rpcCall('eth_blockNumber', []).then((h) => parseInt(h, 16)).catch(() => 0),
    chain.getProtocol().catch(() => null),
  ]);
  const nodes = require('../routes/nodes');
  const latest = typeof nodes.latestReleaseSha === 'function' ? await nodes.latestReleaseSha().catch(() => null) : null;
  const switches = typeof chain.upcomingSwitches === 'function' ? await chain.upcomingSwitches().catch(() => null) : null;
  return { vset, head, protocol, latest, knownBuildOf: nodes.knownBuildOf, switches: switches && switches.switches ? switches.switches : [] };
}
async function verifiedNodesOf(addresses) {
  if (!addresses.length) return [];
  const r = await pool.query(
    `SELECT identity, operator, host, version, height, last_seen_at FROM verified_nodes WHERE LOWER(operator) = ANY($1)`,
    [addresses]);
  return r.rows;
}

// ─── dedup ─────────────────────────────────────────────────────────────────
/** Send `text` to every chat linked to `address` unless (address,key) fired within ttlMs. */
async function fireOnce(address, key, ttlMs, text, value) {
  const r = await pool.query('SELECT fired_at, value FROM alert_state WHERE address = $1 AND key = $2', [address, key]);
  const prev = r.rows[0];
  if (prev && value !== undefined && prev.value === String(value) && Date.now() - new Date(prev.fired_at).getTime() < ttlMs) return false;
  if (prev && value === undefined && Date.now() - new Date(prev.fired_at).getTime() < ttlMs) return false;
  const chats = await pool.query('SELECT chat_id FROM alert_links WHERE address = $1', [address]);
  let sent = false;
  for (const c of chats.rows) sent = (await send(c.chat_id, text)) || sent;
  await pool.query(
    `INSERT INTO alert_state (address, key, value, fired_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (address, key) DO UPDATE SET value = EXCLUDED.value, fired_at = NOW()`,
    [address, key, value === undefined ? null : String(value)]);
  return sent;
}
async function stateValue(address, key) {
  const r = await pool.query('SELECT value FROM alert_state WHERE address = $1 AND key = $2', [address, key]);
  return r.rows[0] ? r.rows[0].value : null;
}
async function setState(address, key, value) {
  await pool.query(
    `INSERT INTO alert_state (address, key, value, fired_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (address, key) DO UPDATE SET value = EXCLUDED.value, fired_at = NOW()`,
    [address, key, String(value)]);
}

// ─── operator rules ────────────────────────────────────────────────────────
async function operatorTick(address, snap, verified) {
  const { vset, head, latest, knownBuildOf, switches } = snap;
  if (!vset || !Array.isArray(vset.validators)) return;
  const mine = vset.validators.filter((v) => v.operator.toLowerCase() === address);
  const epoch = vset.epoch;
  const stakingUrl = 'https://trade.mersennet.com/staking';
  for (const v of mine) {
    const id = v.identity.toLowerCase();
    const tag = `<code>${short(v.identity)}</code>`;
    // status transitions (pending → active, active → standby/jailed/exiting …)
    const lastStatus = await stateValue(address, `status:${id}`);
    if (lastStatus !== null && lastStatus !== v.status) {
      const why = { active: 'it is in the active set and proposes blocks', standby: 'it ranks below the top by stake this epoch — more self-stake or delegations at the next boundary put it back', jailed: `it missed too many slots and sits out until epoch ${v.jailedUntilEpoch}`, exiting: 'it leaves the set at the next epoch boundary; the self-stake then unbonds', pending: 'it joins at the next epoch boundary' }[v.status] || '';
      await fireOnce(address, `statuschange:${id}:${v.status}:${epoch}`, 6 * HOUR, `Validator ${tag} is now <b>${v.status}</b> (was ${lastStatus}) — ${why}. ${stakingUrl}`);
    }
    await setState(address, `status:${id}`, v.status);
    if (v.benched) {
      await fireOnce(address, `benched:${id}:${epoch}`, 24 * HOUR, `⚠️ Validator ${tag} is <b>benched</b> for the rest of epoch ${epoch}: it missed 3 leader slots. It still votes; the epoch boundary will jail it for the next epoch unless the node recovers. Check <code>systemctl status mersennet</code> and <code>mersennet-check</code> on the server.`);
    } else if (v.status === 'active' && v.missedSlots >= 2 && v.proposedSlots === 0) {
      await fireOnce(address, `missed:${id}:${epoch}`, 24 * HOUR, `⚠️ Validator ${tag} has missed ${v.missedSlots} leader slots this epoch and proposed none. Each miss delays the network by a failover round; more than 20% missed jails it for the next epoch. Check the node now.`);
    }
    if (v.status === 'jailed') {
      await fireOnce(address, `jailed:${id}:${v.jailedUntilEpoch}`, 7 * 24 * HOUR, `⛔ Validator ${tag} is <b>jailed</b> until epoch ${v.jailedUntilEpoch} (current ${epoch}). Fix the node before then; it rejoins automatically when the jail ends.`);
    }
    // live node facts: build registry (whoami) and the verified_nodes recheck
    const b = knownBuildOf ? knownBuildOf(v.identity) : null;
    const vn = verified.find((n) => n.identity.toLowerCase() === id);
    if (b && head && b.height && head - b.height > 300) {
      await fireOnce(address, `behind:${id}`, 6 * HOUR, `⚠️ Node ${tag} is <b>${fmt(head - b.height)} blocks behind</b> the chain (node ${fmt(b.height)}, head ${fmt(head)}); it cannot propose while it catches up. If it does not recover within a few minutes, re-run the installer with <code>--reset-state</code>.`);
      await setState(address, `wasbehind:${id}`, '1');
    } else if (b && head && (await stateValue(address, `wasbehind:${id}`)) === '1') {
      await setState(address, `wasbehind:${id}`, '0');
      await fireOnce(address, `insync:${id}:${Math.floor(Date.now() / HOUR)}`, HOUR, `✅ Node ${tag} is back in sync (height ${fmt(b.height)}).`);
    }
    if (vn && vn.last_seen_at && Date.now() - new Date(vn.last_seen_at).getTime() > 45 * 60_000 && v.status === 'active') {
      await fireOnce(address, `silent:${id}`, 6 * HOUR, `⚠️ Node ${tag} has not answered the network's probe for ${fmt((Date.now() - new Date(vn.last_seen_at).getTime()) / 60_000)} minutes. Is the server up and port 8545 open to the app host?`);
    }
    const build = (b && b.build) || (vn && vn.version ? String(vn.version).split('-').pop() : null);
    if (latest && build && build !== latest) {
      await fireOnce(address, `outdated:${id}:${latest}`, 7 * 24 * HOUR, `🔧 Node ${tag} runs build <code>${build}</code>; the current release is <code>${latest}</code>. Upgrade keeps keys and data:\n<code>curl -fsSL https://mersennet.com/downloads/install.sh | sudo bash -s -- --operator ${address}</code>`);
    }
    // protocol switches: 24 h, 6 h, 1 h before each height
    for (const sw of switches) {
      const h = sw.etaSec / 3600;
      for (const [label, lo, hi] of [['24h', 22, 26], ['6h', 5, 7], ['1h', 0.75, 1.25]]) {
        if (h >= lo && h <= hi) {
          const state = latest && build ? (build === latest ? `Your node runs <code>${build}</code> — current ✅` : `Your node runs <code>${build}</code> but the release for this switch is <code>${latest}</code> — <b>upgrade before the height</b> or it forks off ❌`) : '';
          await fireOnce(address, `switch:${sw.height}:${label}`, 30 * 24 * HOUR, `📅 Protocol switch at block <b>${fmt(sw.height)}</b> in ~${label.replace('h', ' h')} (${new Date(sw.etaAt).toUTCString().replace(':00 GMT', ' UTC')}): ${sw.label}. ${state}`);
        }
      }
    }
  }
}

// ─── trader rules ──────────────────────────────────────────────────────────
async function traderTick(address, snap) {
  const p = snap.protocol;
  if (!p || !p.settlementActive || !p.maintenanceMarginBps) return; // liquidations are not live yet
  const mm = p.maintenanceMarginBps / 10_000;
  let notional = 0, pnl = 0, lines = [];
  for (const m of chain.MARKETS) {
    let pos; try { pos = await chain.getPosition(m.id, address); } catch { continue; }
    const size = Number(pos.size); if (!size) continue;
    const entry = Number(pos.entryPrice);
    let mark = 0; try { const ba = await chain.getBestBidAsk(m.id); const bid = chain.toHumanPrice(m.id, ba.bestBid), ask = chain.toHumanPrice(m.id, ba.bestAsk); mark = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask; } catch { /* no book */ }
    if (!mark) continue;
    notional += Math.abs(size) * mark;
    pnl += size * (mark - entry);
    lines.push(`${m.symbol} ${size > 0 ? 'long' : 'short'} ${fmt(Math.abs(size))} @ ${fmt(mark, 2)}`);
  }
  if (!notional) { await setState(address, `liq:${address}`, 'none'); return; }
  const collateral = Number(await chain.getCollateral(address).catch(() => 0));
  const equity = collateral + pnl;
  const maintenance = notional * mm;
  const ratio = equity / notional;
  const url = 'https://trade.mersennet.com/trade';
  if (equity <= maintenance) {
    await fireOnce(address, `liq-now:${address}`, HOUR, `🚨 Your account is <b>liquidatable</b>: equity ${fmt(equity, 2)} MRSN ≤ maintenance ${fmt(maintenance, 2)} MRSN (${fmt(ratio * 100, 2)}% of ${fmt(notional, 0)} notional). The keeper can close positions any moment — deposit collateral or reduce size now. ${url}\n${lines.join('\n')}`);
  } else if (equity < maintenance * 1.6) {
    await fireOnce(address, `liq-warn:${address}`, HOUR, `⚠️ Liquidation warning: equity ${fmt(equity, 2)} MRSN is ${fmt((equity / maintenance), 2)}× maintenance (${fmt(ratio * 100, 2)}% margin on ${fmt(notional, 0)} notional; liquidation at ${fmt(mm * 100, 1)}%). Add collateral or reduce size. ${url}\n${lines.join('\n')}`);
  }
}

// ─── /status text ──────────────────────────────────────────────────────────
async function statusText(chatId) {
  const links = await pool.query('SELECT address, kind FROM alert_links WHERE chat_id = $1 ORDER BY linked_at', [chatId]);
  if (!links.rows.length) return 'Nothing linked here yet. Press <b>Telegram alerts</b> in the terminal to link a wallet.';
  const snap = await snapshot();
  const out = [];
  for (const l of links.rows) {
    if (l.kind === 'operator') {
      const mine = snap.vset && Array.isArray(snap.vset.validators) ? snap.vset.validators.filter((v) => v.operator.toLowerCase() === l.address) : [];
      if (!mine.length) { out.push(`<code>${short(l.address)}</code> — operator, no registered validator yet.`); continue; }
      for (const v of mine) {
        const b = snap.knownBuildOf ? snap.knownBuildOf(v.identity) : null;
        const rank = snap.vset.validators.slice().sort((a, c) => (wei(c.votingStake) > wei(a.votingStake) ? 1 : -1)).findIndex((x) => x.identity === v.identity) + 1;
        out.push(`Validator <code>${short(v.identity)}</code> — <b>${v.status}</b>${v.benched ? ' (benched)' : ''} · rank #${rank} · self-stake ${fmt(mrsn(v.selfStake))} · delegated ${fmt(mrsn(v.delegated))} MRSN · epoch ${snap.vset.epoch}: ${v.proposedSlots} proposed / ${v.missedSlots} missed${b ? ` · build ${b.build}${snap.latest && b.build !== snap.latest ? ` (current ${snap.latest} ❗)` : ' ✅'} · height ${fmt(b.height)}${snap.head ? ` (head ${fmt(snap.head)})` : ''}` : ''}`);
      }
    } else {
      const p = snap.protocol;
      let n = 0; for (const m of chain.MARKETS) { try { const pos = await chain.getPosition(m.id, l.address); if (Number(pos.size)) n++; } catch { /* none */ } }
      const col = Number(await chain.getCollateral(l.address).catch(() => 0));
      out.push(`Trader <code>${short(l.address)}</code> — collateral ${fmt(col, 2)} MRSN · ${n} open position${n === 1 ? '' : 's'}${p && p.settlementActive ? '' : ' · liquidation alerts start when settlement goes live'}`);
    }
  }
  for (const sw of snap.switches) out.push(`📅 Switch at block ${fmt(sw.height)} in ~${(sw.etaSec / 3600).toFixed(1)} h: ${sw.label}`);
  return out.join('\n');
}

// ─── engine loop ───────────────────────────────────────────────────────────
async function tick() {
  const links = await pool.query('SELECT DISTINCT address, kind FROM alert_links');
  if (!links.rows.length) return;
  const snap = await snapshot();
  const operators = links.rows.filter((l) => l.kind === 'operator').map((l) => l.address);
  const verified = await verifiedNodesOf(operators);
  for (const l of links.rows) {
    try {
      if (l.kind === 'operator') await operatorTick(l.address, snap, verified);
      else await traderTick(l.address, snap);
    } catch (e) { console.error('[alerts] tick', l.address, e.message); }
  }
}

function start() {
  if (!TOKEN) { console.log('[alerts] no bot token — disabled'); return; }
  initTables().then(() => {
    botName().then((n) => console.log(`[alerts] bot @${n}, poller + engine started`));
    pollLoop();
    setTimeout(() => { tick().catch(() => {}); setInterval(() => tick().catch(() => {}), TICK_MS); }, 15_000);
  }).catch((e) => console.error('[alerts] init:', e.message));
}

module.exports = { start, initTables, botName, linkMessage, verifyLinkSignature, createLinkCode, linksFor, unlinkAddress, KINDS };
