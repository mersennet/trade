'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

const STORAGE_KEY = 'mersennet-trade_welcome_acknowledged_v1';

export default function WelcomeModal() {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const seen = localStorage.getItem(STORAGE_KEY);
    if (!seen) {
      // Defer to next tick so we don't flash on initial paint
      const t = setTimeout(() => setOpen(true), 250);
      return () => clearTimeout(t);
    }
  }, []);

  // Move focus into the dialog on open and trap Tab so keyboard users cannot
  // reach the app behind the legal gate; restore focus to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const getFocusable = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => el.offsetParent !== null);
    getFocusable()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const accept = () => {
    if (!acknowledged) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now() }));
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="p-6 sm:p-7">
          {/* Brand header */}
          <div className="flex items-center gap-3 mb-4">
            <Image src="/logo.png" alt="Mersennet Trade" width={40} height={40} className="shrink-0" priority />
            <div>
              <h2 id="welcome-title" className="text-[17px] font-semibold text-foreground tracking-tight leading-snug">
                Welcome to Mersennet Trade
              </h2>
              <p className="text-[11px] text-dim mt-1 flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-yellow/20 bg-yellow/10 text-yellow text-[9px] font-mono font-semibold uppercase tracking-widest">
                  Public Beta
                </span>
                <span className="font-mono uppercase tracking-wider text-[10px]">Mersennet · Chain 131071</span>
              </p>
            </div>
          </div>

          {/* Intro */}
          <p className="text-[13px] text-foreground/85 mb-4 leading-relaxed">
            Mersennet Trade is an on-chain perpetuals exchange in <strong className="text-yellow">public beta</strong> on the Mersennet testnet, powered by the chain&apos;s native order-book engine.
          </p>

          {/* Bullet list */}
          <ul className="space-y-2.5 mb-5 text-[13px] text-foreground/80">
            <Bullet tone="green">
              Trade with native <strong className="text-foreground">MRSN</strong> collateral.{' '}
              <Link href="/faucet" className="underline text-primary hover:text-primary-hover">Claim free testnet MRSN</Link>{' '}
              from the Mersennet Faucet to get started.
            </Bullet>
            <Bullet tone="green">
              Matching and settlement happen atomically on-chain in the Mersennet order-book engine, with no off-chain sequencer.
            </Bullet>
            <Bullet tone="yellow">
              Use only what you can afford to lose. Markets are sparse, so expect wide spreads.
            </Bullet>
            <Bullet tone="yellow">
              Report bugs through the <Link href="/feedback" className="underline text-primary hover:text-primary-hover">feedback form</Link>.
            </Bullet>
          </ul>

          {/* Acknowledgement */}
          <label
            className={`flex items-start gap-2.5 mb-4 p-2.5 -mx-2.5 rounded-lg select-none cursor-pointer border transition-colors ${
              acknowledged ? 'border-primary/25 bg-primary/[0.04]' : 'border-border hover:border-primary/20'
            }`}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary cursor-pointer shrink-0"
            />
            <span className="text-[12.5px] text-foreground/85 leading-relaxed">
              I understand this is a beta release and I have read the{' '}
              <Link href="/risk" className="underline text-primary hover:text-primary-hover" target="_blank">Risk Disclosure</Link>{' '}
              and{' '}
              <Link href="/terms" className="underline text-primary hover:text-primary-hover" target="_blank">Terms of Use</Link>.
            </span>
          </label>

          <button
            onClick={accept}
            disabled={!acknowledged}
            className={`w-full py-2.5 rounded-md text-[13px] font-semibold tracking-wide transition ${
              acknowledged
                ? 'premium-gradient text-black hover:brightness-110 shadow-[0_0_20px_rgba(125,255,155,0.25)]'
                : 'bg-surface-2 text-dim border border-border cursor-not-allowed'
            }`}
          >
            {acknowledged ? 'Enter beta' : 'Acknowledge the terms to continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bullet({ tone, children }: { tone: 'green' | 'yellow'; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className={tone === 'green' ? 'text-green mt-0.5 leading-tight' : 'text-yellow mt-0.5 leading-tight'} aria-hidden>●</span>
      <span>{children}</span>
    </li>
  );
}
