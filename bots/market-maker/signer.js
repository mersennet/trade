/**
 * Signed-transaction helper for the Mersennet bots.
 *
 * The node no longer accepts unsigned `owner`-field orders — every state change
 * is a wallet-signed transaction to the CLOB precompile (0x…0100), executed
 * with `caller = recovered signer`. Bots therefore hold real keypairs, are
 * funded with native MRSN at genesis, and submit signed txs via
 * eth_sendRawTransaction.
 *
 * Bot wallets are derived deterministically from a master seed so their
 * addresses are stable across restarts — the genesis config funds them and the
 * indexer excludes them from the leaderboard/points. Override the seed with
 * BOT_SEED in production if you want private keys.
 */

const { ethers } = require('ethers');

const PRECOMPILE = '0x0000000000000000000000000000000000000100';
const CHAIN_ID = Number(process.env.CHAIN_ID || 131071);
const BOT_SEED = process.env.BOT_SEED || 'mersennet-bot-v1';

const IFACE = new ethers.Interface([
  'function placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif) returns (uint256, uint256, uint256)',
  'function cancelOrder(uint256 orderId) returns (bool)',
  'function depositCollateral(uint256 amount) returns (bool)',
  'function getCollateral() view returns (uint256)',
]);

const TIF_CODE = { gtc: 0, ioc: 1, fok: 2, Gtc: 0, Ioc: 1, Fok: 2 };

// Max unmined txs a single bot wallet keeps in flight before it backs off.
// Prevents the local nonce racing ahead of block inclusion (later txs would
// become silently-dropped future nonces). The node also caps queued txs per
// sender, so this only needs to cover one refresh cycle's worth of orders so
// a full ladder lands rather than being mostly dropped. Takers do tiny waves
// and never approach it.
const MAX_INFLIGHT = Number(process.env.BOT_MAX_INFLIGHT || 40);

// If we are backed off (local nonce > MAX_INFLIGHT ahead of the account
// nonce) and the account nonce has not advanced for this long, the "in
// flight" txs are phantoms — accepted by the RPC but dropped before mining
// (pool eviction, gossip loss, a rate-limited window). Resync to the account
// nonce so we start sending again. Without this the wallet wedges forever:
// skipped sends never reach the node, so no nonce error ever triggers a
// resync (this is exactly how the maker sat idle for two weeks).
const STALL_RESYNC_MS = Number(process.env.BOT_STALL_RESYNC_MS || 20_000);

// How long cached chain reads (account nonce, gas price) are reused across a
// burst of sends. One cycle fires ~30 sends; refetching both per send tripled
// the request count and tripped the node's 100 req/s per-IP limiter.
const NONCE_CACHE_MS = 400;
const GAS_PRICE_CACHE_MS = 10_000;

// Minimum gap between consecutive sends from one wallet. Tx gossip between
// nodes is UDP; a 30-tx burst in ~200ms is exactly the pattern that dropped
// datagrams and orphaned nonces. ~8 tx/s still lands a full ladder well
// within a 10s refresh cycle.
const SEND_SPACING_MS = Number(process.env.BOT_SEND_SPACING_MS || 120);

