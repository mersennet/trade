'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ANNOUNCEMENTS } from '@/config/announcements';

/**
 * Rotating announcement strip under the header (edgeX-style release
 * merchandising). Each announcement is dismissible on its own; the list is
 * content-driven from config/announcements.ts.
 */
export default function AnnouncementBar() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setDismissed(JSON.parse(localStorage.getItem('mersennet-trade_announcements_dismissed') || '[]'));
    } catch { /* ignore */ }
    setHydrated(true);
  }, []);

  const active = ANNOUNCEMENTS.filter((a) => !dismissed.includes(a.id));

  useEffect(() => {
    if (active.length < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % active.length), 6000);
    return () => clearInterval(t);
  }, [active.length]);

  if (!hydrated || active.length === 0) return null;
  const current = active[index % active.length];

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
      {active.length > 1 && (
        <span className="text-[9px] text-dim shrink-0">{index % active.length + 1}/{active.length}</span>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="absolute right-2 text-dim hover:text-foreground transition-colors text-xs px-1"
      >×</button>
    </div>
  );
}
