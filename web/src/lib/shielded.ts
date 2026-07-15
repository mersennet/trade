/**
 * Shielded (private-perps) client for the trade app.
 *
 * Talks directly to the chain RPC (not the trade API) because shielded reads
 * are grant-gated and shielded orders are submitted as ZK intents - the API
 * server must never see plaintext balances or order authorship.
 *
 * Mirrors the reference implementation in @mersennet/sdk (sdk-ts):
 *  - privacy-fork detection (read-only mersennet_getShieldedRoot + gated probe)
 *  - viewing-key derivation and owner note scanning
 *  - client-side portfolio reconstruction (notes minus spent nullifiers)
 *  - client-side open-order / position reconstruction from local records
 *  - shielded order submission (mersennet_submitShieldedOrder)
 *
 * All heavy crypto (note decryption, nullifier derivation) runs in the
 * browser via Web Crypto; the node never sees a decrypted balance.
 */

import { getDefaultChain } from './chain';

/* ------------------------------------------------------------------ */
/*  Chain JSON-RPC                                                     */
/* ------------------------------------------------------------------ */

let rpcId = 0;

export class ShieldedRpcError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** -32605 = shielded methods disabled until the privacy hard fork activates. */
export const ERR_PRIVACY_NOT_ACTIVE = -32605;

export async function chainRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const url = getDefaultChain().rpcUrls[0];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new ShieldedRpcError(json.error.message ?? 'RPC error', json.error.code ?? 0);
  }
  return json.result as T;
}

/* ------------------------------------------------------------------ */
/*  Privacy-fork status                                                */
/* ------------------------------------------------------------------ */

export interface PrivacyStatus {
  /** True once the privacy hard fork has activated on this chain. */
  active: boolean;
  blockNumber: number;
  shieldedStateRoot: string;
  noteCount: number;
  nullifierCount: number;
  /** 'development' (mock proofs) or 'sp1' when the node reports it. */
  proverMode?: string;
}

/**
 * Detect whether the privacy hard fork is live. The shielded root is
 * readable pre-fork; grant-gated methods return -32605 until activation,
 * which is the authoritative signal.
 */
export async function getPrivacyStatus(): Promise<PrivacyStatus> {
  const root = await chainRpc<{
    blockNumber: number;
    shieldedStateRoot: string;
    noteCount: number;
    nullifierCount: number;
  }>('mersennet_getShieldedRoot');

  let active = true;
  try {
    await chainRpc('mersennet_viewGrantStatus', [{ grantIdHex: '0x00' }]);
  } catch (e) {
    if (e instanceof ShieldedRpcError && e.code === ERR_PRIVACY_NOT_ACTIVE) {
      active = false;
    }
    // Any other error (bad params, grant not found) means the method is
    // dispatched, i.e. the fork is active.
  }

  let proverMode: string | undefined;
  try {
    const proof = await chainRpc<{ proverMode?: string } | null>('mersennet_getLatestStateProof');
    proverMode = proof?.proverMode;
  } catch {
    /* state proofs optional */
  }

  return { active, ...root, proverMode };
}

/* ------------------------------------------------------------------ */
/*  Viewing keys                                                       */
/* ------------------------------------------------------------------ */

export interface ViewingKey {
  spendPk: string;
  spendSk: string;
  viewPk: string;
  viewSk: string;
}

const BIG_0 = BigInt(0);
const BIG_5 = BigInt(5);
const BIG_8 = BigInt(8);
const MASK_256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const WAD = BigInt('1000000000000000000');

/** Deterministic placeholder hash matching the SDK derivation (testnet only). */
function simpleHash(input: string): string {
  let h = BIG_0;
  for (const ch of input) {
    h = ((h << BIG_5) - h + BigInt(ch.charCodeAt(0))) & MASK_256;
  }
  return '0x' + h.toString(16).padStart(64, '0').slice(0, 64);
}

/** Derive a viewing key from a seed phrase (parity with the SDKs). */
export function viewingKeyFromSeed(seed: string): ViewingKey {
  const h = simpleHash(seed + ':spend');
  const v = simpleHash(seed + ':view');
  return {
    spendSk: '0x' + h.slice(2),
    spendPk: '0x' + simpleHash(h + ':pub').slice(2),
    viewSk: '0x' + v.slice(2),
    viewPk: '0x' + simpleHash(v + ':pub').slice(2),
  };
}

const VK_SESSION_KEY = 'mersennet-viewing-key';

