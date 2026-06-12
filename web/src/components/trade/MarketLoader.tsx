'use client';
import { useEffect, useState } from 'react';
import { useStore } from '@/stores/useStore';

/**
 * Thin animated progress bar that pulses across the top of the trade page
 * whenever the active market changes. Pure visual feedback so users feel
 * the click immediately, even before downstream fetches complete.
 *
 * Lifecycle on each market change:
 *  1. Reset to 0, mount the bar.
 *  2. Snap to 30% on the next animation frame so the eased CSS transition
 *     visibly starts moving.
 *  3. Crawl to ~80% over ~250ms (suggests "still working").
 *  4. Snap to 100% after another ~250ms then fade out.
 */
export default function MarketLoader() {
  const marketId = useStore((s) => s.market.id);
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
    setProgress(0);

    const t1 = requestAnimationFrame(() => setProgress(30));
    const t2 = setTimeout(() => setProgress(80), 250);
    const t3 = setTimeout(() => setProgress(100), 500);
    const t4 = setTimeout(() => setVisible(false), 750);

    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [marketId]);

  return (
    <div
      aria-hidden
      className="absolute top-0 left-0 right-0 h-px z-50 pointer-events-none overflow-hidden"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 200ms ease-out' }}
    >
      <div
        className="h-full bg-primary"
        style={{
          width: `${progress}%`,
          transition: 'width 250ms cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 0 6px rgba(125,255,155,0.6)',
        }}
      />
    </div>
  );
}
