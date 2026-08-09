'use client';
import { useEffect, useRef } from 'react';
import { useStore } from '@/stores/useStore';

/**
 * Client-side price alerts: when the mark crosses a target, fire a browser
 * notification (permission permitting) plus an entry in the notification
 * center, then remove the alert so it only fires once.
 */
export function usePriceAlerts() {
  const tickers = useStore((s) => s.tickers);
  const alerts = useStore((s) => s.priceAlerts);
  const removePriceAlert = useStore((s) => s.removePriceAlert);
  const firedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (alerts.length === 0) return;
    for (const a of alerts) {
      if (firedRef.current.has(a.id)) continue;
      const mark = tickers[a.marketId]?.markPrice;
      if (!mark) continue;
      const hit = a.direction === 'above' ? mark >= a.price : mark <= a.price;
      if (!hit) continue;

      firedRef.current.add(a.id);
      const title = `Price alert: market ${a.marketId}`;
      const body = `Mark ${mark} crossed ${a.direction} ${a.price}`;
      useStore.getState().addNotification('info', title, body);

      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          try { new Notification(title, { body }); } catch { /* unsupported */ }
        }
      }
      removePriceAlert(a.id);
    }
  }, [tickers, alerts, removePriceAlert]);
}

/** Ask for browser-notification permission (call from the alert UI on set). */
export function ensureNotificationPermission() {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}
