'use client';
import { useEffect, useRef } from 'react';

/** Compact equity/PnL line chart (lightweight-charts), green when the final
 * value is up, red when down. Shared by Analytics and Portfolio. */
export default function EquityCurve({ data, height = 180 }: { data: { time: number; value: number }[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<unknown>(null);

  useEffect(() => {
    // One chart per effect run. The async import can resolve after the
    // effect was cleaned up (route change, data change), so every step after
    // an await checks `disposed`; the cleanup removes exactly the chart this
    // run created, disconnects its ResizeObserver first, and tolerates a
    // chart that lightweight-charts already tore down ("Object is disposed").
    if (!containerRef.current || data.length < 2) return;
    let disposed = false;
    let chart: { remove: () => void; applyOptions: (o: unknown) => void } | null = null;
    let ro: ResizeObserver | null = null;
    (async () => {
      const { createChart, LineSeries } = await import('lightweight-charts');
      if (disposed || !containerRef.current) return;
      const c = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height,
        layout: {
          background: { color: 'transparent' },
          textColor: 'rgba(255,255,255,0.4)',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(255,255,255,0.03)' },
          horzLines: { color: 'rgba(255,255,255,0.03)' },
        },
        crosshair: {
          vertLine: { color: 'rgba(43,217,106,0.25)', labelBackgroundColor: '#101511' },
          horzLine: { color: 'rgba(43,217,106,0.25)', labelBackgroundColor: '#101511' },
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)' },
      });
      chart = c as unknown as typeof chart;
      chartRef.current = c;

      const series = c.addSeries(LineSeries, {
        color: data[data.length - 1].value >= 0 ? '#2bd96a' : '#ef4444',
        lineWidth: 2,
        crosshairMarkerRadius: 4,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });

      const deduped = data.reduce<{ time: number; value: number }[]>((acc, d) => {
        if (acc.length === 0 || acc[acc.length - 1].time !== d.time) acc.push(d);
        else acc[acc.length - 1] = d;
        return acc;
      }, []);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      series.setData(deduped as any);
      c.timeScale().fitContent();

      ro = new ResizeObserver(() => {
        if (disposed || !containerRef.current) return;
        try { c.applyOptions({ width: containerRef.current.clientWidth }); } catch { /* chart already removed */ }
      });
      ro.observe(containerRef.current);
    })().catch(() => { /* chart is decorative; the page stays usable without it */ });

    return () => {
      disposed = true;
      ro?.disconnect();
      try { chart?.remove(); } catch { /* already disposed */ }
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [data, height]);

  if (data.length < 2) {
    return (
      <div className="flex items-center justify-center text-dim text-xs" style={{ height }}>
        Not enough trades for a curve yet
      </div>
    );
  }

  return <div ref={containerRef} className="w-full" />;
}
