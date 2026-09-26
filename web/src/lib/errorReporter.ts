/**
 * Client error reporting. Uncaught exceptions, unhandled promise rejections
 * and error-boundary hits are posted to the API (`/client-errors`), which
 * stores them and forwards de-duplicated alerts to the ops Telegram group.
 * Bounded: at most 5 reports per page load, identical messages once.
 */
import { API_BASE } from './api';

const sent = new Set<string>();
let budget = 5;
let installed = false;

function wallet(): string | undefined {
  try {
    const raw = localStorage.getItem('mersennet-trade-store');
    const j = raw ? JSON.parse(raw) : null;
    const a = j?.state?.wallet?.address;
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a : undefined;
  } catch { return undefined; }
}

export function reportClientError(err: unknown, kind: 'error' | 'unhandledrejection' | 'boundary' = 'error') {
  try {
    if (budget <= 0) return;
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err).slice(0, 300));
    const message = `${e.name}: ${e.message}`.slice(0, 500);
    if (sent.has(message)) return;
    sent.add(message);
    budget -= 1;
    const body = JSON.stringify({
      message,
      stack: e.stack?.slice(0, 4000),
      page: typeof location !== 'undefined' ? location.pathname + location.search : undefined,
      kind,
      build: process.env.NEXT_PUBLIC_BUILD_SHA || undefined,
      wallet: wallet(),
    });
    // sendBeacon survives page unloads (the common case for fatal errors).
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(`${API_BASE}/client-errors`, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(`${API_BASE}/client-errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never let the reporter throw */ }
}

/** Install the global handlers once (idempotent). */
export function installErrorReporter() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    // Resource load failures (img/script) arrive here without an Error; skip them.
    if (ev.error) reportClientError(ev.error, 'error');
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    // Wallet rejections are user actions, not bugs.
    if (r && /user (rejected|denied)|ACTION_REJECTED/i.test(String((r as Error).message || r))) return;
    // @walletconnect/ethereum-provider's setChainId() fires switchEthereumChain()
    // without awaiting it; with a stale or half-restored session the request
    // hits an undefined rpc provider ("Cannot read properties of undefined
    // (reading 'request')"). Nothing of ours is on that stack and nothing is
    // broken for the user — log locally, do not page the ops group.
    const stack = String((r as Error)?.stack || '');
    if (/switchEthereumChain/.test(stack) && /reading 'request'/.test(String((r as Error)?.message || ''))) {
      console.warn('[walletconnect] internal switchEthereumChain rejection ignored', r);
      return;
    }
    reportClientError(r, 'unhandledrejection');
  });
}
