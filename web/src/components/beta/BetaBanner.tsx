'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

const STORAGE_KEY = 'mersennet-trade_beta_banner_dismissed_v1';

export default function BetaBanner() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div className="relative w-full bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15 border-b border-amber-500/30 px-4 py-2 text-xs sm:text-sm">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 font-semibold uppercase tracking-wider text-[10px]">
            Beta
          </span>
          <span className="text-amber-100/90 truncate">
            Public beta on Mersennet. Trade with caution; bugs may exist.
          </span>
          <Link
            href="/risk"
            className="text-amber-100 underline underline-offset-2 hover:text-white whitespace-nowrap hidden sm:inline"
          >
            Risk disclosure
          </Link>
          <span className="text-amber-100/40 hidden md:inline">·</span>
          <Link
            href="/faucet"
            className="text-amber-100 underline underline-offset-2 hover:text-white whitespace-nowrap hidden md:inline"
          >
            Get testnet MRSN
          </Link>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss beta banner"
          className="shrink-0 p-1 rounded hover:bg-white/10 text-amber-100/70 hover:text-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
