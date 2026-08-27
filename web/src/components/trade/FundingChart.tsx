'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '@/stores/useStore';
import { api, FundingRate } from '@/lib/api';
import { cn } from '@/lib/utils';

const FUNDING_INTERVAL_MS = 8 * 3600 * 1000;

function getNextFundingTime(): number {
  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const ms = now - dayStart.getTime();
  const intervals = Math.ceil(ms / FUNDING_INTERVAL_MS);
  return dayStart.getTime() + intervals * FUNDING_INTERVAL_MS;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function FundingChart() {
  const { market, theme } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const [rates, setRates] = useState<FundingRate[]>([]);
  const [currentRate, setCurrentRate] = useState<number>(0);
  const [countdown, setCountdown] = useState('');
  const [loading, setLoading] = useState(true);
  const isDark = theme === 'dark';

  useEffect(() => {
    const tick = () => {
      const remaining = getNextFundingTime() - Date.now();
      setCountdown(formatCountdown(remaining));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setLoading(true);
    async function fetchRates() {
      try {
        const { rates: data } = await api.getFundingHistory(market.id);
        const sorted = [...data].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        setRates(sorted);
        // Either real rates or the API's flat-baseline series — both reflect
        // the actual current funding rate, no random noise injected here.
        setCurrentRate(sorted.length > 0 ? sorted[sorted.length - 1].rate : (market.fundingRate ?? 0));
      } catch {
        setCurrentRate(market.fundingRate ?? 0);
        setRates([]);
      } finally {
        setLoading(false);
      }
    }
    fetchRates();
  }, [market.id, market.fundingRate]);

  const buildChart = useCallback(async () => {
    if (!containerRef.current || rates.length === 0) return;

    if (chartRef.current) {
      try { chartRef.current.remove(); } catch { /* ok */ }
      chartRef.current = null;
    }

    const lc = await import('lightweight-charts');
    if (!containerRef.current) return;

    const chart = lc.createChart(containerRef.current, {
      layout: {
        background: { type: lc.ColorType.Solid, color: isDark ? '#070b08' : '#ffffff' },
        textColor: isDark ? '#6e6b7b' : '#71717a',
        fontFamily: 'Schibsted Grotesk, sans-serif',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)' },
        horzLines: { color: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: isDark ? 'rgba(43,217,106,0.3)' : 'rgba(15,174,98,0.3)', style: 2 },
        horzLine: { color: isDark ? 'rgba(43,217,106,0.3)' : 'rgba(15,174,98,0.3)', style: 2 },
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
      },
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
        timeVisible: true,
      },
    } as any);

    chartRef.current = chart;

    const histogramSeries = chart.addSeries(lc.HistogramSeries, {
      priceFormat: {
        type: 'custom',
        formatter: (val: number) => (val * 100).toFixed(4) + '%',
      },
    });

    const chartData = rates.map((r) => ({
      time: Math.floor(new Date(r.timestamp).getTime() / 1000) as any,
      value: r.rate,
      color: r.rate >= 0
        ? (isDark ? 'rgba(52,211,153,0.7)' : 'rgba(22,163,74,0.7)')
        : (isDark ? 'rgba(248,113,113,0.7)' : 'rgba(220,38,38,0.7)'),
    }));

    histogramSeries.setData(chartData);

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, [rates, isDark]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    buildChart().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [buildChart]);

  const rateColor = currentRate >= 0 ? 'text-green' : 'text-red';
  const ratePct = (currentRate * 100).toFixed(4);
  const annualized = (currentRate * 3 * 365 * 100).toFixed(2);

  // Header is intentionally minimal — main funding rate + countdown live in the
  // top MarketBar now to avoid duplication. Here we keep only the historical
  // 30-period histogram + an annualized footnote.
  return (
    <div className="bg-surface overflow-hidden flex flex-col h-full">
      <div className="flex items-center justify-between px-3 h-7 border-b border-border/60 shrink-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-dim">Funding history</span>
          <span className="text-[10px] text-dim font-mono">{market.symbol}</span>
        </div>
        <div className="flex items-baseline gap-3 text-[10px] font-mono tabular-nums">
          <span className="text-dim">Current</span>
          <span className={cn('font-semibold', rateColor)}>
            {currentRate >= 0 ? '+' : ''}{ratePct}%
          </span>
          <span className="text-dim">Ann.</span>
          <span className={rateColor}>
            {currentRate >= 0 ? '+' : ''}{annualized}%
          </span>
          <span className="text-dim hidden lg:inline">Next</span>
          <span className="text-yellow hidden lg:inline">{countdown}</span>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/50 backdrop-blur-[1px] pointer-events-none">
            <div className="flex items-center gap-1.5 text-[10px] text-dim">
              <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span>Loading funding…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
