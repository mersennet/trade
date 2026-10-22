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
 *              change · node behind the head · node silent · outdated build ·
 *              upgrade landed, or went wrong (other build, behind, silent)
 *              (+ 24 h / 6 h / 1 h before every protocol switch)
 *   traders    equity within 1.6× of maintenance margin, or below it (the
 *              keeper liquidates) — only once settlement is active
 *   delegators validator benched · jailed · status change · commission ·
 *              unbonded MRSN withdrawable; a daily, weekly (default) or
 *              monthly report of each delegation (/daily /weekly /monthly)
 * Every alert is de-duplicated through alert_state so a stuck condition
 * pages once per window, not once per minute.
 *
 * Bots: "Mersennet Node Alert" (operators, traders) and, once
 * STAKING_TELEGRAM_BOT_TOKEN is set, "Mersennet Staking Alert" (delegators).
 * A bot can only write to chats that started it, so each link keeps the bot
 * it was made through; delegators linked before the staking bot stay on the
 * node bot until they link again.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const pool = require('../db/pool');
const chain = require('./chain');

const BOTS = {
  node: {
    id: 'node',
    token: process.env.ALERTS_TELEGRAM_BOT_TOKEN || process.env.FEEDBACK_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '',
    fallbackName: process.env.ALERTS_BOT_USERNAME || 'mersennet_alerts_bot',
    username: null,
    offset: 0,
  },
  staking: {
    id: 'staking',
    token: process.env.STAKING_TELEGRAM_BOT_TOKEN || '',
    fallbackName: process.env.STAKING_BOT_USERNAME || 'mersennet_staking_bot',
    username: null,
    offset: 0,
  },
};
/** The bot new links of `kind` are made through. */
const botFor = (kind) => (kind === 'delegator' && BOTS.staking.token ? BOTS.staking : BOTS.node);
const botById = (id) => (BOTS[id] && BOTS[id].token ? BOTS[id] : BOTS.node);
const LINK_TTL_MS = 15 * 60_000;
const TICK_MS = 60_000;
const HOUR = 3_600_000;

// ─── schema ────────────────────────────────────────────────────────────────
async function initTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS alert_links (
    chat_id BIGINT NOT NULL,
    address TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'operator',
    username TEXT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, address, kind)
  )`);
  // One chat may follow one wallet as operator and as delegator: links made
  // before 20 Oct are keyed by (chat_id, address) only.
  const pk = await pool.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'alert_links'::regclass AND i.indisprimary`);
  if (!pk.rows.some((r) => r.attname === 'kind')) {
    await pool.query('ALTER TABLE alert_links DROP CONSTRAINT alert_links_pkey, ADD PRIMARY KEY (chat_id, address, kind)');
  }
  await pool.query(`ALTER TABLE alert_links ADD COLUMN IF NOT EXISTS bot TEXT NOT NULL DEFAULT 'node'`);
  // Report frequency per chat and bot (delegators): daily, weekly or monthly; off stops them.
  await pool.query(`CREATE TABLE IF NOT EXISTS alert_digests (
    chat_id BIGINT NOT NULL,
    bot TEXT NOT NULL,
    freq TEXT NOT NULL DEFAULT 'weekly',
    PRIMARY KEY (chat_id, bot)
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
async function tg(bot, method, body) {
  if (!bot.token) throw new Error('alerts: no bot token');
  const r = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
async function send(chatId, html, bot = BOTS.node) {
  try {
    await tg(bot, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    // 403 = the user blocked this bot: forget its links so we stop trying (the other bot's stay).
    if (/bot was blocked|chat not found|user is deactivated/i.test(e.message)) {
      await pool.query('DELETE FROM alert_links WHERE chat_id = $1 AND bot = $2', [chatId, bot.id]).catch(() => {});
    } else console.error('[alerts]', e.message);
    return false;
  }
}
async function botName(bot = BOTS.node) {
  if (bot.username) return bot.username;
  try { bot.username = (await tg(bot, 'getMe')).username; } catch { return bot.fallbackName; }
  return bot.username;
}

// ─── linking ───────────────────────────────────────────────────────────────
const KINDS = new Set(['operator', 'trader', 'delegator']);
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
  return { code, deepLink: `https://t.me/${await botName(botFor(kind))}?start=${code}` };
}
async function linksFor(address) {
  const r = await pool.query('SELECT chat_id, kind, bot, username, linked_at FROM alert_links WHERE address = $1 ORDER BY linked_at', [address.toLowerCase()]);
  return r.rows;
}
/** Remove the address's links, of one kind when given. */
async function unlinkAddress(address, kind) {
  if (kind) await pool.query('DELETE FROM alert_links WHERE address = $1 AND kind = $2', [address.toLowerCase(), kind]);
  else await pool.query('DELETE FROM alert_links WHERE address = $1', [address.toLowerCase()]);
}

