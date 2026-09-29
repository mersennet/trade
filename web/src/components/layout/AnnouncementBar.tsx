'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ANNOUNCEMENTS } from '@/config/announcements';
import { api, type ClobProtocol } from '@/lib/api';
import { startPoll } from '@/lib/poll';
import { formatUtcShort } from '@/lib/utils';

/**
 * Incident notice written by ops/deploy/incident.sh: a static file Caddy
 * serves on this origin, so it answers even while the API is down.
 */
interface IncidentNotice {
  active: boolean;
  id: string;
  severity: 'danger' | 'warning' | 'info';
  title: string;
  text: string;
  since: string;
  link?: string;
}

const INCIDENT_TONE: Record<IncidentNotice['severity'], { line: string; text: string }> = {
  danger: { line: 'bg-red/10 border-red/50', text: 'text-red' },
  warning: { line: 'bg-yellow/10 border-yellow/40', text: 'text-yellow' },
  info: { line: 'bg-surface border-border', text: 'text-cyan' },
};

async function fetchIncident(): Promise<IncidentNotice | null> {
  // ?notice=preview shows what `incident.sh --preview` staged, to nobody else.
  const preview = new URLSearchParams(window.location.search).get('notice') === 'preview';
  const r = await fetch(preview ? '/status/notice-preview.json' : '/status/notice.json', { cache: 'no-store' });
  if (!r.ok) return null;
  const n = (await r.json()) as Partial<IncidentNotice>;
  return n.active && n.id && n.title && n.text && n.severity && n.severity in INCIDENT_TONE
    ? (n as IncidentNotice)
    : null;
}

/**
 * Announcement line under the header. An active incident notice comes first;
 * otherwise it shows the newest undismissed entry from
 * config/announcements.ts, and dismissing it reveals the next one. It does
 * not rotate — a strip that changes every few seconds on a trading screen
 * pulls the eye away from the book for no reason.
 */
export default function AnnouncementBar() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // Live protocol state drives the switch-related entries (see showWhen).
  const [protocol, setProtocol] = useState<ClobProtocol | null>(null);
  const [incident, setIncident] = useState<IncidentNotice | null>(null);
  // Live ETAs by height for `{eta:<height>}` tokens in announcement copy, so
  // the bar never states a time the schedule has drifted away from.
  const [etas, setEtas] = useState<Record<number, string>>({});
  // Wait for the first /protocol answer (or 2.5 s) before rendering, so a
  // lower-priority entry does not flash and get replaced a moment later.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      fetchIncident().then((n) => { if (alive) setIncident(n); }).catch(() => {}),
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
  // "{eta:1605600}" → "Sun 20 Sep, 16:23 UTC (live estimate, block 1,605,600)"; falls back to "block 1,605,600" when no ETA is known.
  const withEtas = (text: string) => text.replace(/\{eta:(\d+)\}/g, (_m, h: string) => {
    const iso = etas[Number(h)];
    if (!iso) return `block ${Number(h).toLocaleString()}`;
    const when = formatUtcShort(iso);
    return `${when} UTC (live estimate, block ${Number(h).toLocaleString()})`;
  });

  const dismissId = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    localStorage.setItem('mersennet-trade_announcements_dismissed', JSON.stringify(next));
  };

  if (!hydrated || !settled) return null;

  if (incident && !dismissed.includes(incident.id)) {
    const tone = INCIDENT_TONE[incident.severity];
    return (
      <div className={`${tone.line} border-b px-3 md:px-4 py-1.5 pr-8 flex items-start gap-2 text-[10.5px] relative`} role="status">
        <span className={`${tone.text} font-bold shrink-0 select-none`}>!!</span>
        <p className="text-foreground leading-snug">
          <span className={`${tone.text} font-bold uppercase tracking-[0.08em] text-[10px] mr-2`}>{incident.title}</span>
          {incident.text}
          <span className="text-dim"> Posted {formatUtcShort(incident.since)} UTC.</span>
          <a
            href={incident.link || 'https://status.mersennet.com'}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 text-primary-bright font-semibold uppercase tracking-[0.08em] text-[10px] hover:underline whitespace-nowrap"
          >
            Live status →
          </a>
        </p>
        <button
          onClick={() => dismissId(incident.id)}
          aria-label="Dismiss incident notice"
          className="absolute right-1 top-1/2 -translate-y-1/2 min-w-6 min-h-6 flex items-center justify-center text-dim hover:text-foreground transition-colors text-sm"
        >×</button>
      </div>
    );
  }

  if (active.length === 0) return null;
  const current = active[0];
  const dismiss = () => dismissId(current.id);

  return (
    // Terminal system-message line: left-aligned, prompt-prefixed, quiet.
    <div className="bg-surface border-b border-border px-3 md:px-4 py-1.5 flex items-center gap-2 text-[10.5px] relative">
      <span className="text-primary font-bold shrink-0 select-none">&gt;&gt;</span>
      {current.lead && (
        <span className="text-primary-bright font-bold uppercase tracking-[0.08em] text-[10px] shrink-0">{current.lead}</span>
      )}
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
