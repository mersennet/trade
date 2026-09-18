'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ANNOUNCEMENTS } from '@/config/announcements';
import { api, type ClobProtocol } from '@/lib/api';
import { startPoll } from '@/lib/poll';

/**
 * Announcement line under the header. Shows the newest undismissed entry
 * from config/announcements.ts; dismissing it reveals the next one. It does
 * not rotate — a strip that changes every few seconds on a trading screen
 * pulls the eye away from the book for no reason.
 */
export default function AnnouncementBar() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // Live protocol state drives the switch-related entries (see showWhen).
  const [protocol, setProtocol] = useState<ClobProtocol | null>(null);
  // Wait for the first /protocol answer (or 2.5 s) before rendering, so a
  // lower-priority entry does not flash and get replaced a moment later.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api.getProtocol().then((p) => { if (alive) setProtocol(p); }).finally(() => { if (alive) setSettled(true); });
    load().catch(() => {});
    const t = setTimeout(() => { if (alive) setSettled(true); }, 2500);
    const stop = startPoll(load, 60_000);
    return () => { alive = false; stop(); clearTimeout(t); };
  }, []);

  useEffect(() => {
    try {
      setDismissed(JSON.parse(localStorage.getItem('mersennet-trade_announcements_dismissed') || '[]'));
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const active = ANNOUNCEMENTS.filter((a) => !dismissed.includes(a.id) && (a.showWhen ? a.showWhen(protocol) : true));

  if (!hydrated || !settled || active.length === 0) return null;
  const current = active[0];

  const dismiss = () => {
    const next = [...dismissed, current.id];
    setDismissed(next);
    localStorage.setItem('mersennet-trade_announcements_dismissed', JSON.stringify(next));
  };

  return (
    // Terminal system-message line: left-aligned, prompt-prefixed, quiet.
    <div className="bg-surface border-b border-border px-3 md:px-4 py-1.5 flex items-center gap-2 text-[10.5px] relative">
      <span className="text-primary font-bold shrink-0 select-none">&gt;&gt;</span>
      <p className="text-muted truncate">{current.text}</p>
      {current.link && (
        <Link href={current.link.href} className="text-primary-bright font-semibold uppercase tracking-[0.08em] text-[10px] hover:underline shrink-0">
          {current.link.label} →
        </Link>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="absolute right-2 text-dim hover:text-foreground transition-colors text-xs px-1"
      >×</button>
    </div>
  );
}
