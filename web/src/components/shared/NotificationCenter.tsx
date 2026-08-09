'use client';
import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import EmptyState from '@/components/shared/EmptyState';
import { useStore, type AppNotification } from '@/stores/useStore';

type Notification = AppNotification;

/** Shared notification feed backed by the global store — any part of the app
 * (order fills, bracket fires, transfers) can publish via
 * `useStore.getState().addNotification(...)` and the bell reflects it. */
export function useNotifications() {
  const notifications = useStore((s) => s.notifications);
  const addNotification = useStore((s) => s.addNotification);
  const markAllRead = useStore((s) => s.markAllRead);
  const clearAll = useStore((s) => s.clearAllNotifications);
  const unreadCount = notifications.filter((n) => !n.read).length;
  return { notifications, addNotification, markAllRead, clearAll, unreadCount };
}

export default function NotificationCenter() {
  const { notifications, markAllRead, clearAll, unreadCount } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const typeIcon = (type: Notification['type']) => {
    switch (type) {
      case 'fill': return '✓';
      case 'liquidation': return '⚠';
      case 'warning': return '!';
      default: return 'i';
    }
  };

  const typeColor = (type: Notification['type']) => {
    switch (type) {
      case 'fill': return 'text-green bg-green/10';
      case 'liquidation': return 'text-red bg-red/10';
      case 'warning': return 'text-yellow bg-yellow/10';
      default: return 'text-primary bg-primary/10';
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(!open); if (!open) markAllRead(); }}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative p-2 text-dim hover:text-foreground transition-colors rounded-lg hover:bg-surface-2"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red rounded-full text-[9px] text-white font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-80 bg-surface border border-border rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-xs font-medium text-foreground uppercase tracking-wider">Notifications</h3>
            {notifications.length > 0 && (
              <button onClick={clearAll} className="text-[10px] text-dim hover:text-red transition-colors">
                Clear all
              </button>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto">
            {notifications.length > 0 ? notifications.map((n) => (
              <div key={n.id} className={cn('px-4 py-3 border-b border-border/50 transition-colors', !n.read && 'bg-primary/[0.03]')}>
                <div className="flex items-start gap-2.5">
                  <span className={cn('w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5', typeColor(n.type))}>
                    {typeIcon(n.type)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground">{n.title}</p>
                    <p className="text-[10px] text-dim mt-0.5 truncate">{n.message}</p>
                    <p className="text-[9px] text-dim/50 font-mono mt-1">{new Date(n.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>
              </div>
            )) : (
              <EmptyState
                label="No notifications"
                hint="Fills and liquidation alerts will land here"
                compact
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
