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

const IFACE = new ethers.utils.Interface([
  'function placeOrder(uint64 marketId, bool isBuy, uint256 price, uint256 size, uint8 tif) returns (uint256, uint256, uint256)',
  'function cancelOrder(uint256 orderId) returns (bool)',
  'function depositCollateral(uint256 amount) returns (bool)',
]);

const TIF_CODE = { gtc: 0, ioc: 1, fok: 2, Gtc: 0, Ioc: 1, Fok: 2 };

/** Deterministic bot private key for a labelled slot (e.g. "maker", "taker-3"). */
function deriveKey(label) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${BOT_SEED}:${label}`));
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

  async syncNonce() {
    const hex = await this.rpc('eth_getTransactionCount', [this.address, 'pending']);
    this._nonce = Number(BigInt(hex));
    return this._nonce;
  }

  _send(data, gasLimit) {
    // Queue behind any in-flight send so nonces stay strictly sequential.
    const run = this._chain.then(async () => {
      if (this._nonce == null) await this.syncNonce();
      const gasPriceHex = await this.rpc('eth_gasPrice', []);
      const tx = {
        to: PRECOMPILE,
        data,
        nonce: this._nonce,
        gasLimit: ethers.BigNumber.from(gasLimit),
        gasPrice: ethers.BigNumber.from(gasPriceHex || '0x1'),
        chainId: CHAIN_ID,
        value: 0,
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
}

module.exports = { BotWallet, deriveKey, PRECOMPILE, CHAIN_ID, BOT_SEED };
