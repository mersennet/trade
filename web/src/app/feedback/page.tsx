'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useToast } from '@/components/shared/Toast';
import { useWallet } from '@/hooks/useWallet';
import { cn } from '@/lib/utils';

const CATEGORIES = [
  { id: 'bug',      label: 'Bug report',     hint: 'What broke? Steps to reproduce. Browser/wallet you used.' },
  { id: 'feature',  label: 'Feature request',hint: 'What would you like to see added or improved?' },
  { id: 'security', label: 'Security',       hint: 'For confidential security reports, email security@mersennet.com instead.' },
  { id: 'other',    label: 'Other',          hint: 'Anything else.' },
];

export default function FeedbackPage() {
  const toast = useToast();
  const { address } = useWallet();
  const [category, setCategory] = useState('bug');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    try {
      const apiUrl = (process.env.NEXT_PUBLIC_API_URL || 'https://trade.mersennet.com/api/v1').replace(/\/$/, '');
      const res = await fetch(`${apiUrl}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          message,
          contact,
          wallet: address,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          page: typeof window !== 'undefined' ? window.location.href : '',
          submittedAt: new Date().toISOString(),
        }),
      });
      if (!res.ok && res.status !== 404) {
        const txt = await res.text().catch(() => '');
        throw new Error(`API ${res.status}: ${txt.slice(0, 100)}`);
      }
      if (res.status === 404) {
        toast.toast('Email fallback: opening mail client…', 'info');
        const subject = encodeURIComponent(`[${category}] Mersennet Trade feedback`);
        const body = encodeURIComponent(
          `Wallet: ${address || 'not connected'}\nCategory: ${category}\n\n${message}\n\nContact: ${contact}`
        );
        window.location.href = `mailto:hello@trade.mersennet.com?subject=${subject}&body=${body}`;
      } else {
        toast.toast('Thanks! Your feedback was received.', 'success');
        setMessage('');
        setContact('');
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'Submission failed';
      toast.toast(`Submission failed: ${msg}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const cat = CATEGORIES.find((c) => c.id === category)!;

  return (
    <div className="page-shell">
      <div className="max-w-2xl space-y-5">
      {/* Header */}
      <header>
        <h1 className="page-title">Beta feedback</h1>
        <p className="page-sub">
          Found a bug? Want a feature? Confused by something? Tell us. Beta testers shape the product.
        </p>
      </header>

      <form onSubmit={submit} className="rounded-xl border border-border bg-surface p-4 md:p-5 space-y-4">
        {/* Category — segmented control */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-dim mb-2 font-semibold">
            Category
          </label>
          <div className="flex items-center gap-px bg-background rounded-md border border-border overflow-hidden">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={cn(
                  'flex-1 px-3 py-2 text-[12px] font-medium transition-colors',
                  category === c.id
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'bg-surface-2 text-dim hover:text-foreground'
                )}
              >{c.label}</button>
            ))}
          </div>
        </div>

        {category === 'security' && (
          <div className="p-3 rounded-md border border-red/30 bg-red/5 text-foreground text-[12.5px] leading-relaxed">
            <strong className="text-red">Security disclosures must be confidential.</strong>{' '}
            Email{' '}
            <a href="mailto:security@mersennet.com" className="underline">security@mersennet.com</a>{' '}
            directly. <strong>Do not</strong> describe live vulnerabilities in this public form.
          </div>
        )}

        {/* Message */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-dim mb-2 font-semibold">
            Your message
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={cat.hint}
            rows={6}
            className="w-full px-3 py-2.5 rounded-md bg-surface-2 border border-border text-[13px] text-foreground placeholder:text-dim focus:outline-none focus:border-primary/40 resize-vertical transition-colors"
            required
          />
          <div className="mt-1 flex items-center justify-between text-[10.5px] text-dim">
            <span>Be specific; screenshots help. Paste image URLs or include them in your contact.</span>
            <span className="font-mono tabular-nums">{message.length}</span>
          </div>
        </div>

        {/* Contact */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-dim mb-2 font-semibold">
            Contact <span className="font-normal normal-case tracking-normal text-dim">(optional)</span>
          </label>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="Discord handle, Telegram, email (so we can reply)"
            className="w-full px-3 py-2.5 rounded-md bg-surface-2 border border-border text-[13px] text-foreground placeholder:text-dim focus:outline-none focus:border-primary/40 transition-colors"
          />
        </div>

        {/* Footer row */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
          <span className="text-[11px] text-dim">
            Wallet:{' '}
            {address ? (
              <span className="font-mono text-foreground/80">
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>
            ) : (
              <span className="text-dim">not connected</span>
            )}
          </span>
          <button
            type="submit"
            disabled={submitting || !message.trim()}
            className="px-5 py-2 rounded-md premium-gradient text-white text-[12.5px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
          >
            {submitting ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </form>

      {/* Community shortcuts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <a
          href="https://discord.gg/mersennet"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl border border-border bg-surface p-4 hover:border-primary/30 hover:bg-surface-2/30 transition-colors"
        >
          <div className="text-[13px] font-semibold text-foreground">Discord</div>
          <div className="text-[11.5px] text-dim mt-0.5">Live chat with the team and other testers.</div>
        </a>
        <a
          href="https://t.me/mersennet"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xl border border-border bg-surface p-4 hover:border-primary/30 hover:bg-surface-2/30 transition-colors"
        >
          <div className="text-[13px] font-semibold text-foreground">Telegram</div>
          <div className="text-[11.5px] text-dim mt-0.5">Updates and quick questions.</div>
        </a>
      </div>

      <p className="text-center text-[11px] text-dim">
        Looking for our terms? <Link href="/terms" className="underline hover:text-foreground transition-colors">Terms</Link> ·{' '}
        <Link href="/privacy" className="underline hover:text-foreground transition-colors">Privacy</Link> ·{' '}
        <Link href="/risk" className="underline hover:text-foreground transition-colors">Risk</Link>
      </p>
      </div>
    </div>
  );
}
