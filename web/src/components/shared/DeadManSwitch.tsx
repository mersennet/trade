'use client';
import { useEffect } from 'react';
import { useStore } from '@/stores/useStore';
import { API_BASE } from '@/lib/api';

// Cancels all of the user's resting orders when they leave the app (tab close,
// navigation away, or the page being backgrounded/frozen). It deliberately does
// NOT cancel on mere inactivity — a trader reading the screen must keep their
// resting orders. The beacon goes to the same-origin API so it isn't blocked as
// mixed content on the https deployment.
export default function DeadManSwitch() {
  const deadManEnabled = useStore((s) => s.deadManEnabled);
  const address = useStore((s) => s.wallet.address);

  useEffect(() => {
    if (!deadManEnabled || !address) return;

    const cancelAll = () => {
      const url = `${API_BASE}/orders/cancel-all/${address}`;
      const blob = new Blob([JSON.stringify({ owner: address })], { type: 'application/json' });
      // sendBeacon survives unload; fall back to keepalive fetch otherwise.
      if (!navigator.sendBeacon?.(url, blob)) {
        fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
      }
    };

    // pagehide fires on tab close and navigation away (not on tab switch), so
    // resting orders are cancelled when the user actually leaves the app.
    const onPageHide = () => cancelAll();
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [deadManEnabled, address]);

  return null;
}
