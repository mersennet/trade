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
  // Live ETAs by height for `{eta:<height>}` tokens in announcement copy, so
  // the bar never states a time the schedule has drifted away from.
  const [etas, setEtas] = useState<Record<number, string>>({});
  // Wait for the first /protocol answer (or 2.5 s) before rendering, so a
  // lower-priority entry does not flash and get replaced a moment later.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      api.getProtocol().then((p) => { if (alive) setProtocol(p); }),
      api.getProtocolSwitches().then((s) => {
        if (!alive) return;
        const m: Record<number, string> = {};
        for (const sw of s.switches) m[sw.height] = sw.etaAt;
        setEtas(m);
      }).catch(() => {}),
    ]).finally(() => { if (alive) setSettled(true); });
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
  // "{eta:1605600}" → "Sun 20 Sep, 16:23 UTC (live estimate)"; falls back to "block 1,605,600" when no ETA is known.
  const withEtas = (text: string) => text.replace(/\{eta:(\d+)\}/g, (_m, h: string) => {
    const iso = etas[Number(h)];
    if (!iso) return `block ${Number(h).toLocaleString()}`;
    const when = new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `${when} UTC (live estimate, block ${Number(h).toLocaleString()})`;
  });

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
      <p className="text-muted truncate">{withEtas(current.text)}</p>
      {current.link && (
        <Link href={current.link.href} className="text-primary-bright font-semibold uppercase tracking-[0.08em] text-[10px] hover:underline shrink-0">
          {current.link.label} →
        </Link>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="absolute right-1 top-1/2 -translate-y-1/2 min-w-6 min-h-6 flex items-center justify-center text-dim hover:text-foreground transition-colors text-sm"
      >×</button>
    </div>
  );
}