// ─── bot poller (/start <code>, /status, /stop, report frequency) ──────────
const FREQS = { '/daily': 'daily', '/weekly': 'weekly', '/monthly': 'monthly', '/noreport': 'off' };
async function pollOnce(bot) {
  const updates = await tg(bot, 'getUpdates', { offset: bot.offset, timeout: 25, allowed_updates: ['message'] });
  for (const u of updates) {
    bot.offset = u.update_id + 1;
    const msg = u.message;
    if (!msg || !msg.text || !msg.chat) continue;
    // Groups, supergroups and channels: the bot only *posts* there (announcements);
    // it never answers. Links are per private chat, so nothing it could say in a
    // group is useful — and as a group admin it sees every message, so without this
    // guard it replied with its help text to each one (community chat, 22 Sep).
    if (msg.chat.type !== 'private') continue;
    const chatId = msg.chat.id;
    const username = msg.from && msg.from.username ? msg.from.username : null;
    const [rawCmd, arg] = msg.text.trim().split(/\s+/);
    const cmd = rawCmd.replace(/@\w+$/, '').toLowerCase(); // "/status@MersennetAlertsBot" → "/status"
    const say = (html) => send(chatId, html, bot);
    const staking = bot.id === 'staking';
    const help = staking
      ? '/status — your delegations now\n/daily · /weekly · /monthly — how often the report comes (weekly by default)\n/noreport — no reports, alerts only\n/stop — unlink'
      : '/status — current state of your linked addresses\n/stop — unlink';
    try {
      if (cmd === '/start' && arg) {
        const c = await pool.query(
          `SELECT address, kind FROM alert_link_codes WHERE code = $1 AND used_at IS NULL AND created_at > NOW() - INTERVAL '15 minutes'`, [arg]);
        if (!c.rows[0]) { await say('That link has expired or was already used. Open the terminal again and press <b>Telegram alerts</b> for a fresh one.'); continue; }
        const { address, kind } = c.rows[0];
        const home = botFor(kind);
        if (home.id !== bot.id) { await say(`This link is for @${await botName(home)}: open it there.`); continue; }
        await pool.query('UPDATE alert_link_codes SET used_at = NOW() WHERE code = $1', [arg]);
        await pool.query(
          `INSERT INTO alert_links (chat_id, address, kind, username, bot) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (chat_id, address, kind) DO UPDATE SET username = EXCLUDED.username, bot = EXCLUDED.bot, linked_at = NOW()`,
          [chatId, address, kind, username, bot.id]);
        const when = {
          operator: 'your validator misses slots, is benched or jailed, falls behind the chain, goes silent, runs an outdated build, finishes an upgrade (or the upgrade goes wrong), or a protocol switch is 24 h / 6 h / 1 h away',
          trader: 'a position gets within reach of liquidation (equity under 1.6× maintenance margin) or is liquidatable',
          delegator: `a validator you delegate to is benched or jailed, goes standby or exits, becomes active again or changes its commission, and when MRSN you undelegated can be withdrawn${staking ? '. A report of your delegations comes every Monday' : ''}`,
        }[kind];
        await say(`Linked to <code>${short(address)}</code> (${kind}). You will hear from me when ${when}.\n\n${help}`);
        await say(await statusText(chatId, bot));
      } else if (cmd === '/status') {
        await say(await statusText(chatId, bot));
      } else if (cmd === '/stop') {
        await pool.query('DELETE FROM alert_links WHERE chat_id = $1 AND bot = $2', [chatId, bot.id]);
        await pool.query('DELETE FROM alert_digests WHERE chat_id = $1 AND bot = $2', [chatId, bot.id]);
        await say('Unlinked. Nothing more will be sent here; relink any time from the terminal.');
      } else if (FREQS[cmd]) {
        const freq = FREQS[cmd];
        await pool.query(
          `INSERT INTO alert_digests (chat_id, bot, freq) VALUES ($1, $2, $3) ON CONFLICT (chat_id, bot) DO UPDATE SET freq = EXCLUDED.freq`,
          [chatId, bot.id, freq]);
        await say(freq === 'off'
          ? 'No more reports; alerts still come when something changes. /weekly turns them back on.'
          : `Reports now come ${{ daily: 'every day', weekly: 'every Monday', monthly: 'on the 1st of each month' }[freq]} at 09:00 UTC.`);
      } else if (cmd === '/start') {
        await say(staking
          ? 'This bot follows your Mersennet delegations: alerts when a validator you back is benched, jailed or changes its commission, and a regular report. Link it from <a href="https://trade.mersennet.com/staking">trade.mersennet.com/staking</a>: press <b>Telegram alerts</b> under your delegations.'
          : `This bot sends Mersennet validator and position alerts. Link it from <a href="https://trade.mersennet.com/staking">trade.mersennet.com/staking</a> (operators) or the account panel on <a href="https://trade.mersennet.com/trade">/trade</a> (traders) — press <b>Telegram alerts</b> there.`);
      } else if (cmd.startsWith('/')) {
        await say(help);
      }
      // Plain text in a private chat gets no reply: the bot is not a conversation.
    } catch (e) { console.error('[alerts] update:', e.message); }
  }
}
async function pollLoop(bot) {
  for (;;) {
    try { await pollOnce(bot); }
    catch (e) { console.error(`[alerts] poll (${bot.id}):`, e.message); await sleep(5000); }
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
  // One entry per height (the API lists one per feature label).
  const byHeight = new Map();
  for (const sw of (switches && switches.switches) || []) {
    const g = byHeight.get(sw.height) || { height: sw.height, etaSec: sw.etaSec, etaAt: sw.etaAt, labels: [] };
    g.labels.push(sw.label); byHeight.set(sw.height, g);
  }
  const grouped = [...byHeight.values()].sort((a, b) => a.height - b.height).map((g) => ({ ...g, label: g.labels.join(' · ') }));
  return { vset, head, protocol, latest, knownBuildOf: nodes.knownBuildOf, switches: grouped };
}
async function verifiedNodesOf(addresses) {
  if (!addresses.length) return [];
  const r = await pool.query(
    `SELECT identity, operator, host, version, height, last_seen_at FROM verified_nodes WHERE LOWER(operator) = ANY($1)`,
    [addresses]);
  return r.rows;
}

// ─── dedup ─────────────────────────────────────────────────────────────────
/**
 * Send `text` to every chat that links `address` as one of `kinds` unless
 * (address,key) fired within ttlMs. Delegator alerts reach delegator links only.
 */
async function fireOnce(address, key, ttlMs, text, value, kinds = ['operator', 'trader']) {
  const r = await pool.query('SELECT fired_at, value FROM alert_state WHERE address = $1 AND key = $2', [address, key]);
  const prev = r.rows[0];
  if (prev && value !== undefined && prev.value === String(value) && Date.now() - new Date(prev.fired_at).getTime() < ttlMs) return false;
  if (prev && value === undefined && Date.now() - new Date(prev.fired_at).getTime() < ttlMs) return false;
  const chats = await pool.query('SELECT DISTINCT chat_id, bot FROM alert_links WHERE address = $1 AND kind = ANY($2)', [address, kinds]);
  let sent = false;
  for (const c of chats.rows) sent = (await send(c.chat_id, text, botById(c.bot))) || sent;
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
      // The bench freezes the epoch's counts, so the boundary's verdict is already known:
      // jailed when more than 20% of its slots were missed (genesis validators never are).
      const slots = v.proposedSlots + v.missedSlots;
      const jail = !v.genesis && v.missedSlots * 10_000 > slots * 2_000;
      const verdict = jail
        ? `With ${v.missedSlots} of ${slots} slots missed (more than 20%), the epoch boundary will jail it for the next epoch whatever the node does now; keep it running and it rejoins by itself after the jail.`
        : `With ${v.missedSlots} of ${slots} slots missed (under the 20% jail line), it is back in the rotation next epoch if the node is up.`;
      await fireOnce(address, `benched:${id}:${epoch}`, 24 * HOUR, `⚠️ Validator ${tag} is <b>benched</b> for the rest of epoch ${epoch}: it missed ${v.missedSlots} leader slots. It still votes. ${verdict} Check <code>systemctl status mersennet</code> and <code>mersennet-check</code> on the server.`);
    } else if (v.status === 'active' && v.missedSlots >= 2 && v.proposedSlots === 0) {
      await fireOnce(address, `missed:${id}:${epoch}`, 24 * HOUR, `⚠️ Validator ${tag} has missed ${v.missedSlots} leader slots this epoch and proposed none. Each miss delays the network by a failover round; more than 20% missed jails it for the next epoch. Check the node now.`);
    }
    if (v.status === 'jailed') {
      await fireOnce(address, `jailed:${id}:${v.jailedUntilEpoch}`, 7 * 24 * HOUR, `⛔ Validator ${tag} is <b>jailed</b> until epoch ${v.jailedUntilEpoch} (current ${epoch}). Fix the node before then; it rejoins automatically when the jail ends.`);
    }
    // live node facts: build registry (whoami) and the verified_nodes recheck
    const b = knownBuildOf ? knownBuildOf(v.identity) : null;
    const vn = verified.find((n) => n.identity.toLowerCase() === id);
    // whoami reported b.height at b.seenAt and the registry re-asks every 5 minutes:
    // compare with where the chain was then, and only while the answer is recent
    // (a node that stopped answering is silent, not behind).
    const fresh = !!(b && b.seenAt && Date.now() - b.seenAt < 12 * 60_000);
    const lag = fresh && b.height != null && head ? Math.max(0, head - Math.floor((Date.now() - b.seenAt) / BLOCK_MS) - b.height) : null;
    const build = (b && b.build) || (vn && vn.version ? String(vn.version).split('-').pop() : null);
    if (latest && build && build !== latest) {
      await fireOnce(address, `outdated:${id}:${latest}`, 7 * 24 * HOUR, `🔧 Node ${tag} runs build <code>${build}</code>; the current release is <code>${latest}</code>. Upgrade keeps keys and data:\n<code>curl -fsSL https://mersennet.com/downloads/install.sh | sudo bash -s -- --operator ${address}</code>\nBest time: about halfway through an epoch (every 1,800 blocks, about an hour). By then the validator has proposed enough blocks that the few slots a restart misses neither bench nor jail it; right after a boundary they can.`);
    }
    // Right after an upgrade the watch reports on the node instead, allowing for the catch-up minute.
    const watching = await upgradeWatch(address, { id, tag, b, fresh, lag, latest });
    if (!watching && lag != null && lag > 300) {
      await fireOnce(address, `behind:${id}`, 6 * HOUR, `⚠️ Node ${tag} is <b>${fmt(lag)} blocks behind</b> the chain (node at ${fmt(b.height)}); it cannot propose while it catches up. If it does not recover within a few minutes, re-run the installer with <code>--reset-state</code>.`);
      await setState(address, `wasbehind:${id}`, '1');
    } else if (lag != null && lag <= 20 && (await stateValue(address, `wasbehind:${id}`)) === '1') {
      await setState(address, `wasbehind:${id}`, '0');
      await fireOnce(address, `insync:${id}:${Math.floor(Date.now() / HOUR)}`, HOUR, `✅ Node ${tag} is back in sync (height ${fmt(b.height)}).`);
    }
    if (vn && vn.last_seen_at && Date.now() - new Date(vn.last_seen_at).getTime() > 45 * 60_000 && v.status === 'active') {
      await fireOnce(address, `silent:${id}`, 6 * HOUR, `⚠️ Node ${tag} has not answered the network's probe for ${fmt((Date.now() - new Date(vn.last_seen_at).getTime()) / 60_000)} minutes. Is the server up and port 8545 open to the app host?`);
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

// ─── upgrades ──────────────────────────────────────────────────────────────
const BLOCK_MS = 2022;
const UPGRADE_WATCH_MS = 45 * 60_000;
/**
 * Confirms an upgrade once the node answers whoami on the current release, and
 * reports the ways one goes wrong: a build that is not the current release, a
 * node that stays behind, one that stops answering. Only the whoami registry
 * counts here: verified_nodes' version can lag by 30 minutes and would read as
 * a build change back and forth. True while an upgrade is being watched.
 */
async function upgradeWatch(address, { id, tag, b, fresh, lag, latest }) {
  if (!b || !b.build || !b.seenAt) return false;
  const now = Date.now();
  const prev = await stateValue(address, `build:${id}`);
  if (fresh && prev !== b.build) {
    await setState(address, `build:${id}`, b.build);
    if (prev && latest && b.build === latest) {
      await setState(address, `upgrade:${id}`, JSON.stringify({ build: b.build, at: now }));
      await setState(address, `wasbehind:${id}`, '0'); // the confirmation below says where it stands
      const height = lag == null ? '' : `Block height ${fmt(b.height)} — ${lag <= 20 ? 'in sync' : `catching up, ${fmt(lag)} blocks behind`}\n`;
      await fireOnce(address, `upgraded:${id}:${b.build}`, 30 * 24 * HOUR,
        `✅ <b>Node ${tag} upgraded</b> and running as a systemd service.\nBinary <code>${b.build}</code> — up to date (was <code>${prev}</code>)\n${height}Keys, state and operator were kept; nothing else to do. If it falls behind or stops answering in the next 45 minutes, I will tell you here.`);
    } else if (prev && latest && b.build !== latest) {
      await fireOnce(address, `upgrade-other:${id}:${b.build}`, 7 * 24 * HOUR,
        `⚠️ Node ${tag} changed build from <code>${prev}</code> to <code>${b.build}</code>, but the current release is <code>${latest}</code>. Re-run the installer to get it (keeps keys and data):\n<code>curl -fsSL https://mersennet.com/downloads/install.sh | sudo bash -s -- --operator ${address}</code>`);
    }
  }
  let up = null;
  try { up = JSON.parse((await stateValue(address, `upgrade:${id}`)) || 'null'); } catch { /* none recorded */ }
  if (!up || up.build !== b.build) return false;
  const since = now - up.at;
  if (since >= UPGRADE_WATCH_MS) return false;
  if (lag != null && lag > 60 && since >= 5 * 60_000) {
    await setState(address, `wasbehind:${id}`, '1'); // the "back in sync" message follows
    await fireOnce(address, `upgrade-behind:${id}:${b.build}`, 7 * 24 * HOUR,
      `⚠️ <b>Node ${tag} upgraded but is not keeping up</b>: ${fmt(lag)} blocks behind the chain ${Math.round(since / 60_000)} minutes after the upgrade (it should be in sync within a minute). On the server:\n<code>mersennet-check</code>\n<code>journalctl -u mersennet -n 50 --no-pager</code>\nIf the log shows <code>RESTORED STATE ROOT MISMATCH</code> or <code>FORK DETECTED</code>, reset the state (keeps keys and operator):\n<code>curl -fsSL https://mersennet.com/downloads/install.sh | sudo bash -s -- --reset-state --operator ${address}</code>`);
  } else if (!fresh) {
    await fireOnce(address, `upgrade-silent:${id}:${b.build}`, 7 * 24 * HOUR,
      `⚠️ <b>Node ${tag} stopped answering</b> after its upgrade: no reply for ${Math.round((now - b.seenAt) / 60_000)} minutes. On the server:\n<code>systemctl status mersennet</code>\n<code>journalctl -u mersennet -n 50 --no-pager</code>\nIf the service keeps restarting, send those log lines in https://discord.gg/aJSQ63PUes (#run-a-node) or https://t.me/Mersennet.`);
  }
  return true;
}

// ─── trader rules ──────────────────────────────────────────────────────────
async function traderTick(address, snap) {
  const p = snap.protocol;
  if (!p || !p.settlementActive || !p.maintenanceMarginBps) return; // liquidations are not live yet
  const mm = p.maintenanceMarginBps / 10_000;
  let notional = 0, pnl = 0, lines = [];
  for (const m of chain.MARKETS) {
    // A failed read means no verdict this tick: a partial account can look liquidatable.
    let pos; try { pos = await chain.getPosition(m.id, address); } catch { return; }
    const size = Number(pos.size); if (!size) continue;
    const entry = Number(pos.entryPrice);
    let mark = 0; try { mark = chain.toHumanPrice(m.id, await chain.getMarkPrice(m.id)); } catch { /* no book */ }
    if (!mark) continue;
    notional += Math.abs(size) * mark;
    pnl += size * (mark - entry);
    lines.push(`${m.symbol} ${size > 0 ? 'long' : 'short'} ${fmt(Math.abs(size))} @ ${fmt(mark, 2)}`);
  }
  if (!notional) { await setState(address, `liq:${address}`, 'none'); return; }
  let collateral; try { collateral = Number(await chain.getCollateral(address)); } catch { return; }
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

// ─── delegator rules ───────────────────────────────────────────────────────
const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000000400';
const stakingIface = new ethers.Interface([
  'function getDelegation(address delegator, address validator) view returns (uint256 amount, uint256 pending)',
  'function getUnbonding(address delegator) view returns (uint256 total, uint256 withdrawable, uint256 nextUnlock)',
]);
async function stakingView(fn, args) {
  const ret = await chain.rpcCall('eth_call', [{ to: STAKING_PRECOMPILE, data: stakingIface.encodeFunctionData(fn, args) }, 'latest']);
  return stakingIface.decodeFunctionResult(fn, ret);
}
/**
 * What `address` has delegated: [{ v, amount, pending }] (wei) per validator of
 * the set, plus its unbonding. The precompile has no per-delegator list, so
 * every registered validator is asked; null when any read fails (no verdict).
 */
async function delegationsOf(address, vset) {
  try {
    const rows = await Promise.all(vset.validators.map(async (v) => {
      const [amount, pending] = await stakingView('getDelegation', [address, v.identity]);
      return { v, amount, pending };
    }));
    const [total, withdrawable, nextUnlock] = await stakingView('getUnbonding', [address]);
    return { delegations: rows.filter((r) => r.amount > 0n), unbonding: { total, withdrawable, nextUnlock: Number(nextUnlock) } };
  } catch {
    return null;
  }
}
const pct = (bps) => `${fmt(Number(bps) / 100, 2)}%`;

async function delegatorTick(address, snap) {
  const { vset } = snap;
  if (!vset || !Array.isArray(vset.validators)) return;
  const d = await delegationsOf(address, vset);
  if (!d) return;
  const epoch = vset.epoch;
  const stakingUrl = 'https://trade.mersennet.com/staking';
  const fire = (key, ttl, text, value) => fireOnce(address, key, ttl, text, value, ['delegator']);
  for (const { v, amount } of d.delegations) {
    const id = v.identity.toLowerCase();
    const tag = `<code>${short(v.identity)}</code>`;
    const yours = `${fmt(mrsn(amount), 2)} MRSN`;
    const lastStatus = await stateValue(address, `dlg-status:${id}`);
    if (lastStatus !== null && lastStatus !== v.status && v.status !== 'jailed') {
      const what = {
        active: `✅ Validator ${tag} is <b>active</b> again and earning; so is your delegation of ${yours}.`,
        standby: `⚠️ Validator ${tag} is now <b>standby</b>: it ranks below the active set by stake, so it earns no block rewards and neither does your delegation of ${yours}. More stake at the next epoch boundary puts it back; to keep earning now, move your delegation to an active validator: ${stakingUrl}`,
        exiting: `⚠️ Validator ${tag} is <b>exiting</b> the set at the next epoch boundary. Move your delegation of ${yours} to an active validator to keep earning: ${stakingUrl}`,
      }[v.status] || `Validator ${tag} is now <b>${v.status}</b> (was ${lastStatus}); your delegation: ${yours}. ${stakingUrl}`;
      await fire(`dlg-statuschange:${id}:${v.status}:${epoch}`, 6 * HOUR, what);
    }
    await setState(address, `dlg-status:${id}`, v.status);
    if (v.status === 'jailed') {
      await fire(`dlg-jailed:${id}:${v.jailedUntilEpoch}`, 7 * 24 * HOUR, `⛔ Validator ${tag}, where you delegate ${yours}, is <b>jailed</b> until epoch ${v.jailedUntilEpoch} (current ${epoch}): it earns no rewards until then, and neither does your delegation. It rejoins by itself; to keep earning now, undelegate (about 4 h of unbonding) and delegate to an active validator: ${stakingUrl}`);
    } else if (v.benched) {
      await fire(`dlg-benched:${id}:${epoch}`, 24 * HOUR, `⚠️ Validator ${tag}, where you delegate ${yours}, is <b>benched</b> for the rest of epoch ${epoch}: it missed 3 leader slots. If it misses more than 20% of its slots it is jailed next epoch and stops earning.`);
    }
    const lastCommission = await stateValue(address, `dlg-commission:${id}`);
    if (lastCommission !== null && Number(lastCommission) !== Number(v.commissionBps)) {
      await fire(`dlg-commission:${id}:${v.commissionBps}`, 7 * 24 * HOUR, `Validator ${tag} changed its commission from ${pct(lastCommission)} to <b>${pct(v.commissionBps)}</b> of your rewards (delegation ${yours}).`);
    }
    await setState(address, `dlg-commission:${id}`, v.commissionBps);
  }
  if (d.unbonding.withdrawable > 0n) {
    await fire('dlg-withdrawable', 7 * 24 * HOUR, `✅ <b>${fmt(mrsn(d.unbonding.withdrawable), 2)} MRSN</b> finished unbonding and can be withdrawn: ${stakingUrl} → Withdraw.`, d.unbonding.withdrawable.toString());
  }
}

async function delegatorStatusLines(address, snap) {
  const d = snap.vset && Array.isArray(snap.vset.validators) ? await delegationsOf(address, snap.vset) : null;
  if (!d) return [`Delegator <code>${short(address)}</code> — delegations unavailable right now.`];
  if (!d.delegations.length && d.unbonding.total === 0n) return [`Delegator <code>${short(address)}</code> — no delegations yet: https://trade.mersennet.com/staking`];
  const out = [`Delegator <code>${short(address)}</code>:`];
  for (const { v, amount, pending } of d.delegations) {
    out.push(`· ${fmt(mrsn(amount), 2)} MRSN with <code>${short(v.identity)}</code> — <b>${v.status}</b>${v.benched ? ' (benched)' : ''} · commission ${pct(v.commissionBps)} · rewards to claim ${fmt(mrsn(pending), 4)} MRSN`);
  }
  if (d.unbonding.total > 0n) {
    const left = d.unbonding.nextUnlock && snap.head ? Math.max(0, d.unbonding.nextUnlock - snap.head) : 0;
    out.push(`· unbonding ${fmt(mrsn(d.unbonding.total), 2)} MRSN, withdrawable now ${fmt(mrsn(d.unbonding.withdrawable), 2)}${left ? ` · next unlock in ~${fmt(left * BLOCK_MS / 3_600_000, 1)} h` : ''}`);
  }
  return out;
}

// ─── delegator reports (daily / weekly / monthly at 09:00 UTC) ─────────────
const REPORT_HOUR_UTC = 9;
/** The report period `freq` is in once its 09:00 UTC start has passed: { key, startMs }, else null. */
function reportPeriod(freq, now = new Date()) {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = {
    daily: day,
    weekly: day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000, // Monday
    monthly: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  }[freq];
  if (start === undefined) return null;
  const startMs = start + REPORT_HOUR_UTC * HOUR;
  return now.getTime() >= startMs ? { key: new Date(start).toISOString().slice(0, 10), startMs } : null;
}
async function countFired(address, prefix, sinceMs) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM alert_state WHERE address = $1 AND key LIKE $2 AND fired_at > to_timestamp($3 / 1000.0)',
    [address, `${prefix}%`, sinceMs]);
  return r.rows[0].n;
}
/**
 * The report for one delegator, measured against the previous one for the same
 * chat, bot and frequency (kept per validator in alert_state). Null when the
 * delegations cannot be read this minute.
 */
async function reportText(address, freq, snap, chatId, botId) {
  const d = await delegationsOf(address, snap.vset);
  if (!d) return null;
  const lines = [`📊 <b>${{ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[freq]} staking report</b> · <code>${short(address)}</code>`];
  if (!d.delegations.length && d.unbonding.total === 0n) {
    lines.push('No delegations right now: https://trade.mersennet.com/staking');
    return lines.join('\n');
  }
  let amountAll = 0n, pendingAll = 0n, earnedAll = 0n, earnedKnown = true, sinceMs = null;
  for (const { v, amount, pending } of d.delegations) {
    const id = v.identity.toLowerCase();
    const snapKey = `report-snap:${chatId}:${botId}:${freq}:${id}`;
    let prev = null;
    try { prev = JSON.parse((await stateValue(address, snapKey)) || 'null'); } catch { /* first report */ }
    const proposed = Number(v.totalProposed || 0);
    const parts = [`<b>${v.status}</b>${v.benched ? ' (benched)' : ''}`, `commission ${pct(v.commissionBps)}`];
    if (prev) {
      sinceMs = sinceMs === null ? prev.at : Math.min(sinceMs, prev.at);
      parts.push(`${fmt(Math.max(0, proposed - prev.proposed))} blocks proposed`);
      const before = BigInt(prev.pending);
      if (pending >= before) {
        earnedAll += pending - before;
        parts.push(`+${fmt(mrsn(pending - before), 2)} MRSN earned`);
      } else {
        earnedKnown = false;
        parts.push('rewards claimed since the last report');
      }
      const jailed = await countFired(address, `dlg-jailed:${id}:`, prev.at);
      const benched = await countFired(address, `dlg-benched:${id}:`, prev.at);
      if (jailed) parts.push(`jailed ${jailed}×`);
      if (benched) parts.push(`benched ${benched}×`);
    } else {
      earnedKnown = false;
    }
    parts.push(`${fmt(mrsn(pending), 2)} MRSN to claim`);
    lines.push(`· ${fmt(mrsn(amount), 2)} MRSN with <code>${short(v.identity)}</code>: ${parts.join(' · ')}`);
    amountAll += amount;
    pendingAll += pending;
    await setState(address, snapKey, JSON.stringify({ pending: pending.toString(), proposed, at: Date.now() }));
  }
  if (d.delegations.length > 1 || earnedKnown) {
    const days = sinceMs ? (Date.now() - sinceMs) / 86_400_000 : 0;
    const pace = earnedKnown && days > 0.5 && amountAll > 0n
      ? ` (about ${fmt(mrsn(earnedAll) / mrsn(amountAll) * (365 / days) * 100, 1)}% a year at this pace)` : '';
    lines.push(`Total: ${fmt(mrsn(amountAll), 2)} MRSN delegated${earnedKnown ? ` · +${fmt(mrsn(earnedAll), 2)} MRSN earned${pace}` : ''} · ${fmt(mrsn(pendingAll), 2)} MRSN to claim`);
  }
  if (d.unbonding.total > 0n) lines.push(`Unbonding ${fmt(mrsn(d.unbonding.total), 2)} MRSN, ${fmt(mrsn(d.unbonding.withdrawable), 2)} withdrawable now.`);
  lines.push('https://trade.mersennet.com/staking · /daily /weekly /monthly /noreport');
  return lines.join('\n');
}
async function reportTick(snap, now = new Date()) {
  if (!snap.vset || !Array.isArray(snap.vset.validators)) return;
  const rows = await pool.query(
    `SELECT l.chat_id, l.bot, l.address, COALESCE(d.freq, 'weekly') AS freq
       FROM alert_links l LEFT JOIN alert_digests d ON d.chat_id = l.chat_id AND d.bot = l.bot
      WHERE l.kind = 'delegator' AND l.bot = 'staking'`);
  for (const r of rows.rows) {
    const period = reportPeriod(r.freq, now);
    if (!period) continue;
    const doneKey = `report:${r.chat_id}:${r.bot}:${r.freq}:${period.key}`;
    if ((await stateValue(r.address, doneKey)) !== null) continue;
    const baseKey = `report-base:${r.chat_id}:${r.bot}:${r.freq}`;
    const first = (await stateValue(r.address, baseKey)) === null;
    const text = await reportText(r.address, r.freq, snap, r.chat_id, r.bot);
    if (!text) continue;
    // The first period only records where things stand, so the first report measures a whole period.
    if (!first) await send(r.chat_id, text, botById(r.bot));
    else await setState(r.address, baseKey, String(Date.now()));
    await setState(r.address, doneKey, '1');
  }
}

// ─── /status text ──────────────────────────────────────────────────────────
async function statusText(chatId, bot = BOTS.node) {
  const links = await pool.query('SELECT address, kind FROM alert_links WHERE chat_id = $1 AND bot = $2 ORDER BY linked_at', [chatId, bot.id]);
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
    } else if (l.kind === 'delegator') {
      out.push(...(await delegatorStatusLines(l.address, snap)));
    } else {
      const p = snap.protocol;
      let n = 0; for (const m of chain.MARKETS) { try { const pos = await chain.getPosition(m.id, l.address); if (Number(pos.size)) n++; } catch { /* none */ } }
      const col = await chain.getCollateral(l.address).then(Number).catch(() => null);
      out.push(`Trader <code>${short(l.address)}</code> — collateral ${col == null ? 'unavailable right now' : `${fmt(col, 2)} MRSN`} · ${n} open position${n === 1 ? '' : 's'}${p && p.settlementActive ? '' : ' · liquidation alerts start when settlement goes live'}`);
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
      else if (l.kind === 'delegator') await delegatorTick(l.address, snap);
      else await traderTick(l.address, snap);
    } catch (e) { console.error('[alerts] tick', l.address, e.message); }
  }
  await reportTick(snap).catch((e) => console.error('[alerts] reports', e.message));
}

function start() {
  if (!BOTS.node.token) { console.log('[alerts] no bot token — disabled'); return; }
  initTables().then(() => {
    for (const bot of Object.values(BOTS).filter((b) => b.token)) {
      botName(bot).then((n) => console.log(`[alerts] ${bot.id} bot @${n}, poller started`));
      pollLoop(bot);
    }
    setTimeout(() => { tick().catch(() => {}); setInterval(() => tick().catch(() => {}), TICK_MS); }, 15_000);
  }).catch((e) => console.error('[alerts] init:', e.message));
}

module.exports = { start, initTables, botName, botFor, linkMessage, verifyLinkSignature, createLinkCode, linksFor, unlinkAddress, KINDS, statusText, tick, delegationsOf, delegatorStatusLines, reportPeriod, reportTick, pollOnce, fireOnce, BOTS };
