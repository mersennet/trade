// Referral / builder-code capture.
//
// A shared link looks like https://trade.mersennet.com/?ref=<code>. When a
// visitor lands with that param we persist the code locally so it can be
// attached as `builder_code` to the orders they later submit — which is the
// only thing the API credits (orders.js UPDATE builder_codes ...). Without
// this capture the referrals page counters stay 0 forever.

const REF_KEY = 'pt_builder_ref';

/** Read the ?ref= param on load and persist it. Safe to call repeatedly. */
export function captureRefFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref && ref.trim()) {
      localStorage.setItem(REF_KEY, ref.trim());
    }
  } catch { /* ignore */ }
}

/** The builder code captured from a referral link, if any. */
export function getReferralCode(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(REF_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}
