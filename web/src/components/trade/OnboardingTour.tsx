'use client';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Three-step, skippable first-visit tour of the trade terminal. Anchored to
 * real regions of the page (market bar, order form, book/positions) via
 * data-tour attributes. Persisted; never shows again once finished.
 */
const STEPS = [
  {
    anchor: '[data-tour="market-bar"]',
    title: 'Pick your market',
    body: 'Mark, oracle, funding, open interest and long/short sentiment live here. Click any market to switch.',
  },
  {
    anchor: '[data-trade-form]',
    title: 'Place wallet-signed orders',
    body: 'Every order is a signed transaction to the on-chain order book — fills land in about 2 seconds. Set a bracket right after.',
  },
  {
    anchor: '[data-tour="positions"]',
    title: 'Track positions & brackets',
    body: 'Positions, open orders, fills and your TP/SL brackets live in this panel. Hover the book for instant fill pricing.',
  },
];

export default function OnboardingTour() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem('mersennet-trade_tour_done') === '1') return;
      if (localStorage.getItem('mersennet-trade_welcome_acknowledged_v1')) {
        // Show after the legal gate has been acknowledged, on the trade page.
        const t = setTimeout(() => setVisible(true), 1200);
        return () => clearTimeout(t);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const measure = () => {
      const el = document.querySelector(STEPS[step].anchor);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [visible, step]);

  if (!visible) return null;

  const finish = () => {
    try { localStorage.setItem('mersennet-trade_tour_done', '1'); } catch { /* ignore */ }
    setVisible(false);
  };

  const s = STEPS[step];

  return (
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={finish} />
      {rect && (
        <div
          className="absolute border-2 border-primary/60 rounded-xl pointer-events-none transition-all duration-300"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Tour step ${step + 1} of ${STEPS.length}: ${s.title}`}
        className={cn(
          'absolute w-72 bg-surface border border-border rounded-xl shadow-2xl p-4',
          !rect && 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
        )}
        style={rect ? {
          top: Math.min(window.innerHeight - 190, rect.bottom + 14),
          left: Math.max(12, Math.min(window.innerWidth - 300, rect.left)),
        } : undefined}
      >
        <div className="flex items-center justify-between mb-2">
          <p className="text-[13px] font-semibold text-foreground">{s.title}</p>
          <span className="text-[10px] text-dim font-mono">{step + 1}/{STEPS.length}</span>
        </div>
        <p className="text-[11.5px] text-dim leading-relaxed mb-3">{s.body}</p>
        <div className="flex items-center justify-between">
          <button onClick={finish} className="text-[11px] text-dim hover:text-foreground transition-colors">Skip tour</button>
          <button
            onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))}
            className="px-3.5 py-1.5 bg-primary text-black rounded-md text-[11.5px] font-semibold hover:brightness-110 transition-all"
          >{step === STEPS.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
