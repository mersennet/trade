'use client';
import { useEffect, useRef, useState } from 'react';
import { api, type Candle } from '@/lib/api';

/** Tiny sparkline chart for a market's recent 1h candles (markets grid view). */
export default function MiniChart({ marketId, height = 64 }: { marketId: number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    let chart: { remove: () => void } | null = null;
    (async () => {
      try {
        const { candles } = await api.getCandles(marketId, '1h');
        if (disposed || !ref.current || !candles || candles.length < 2) return;
        const { createChart, LineSeries } = await import('lightweight-charts');
        const data = candles.slice(-48).map((c) => ({
          time: Math.floor(Number(c.time) / (Number(c.time) > 1e12 ? 1000 : 1)),
          value: Number(c.close),
        })).filter((d) => d.time && d.value > 0);
        if (data.length < 2) return;
        const rising = data[data.length - 1].value >= data[0].value;
        setUp(rising);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = createChart(ref.current, {
          width: ref.current.clientWidth,
          height,
          layout: { background: { color: 'transparent' }, textColor: 'transparent' },
          grid: { vertLines: { visible: false }, horzLines: { visible: false } },
          rightPriceScale: { visible: false },
          timeScale: { visible: false },
          crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        });
        chart = c;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const series = (c as any).addSeries(LineSeries, {
          color: rising ? '#34d399' : '#f87171',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        series.setData(data as any);
        (c as { timeScale: () => { fitContent: () => void } }).timeScale().fitContent();
      } catch { /* sparkline is decorative */ }
    })();
    return () => { disposed = true; chart?.remove(); };
  }, [marketId, height]);

  return (
    <div
      ref={ref}
      style={{ height }}
      className={up === null ? 'skeleton rounded-md' : ''}
      aria-hidden="true"
    />
  );
}
