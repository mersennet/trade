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
    <div className="bg-primary/[0.06] border-b border-primary/15 px-3 md:px-4 py-1.5 flex items-center justify-center gap-2 text-[11px] relative">
      <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
      <p className="text-foreground/80 truncate">{current.text}</p>
      {current.link && (
        <Link href={current.link.href} className="text-primary font-medium hover:underline shrink-0">
          {current.link.label}
        </Link>
      )}
      {active.length > 1 && (
        <span className="text-[9px] text-dim font-mono shrink-0">{index % active.length + 1}/{active.length}</span>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="absolute right-2 text-dim hover:text-foreground transition-colors text-xs px-1"
      >×</button>
    </div>
  );
}