/** Deterministic bot private key for a labelled slot (e.g. "maker", "taker-3"). */
function deriveKey(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${BOT_SEED}:${label}`));
}

/**
 * A self-nonce-managing signing wallet for one bot identity. Talks JSON-RPC
 * directly (global fetch) so it works against http and https RPC URLs.
 */
class BotWallet {
  constructor(rpcUrl, label, privateKey) {
    this.rpcUrl = rpcUrl;
    this.wallet = new ethers.Wallet(privateKey || deriveKey(label));
    this.address = this.wallet.address;
    this.label = label;
    this._nonce = null;
    this._rpcId = 1;
    // Serialize sends so sequential nonces are assigned without races even
    // when callers fire many placeOrder() promises concurrently.
    this._chain = Promise.resolve();
    // Progress tracking for stall detection + read caches.
    this._mined = null;
    this._minedAt = 0;
    this._lastProgressAt = Date.now();
    this._gasPrice = null;
    this._gasPriceAt = 0;
    this._stallResyncs = 0;
    this._skipped = 0;
    this._lastSendAt = 0;
  }

  async rpc(method, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this._rpcId++, method, params }),
        signal: controller.signal,
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Account (mined) nonce, cached briefly. The node's eth_getTransactionCount
   * ignores the block tag and always returns the executed nonce, so this is
   * the ground truth for "how many of our txs actually landed".
   */
  async minedNonce(force = false) {
    const now = Date.now();
    if (!force && this._mined != null && now - this._minedAt < NONCE_CACHE_MS) return this._mined;
    const hex = await this.rpc('eth_getTransactionCount', [this.address, 'latest']);
    const mined = Number(BigInt(hex));
    if (this._mined == null || mined !== this._mined) this._lastProgressAt = now;
    this._mined = mined;
    this._minedAt = now;
    return mined;
  }

  async gasPrice() {
    const now = Date.now();
    if (this._gasPrice != null && now - this._gasPriceAt < GAS_PRICE_CACHE_MS) return this._gasPrice;
    const hex = await this.rpc('eth_gasPrice', []);
    this._gasPrice = BigInt(hex || '0x1');
    this._gasPriceAt = now;
    return this._gasPrice;
  }

  async syncNonce() {
    this._nonce = await this.minedNonce(true);
    return this._nonce;
  }

  /** Snapshot for log lines: account nonce, local nonce, sends skipped, resyncs. */
  stats() {
    return { mined: this._mined, local: this._nonce, skipped: this._skipped, stallResyncs: this._stallResyncs };
  }

  _send(data, gasLimit, to = PRECOMPILE, value = 0n) {
    // Queue behind any in-flight send so nonces stay strictly sequential.
    const run = this._chain.then(async () => {
      if (this._nonce == null) await this.syncNonce();
      // Bounded in-flight WITHOUT resetting the nonce. The local nonce
      // increments on RPC-accept, but the chain includes only a few of this
      // sender's txs per block. If we let it race ahead, later txs become
      // future-nonce and are dropped; if we *reset* it to the mined nonce we
      // re-send nonces that are already in flight/mined (a churn loop that
      // wedges the wallet). Instead, back off: when too many txs are
      // outstanding, skip this send and let the backlog drain.
      const mined = await this.minedNonce();
      if (this._nonce - mined > MAX_INFLIGHT) {
        // ...unless nothing has mined for a while: then the backlog is not
        // draining because it does not exist, and only a resync recovers.
        if (Date.now() - this._lastProgressAt > STALL_RESYNC_MS) {
          const fresh = await this.minedNonce(true);
          if (this._nonce - fresh > MAX_INFLIGHT && Date.now() - this._lastProgressAt > STALL_RESYNC_MS) {
            console.warn(`[${this.label}] nonce stalled: local=${this._nonce} account=${fresh} for ${Math.round((Date.now() - this._lastProgressAt) / 1000)}s — resyncing`);
            this._nonce = fresh;
            this._stallResyncs++;
            this._lastProgressAt = Date.now();
          }
        }
        if (this._nonce - mined > MAX_INFLIGHT) {
          // Drop this order silently; the caller treats a null hash as "not
          // placed" and the next cycle retries once the chain catches up.
          this._skipped++;
          return null;
        }
      }
      const gasPrice = await this.gasPrice();
      const wait = this._lastSendAt + SEND_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastSendAt = Date.now();
      const tx = {
        type: 0,
        to,
        data,
        nonce: this._nonce,
        gasLimit: BigInt(gasLimit),
        gasPrice,
        chainId: CHAIN_ID,
        value,
      };
      const raw = await this.wallet.signTransaction(tx);
      try {
        const hash = await this.rpc('eth_sendRawTransaction', [raw]);
        this._nonce++;
        return hash;
      } catch (e) {
        // On a nonce error, resync so the next attempt recovers.
        if (/nonce|already known|replacement/i.test(e.message || '')) this._nonce = null;
        throw e;
      }
    });
    // Keep the queue alive regardless of this send's outcome.
    this._chain = run.then(() => undefined, () => undefined);
    return run;
  }

  placeOrder(marketId, side, price, size, tif = 'gtc') {
    const data = IFACE.encodeFunctionData('placeOrder', [
      marketId,
      side === 'buy' || side === 'Buy',
      BigInt(Math.max(1, Math.round(price))),
      BigInt(Math.max(1, Math.round(size))),
      TIF_CODE[tif] ?? 0,
    ]);
    return this._send(data, 300_000);
  }

  cancelOrder(orderId) {
    const id = typeof orderId === 'string' && orderId.startsWith('0x') ? BigInt(orderId) : BigInt(orderId);
    const data = IFACE.encodeFunctionData('cancelOrder', [id]);
    return this._send(data, 200_000);
  }

  depositCollateral(amount) {
    const data = IFACE.encodeFunctionData('depositCollateral', [BigInt(amount)]);
    return this._send(data, 200_000);
  }

  /** Plain native transfer (funding another bot wallet). */
  sendValue(to, wei) {
    return this._send('0x', 21_000, to, BigInt(wei));
  }

  /** This wallet's CLOB collateral in units (wei before the settlement switch, MRSN after). */
  async getCollateral() {
    const data = IFACE.encodeFunctionData('getCollateral', []);
    const out = await this.rpc('eth_call', [{ from: this.address, to: PRECOMPILE, data, gas: '0x30000' }, 'latest']);
    if (!out || out === '0x') return 0n;
    return BigInt(out);
  }

  /** Native balance in wei. */
  async balance() {
    const out = await this.rpc('eth_getBalance', [this.address, 'latest']);
    return BigInt(out || '0x0');
  }
}

module.exports = { BotWallet, deriveKey, PRECOMPILE, CHAIN_ID, BOT_SEED };