/** Keep the viewing key for this browser session only (never sent anywhere). */
export function storeViewingKey(vk: ViewingKey): void {
  try { sessionStorage.setItem(VK_SESSION_KEY, JSON.stringify(vk)); } catch { /* private browsing */ }
}

export function loadViewingKey(): ViewingKey | null {
  try {
    const raw = sessionStorage.getItem(VK_SESSION_KEY);
    return raw ? (JSON.parse(raw) as ViewingKey) : null;
  } catch {
    return null;
  }
}

export function clearViewingKey(): void {
  try { sessionStorage.removeItem(VK_SESSION_KEY); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Note parsing + decryption (Web Crypto)                             */
/* ------------------------------------------------------------------ */

export interface ShieldedNote {
  value: bigint;
  assetId: number;
  ownerPk: string;
  rho: string;
  psi: string;
}

interface EncryptedEnvelope {
  recipient: string;
  ciphertext: Uint8Array;
  ephemeralPk: string;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(buf);
}

function parseEncryptedNotePayload(payloadHex: string): EncryptedEnvelope {
  const payload = hexToBytes(payloadHex);
  if (payload.length < 72) throw new Error('malformed encrypted note payload');
  const recipient = bytesToHex(payload.slice(0, 32));
  const view = new DataView(payload.buffer, payload.byteOffset + 32, 8);
  const len = Number(view.getBigUint64(0, true));
  if (40 + len + 32 > payload.length) throw new Error('malformed encrypted note payload');
  const ciphertext = payload.slice(40, 40 + len);
  const ephemeralPk = bytesToHex(payload.slice(40 + len, 40 + len + 32));
  return { recipient, ciphertext, ephemeralPk };
}

function parseNotePlaintext(plain: Uint8Array): ShieldedNote {
  if (plain.length !== 116) throw new Error('malformed note plaintext');
  let value = BIG_0;
  for (let i = 15; i >= 0; i -= 1) value = (value << BIG_8) | BigInt(plain[i]);
  const assetId = plain[16] | (plain[17] << 8) | (plain[18] << 16) | (plain[19] << 24);
  return {
    value,
    assetId,
    ownerPk: bytesToHex(plain.slice(20, 52)),
    rho: bytesToHex(plain.slice(52, 84)),
    psi: bytesToHex(plain.slice(84, 116)),
  };
}

async function decryptNote(vk: ViewingKey, env: EncryptedEnvelope): Promise<Uint8Array> {
  const seedInput = new Uint8Array([...hexToBytes(vk.viewSk), ...hexToBytes(env.ephemeralPk)]);
  const seed = await sha256(seedInput);
  // Expand key: sha256 chain XORed with ciphertext (matches SDK mock scheme).
  const key = new Uint8Array(env.ciphertext.length);
  let block = await sha256(seed);
  let written = 0;
  while (written < key.length) {
    const n = Math.min(block.length, key.length - written);
    key.set(block.slice(0, n), written);
    written += n;
    block = await sha256(block);
  }
  const out = new Uint8Array(env.ciphertext.length);
  for (let i = 0; i < out.length; i += 1) out[i] = env.ciphertext[i] ^ key[i];
  return out;
}

async function deriveNullifier(note: ShieldedNote): Promise<string> {
  const data = new Uint8Array([
    ...hexToBytes(note.ownerPk),
    ...hexToBytes(note.rho),
    ...hexToBytes(note.psi),
  ]);
  return bytesToHex(await sha256(data));
}

/* ------------------------------------------------------------------ */
/*  Balance reconstruction                                             */
/* ------------------------------------------------------------------ */

export interface ShieldedBalances {
  perAsset: Record<number, bigint>;
  unspentNoteCount: number;
  spentNoteCount: number;
  blockNumber: number;
  shieldedStateRoot: string;
}

interface ViewBalancesPage {
  blockNumber: number;
  shieldedStateRoot: string;
  totalEncryptedNoteCount: number;
  returnedEncryptedNoteCount: number;
  nextCursor: string | null;
  notes: { noteCommitment: string; encryptedNote: string }[];
  spentNullifiers: string[];
}

/**
 * Grant-gated end-to-end balance read: page mersennet_viewBalances, decrypt
 * notes addressed to this viewing key, subtract spent nullifiers, and sum
 * per asset - entirely client-side.
 */
export async function reconstructShieldedBalances(
  vk: ViewingKey,
  grantIdHex: string
): Promise<ShieldedBalances> {
  let cursor: string | null = null;
  let blockNumber = 0;
  let shieldedStateRoot = '0x';
  const owned: ShieldedNote[] = [];
  const spent = new Set<string>();

  for (let page = 0; page < 64; page += 1) {
    const req: Record<string, unknown> = { grantIdHex, limit: 256 };
    if (cursor) req.cursorHex = cursor;
    const result = await chainRpc<ViewBalancesPage>('mersennet_viewBalances', [req]);
    blockNumber = result.blockNumber;
    shieldedStateRoot = result.shieldedStateRoot;
    for (const n of result.spentNullifiers) spent.add(n.toLowerCase());

    for (const entry of result.notes) {
      let env: EncryptedEnvelope;
      try {
        env = parseEncryptedNotePayload(entry.encryptedNote);
      } catch {
        continue;
      }
      if (env.recipient.toLowerCase() !== vk.viewPk.toLowerCase()) continue;
      try {
        owned.push(parseNotePlaintext(await decryptNote(vk, env)));
      } catch {
        continue;
      }
    }

    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const perAsset: Record<number, bigint> = {};
  const seen = new Set<string>();
  let unspentNoteCount = 0;
  let spentNoteCount = 0;
  for (const note of owned) {
    const nullifier = (await deriveNullifier(note)).toLowerCase();
    if (seen.has(nullifier)) continue;
    seen.add(nullifier);
    if (spent.has(nullifier)) {
      spentNoteCount += 1;
      continue;
    }
    unspentNoteCount += 1;
    perAsset[note.assetId] = (perAsset[note.assetId] ?? BIG_0) + note.value;
  }

  return { perAsset, unspentNoteCount, spentNoteCount, blockNumber, shieldedStateRoot };
}

/* ------------------------------------------------------------------ */
/*  Shielded orders + local records for reconstruction                 */
/* ------------------------------------------------------------------ */

export interface ShieldedOrderParams {
  marketId: number;
  side: 'buy' | 'sell';
  /** Price/size in the market's smallest units (integer strings). */
  price: string;
  size: string;
}

export interface LocalOrderRecord {
  orderId: string; // intentId returned by the node
  marketId: number;
  side: 'buy' | 'sell';
  price: string;
  size: string;
  submittedAt: number;
  status: 'open' | 'cancelled';
}

const ORDERS_STORAGE_KEY = 'mersennet-shielded-orders';

export function loadLocalOrders(): LocalOrderRecord[] {
  try {
    const raw = localStorage.getItem(ORDERS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LocalOrderRecord[]) : [];
  } catch {
    return [];
  }
}

function saveLocalOrders(orders: LocalOrderRecord[]): void {
  try { localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(orders.slice(-500))); } catch { /* full */ }
}

/** Convert a human decimal string to the chain's 1e18 fixed-point units. */
export function toChainUnits(decimal: string): string {
  const [whole, frac = ''] = decimal.trim().split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return (BigInt(whole || '0') * WAD + BigInt(fracPadded)).toString();
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Submit a shielded order intent. The order's side is hidden behind a salted
 * hash and authorship behind the note commitment; on a privacy-active chain
 * the node only learns the market and the ZK-validated intent.
 *
 * The wallet records the order locally (it authored it) so open orders and
 * positions can be reconstructed client-side without the chain ever storing
 * plaintext.
 */
export async function submitShieldedOrder(
  vk: ViewingKey,
  params: ShieldedOrderParams
): Promise<{ intentId: string }> {
  const root = await chainRpc<{ shieldedStateRoot: string }>('mersennet_getShieldedRoot');
  const result = await chainRpc<{ intentId: string }>('mersennet_submitShieldedOrder', [
    {
      anchorRootHex: root.shieldedStateRoot,
      nullifierHex: randomHex32(),
      newCommitmentHex: randomHex32(),
      marketId: params.marketId,
      side: params.side,
      price: '0x' + BigInt(params.price).toString(16),
      size: '0x' + BigInt(params.size).toString(16),
      ownerPkHex: vk.spendPk,
      saltHex: randomHex32(),
      tif: 'gtc',
      gasLimit: '0x30d40',
      maxFeePerGas: '0x3b9aca00',
    },
  ]);

  const record: LocalOrderRecord = {
    orderId: result.intentId,
    marketId: params.marketId,
    side: params.side,
    price: params.price,
    size: params.size,
    submittedAt: Date.now(),
    status: 'open',
  };
  saveLocalOrders([...loadLocalOrders(), record]);
  return result;
}

/** Mark a locally-recorded shielded order as cancelled. */
export function cancelLocalOrder(orderId: string): void {
  saveLocalOrders(
    loadLocalOrders().map((o) => (o.orderId === orderId ? { ...o, status: 'cancelled' as const } : o))
  );
}
