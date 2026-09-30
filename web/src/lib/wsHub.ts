'use client';
import { createWsConnection } from './api';

// One WebSocket per tab, shared by every component. The order book, market
// bar, status line and chart used to open one each (4-5 per visitor on
// /trade), against a cap of 5,000 connections per API host.

type Handler = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const DATA_TYPES = new Set(['ticker', 'orderbook', 'trade', 'newBlock']);
// Leaving one page and mounting the next unsubscribes everything for a moment:
// keep the socket that long instead of reconnecting on every navigation.
const LINGER_MS = 15_000;

const handlers = new Map<string, Set<Handler>>();
const statusListeners = new Set<(connected: boolean) => void>();
let ws: WebSocket | null = null;
let connected = false;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;

const wanted = () => handlers.size > 0 || statusListeners.size > 0;

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  statusListeners.forEach((l) => l(value));
}

function send(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// API builds from before messages named their channel.
function channelsByType(data: { type: string; marketId?: number; taker?: string; maker?: string }): string[] {
  switch (data.type) {
    case 'ticker': return [`ticker:${data.marketId}`];
    case 'orderbook': return [`orderbook:${data.marketId}`];
    case 'newBlock': return ['blocks'];
    case 'trade': return [
      `trades:${data.marketId}`,
      ...[data.taker, data.maker].filter(Boolean).map((a) => `trades:followed:${String(a).toLowerCase()}`),
    ];
    default: return [];
  }
}

function connect() {
  if (ws || retryTimer || !wanted() || typeof window === 'undefined') return;
  const sock = createWsConnection();
  ws = sock;
  sock.onopen = () => {
    attempts = 0;
    setConnected(true);
    for (const channel of handlers.keys()) send({ action: 'subscribe', channel });
  };
  sock.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (!data || !DATA_TYPES.has(data.type)) return;
    const targets = typeof data.channel === 'string' ? [data.channel] : channelsByType(data);
    for (const channel of targets) {
      handlers.get(channel)?.forEach((h) => { try { h(data); } catch { /* one consumer's bug stays its own */ } });
    }
  };
  sock.onclose = () => {
    // A socket closed after a quiet spell can report in after its replacement opened.
    if (ws !== sock) return;
    ws = null;
    setConnected(false);
    if (!wanted()) return;
    // Capped exponential backoff with jitter, so a restarted API host is not
    // met by every tab reconnecting in the same second.
    const delay = Math.min(1000 * 2 ** attempts, 30_000) * (0.75 + Math.random() * 0.5);
    attempts += 1;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
  sock.onerror = () => sock.close();
}

function release() {
  if (wanted() || lingerTimer) return;
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    if (wanted()) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const sock = ws;
    ws = null;
    sock?.close();
    setConnected(false);
  }, LINGER_MS);
}

function acquire() {
  if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
  connect();
}

/** Receive the messages of `channel`; returns the unsubscribe function. */
export function subscribe(channel: string, handler: Handler): () => void {
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    send({ action: 'subscribe', channel });
  }
  set.add(handler);
  acquire();
  return () => {
    const current = handlers.get(channel);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      handlers.delete(channel);
      send({ action: 'unsubscribe', channel });
    }
    release();
  };
}

/** Follow the connection state (and keep the socket open while listening). */
export function onStatus(listener: (connected: boolean) => void): () => void {
  statusListeners.add(listener);
  listener(connected);
  acquire();
  return () => {
    statusListeners.delete(listener);
    release();
  };
}
