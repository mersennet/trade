'use client';
import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app-error]', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-[40px] leading-none">⚠️</p>
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="text-sm text-dim max-w-md">
        An unexpected error occurred rendering this page. Your funds and open
        orders are unaffected — this is a display issue only.
      </p>
      {error.digest && (
        <p className="text-[10px] font-mono text-dim">Error ID: {error.digest}</p>
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={reset}
          className="px-5 py-2 premium-gradient text-black rounded-lg text-xs font-semibold hover:brightness-110 transition-all"
        >Try again</button>
        <a
          href="/feedback"
          className="px-5 py-2 bg-surface-2 border border-border rounded-lg text-xs font-medium text-dim hover:text-foreground transition-colors"
        >Report the issue</a>
      </div>
    </div>
  );
}
