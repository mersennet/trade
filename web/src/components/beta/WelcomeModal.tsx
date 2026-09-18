'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

const STORAGE_KEY = 'mersennet-trade_welcome_acknowledged_v2';

export default function WelcomeModal() {
  const [open, setOpen] = useState(false);
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
      <div className="w-full max-w-lg border border-border bg-surface shadow-[0_0_60px_rgba(0,0,0,0.7),0_0_30px_rgba(43,217,106,0.07)]">
        <div className="sect">Welcome · Public testnet</div>
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
                  Public testnet
                </span>
                <span className="font-mono uppercase tracking-wider text-[10px]">Mersennet · Chain 131071</span>
              </p>
            </div>
          </div>

          {/* Intro */}
          <p className="text-[13px] text-foreground/85 mb-4 leading-relaxed">
            Mersennet Trade is an on-chain perpetuals exchange on the Mersennet <strong className="text-yellow">public testnet</strong>: every order is a transaction matched by the chain&apos;s native order book. Tokens here have no value.
          </p>

          {/* Bullet list */}
          <ul className="space-y-2.5 mb-5 text-[13px] text-foreground/80">
            <Bullet tone="green">
              Connect a wallet,{' '}
              <Link href="/faucet" className="underline text-primary hover:text-primary-hover">claim 1,001 free MRSN</Link>, deposit it as collateral and place a first order — the checklist on the trade page walks you through it.
            </Bullet>
            <Bullet tone="green">
              Prices are quoted in USD; balances, margin and PnL are in MRSN. On the testnet one MRSN of collateral counts as one dollar of margin.
            </Bullet>
            <Bullet tone="green">
              Earn <Link href="/points" className="underline text-primary hover:text-primary-hover">points</Link> by trading, running a node or pooling MRSN in the maker vault — and with 1,000 MRSN you can{' '}
              <Link href="/staking" className="underline text-primary hover:text-primary-hover">register as a validator</Link>.
            </Bullet>
            <Bullet tone="yellow">
              Two protocol switches land this weekend (Sat 19 and Sun 20 Sep); the announcement bar and the staking page show the live schedule.
            </Bullet>
            <Bullet tone="yellow">
              Something off? Use the <Link href="/feedback" className="underline text-primary hover:text-primary-hover">feedback form</Link> or the Telegram chat.
            </Bullet>
          </ul>

          <button
            onClick={accept}
            className="w-full py-2.5 text-[11px] font-extrabold uppercase tracking-[0.18em] transition premium-gradient shadow-[0_0_20px_rgba(43,217,106,0.25)]"
          >
            Enter the terminal
          </button>
          <p className="mt-3 text-[11px] text-dim leading-relaxed text-center">
            By continuing you accept the{' '}
            <Link href="/risk" className="underline hover:text-foreground" target="_blank">risk disclosure</Link>{' '}
            and{' '}
            <Link href="/terms" className="underline hover:text-foreground" target="_blank">terms of use</Link>.
          </p>
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
